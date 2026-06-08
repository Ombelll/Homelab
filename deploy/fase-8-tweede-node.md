# Fase 8 — tweede node (Proxmox-02): off-box backups, monitoring, DNS-redundantie, cluster

A second Fujitsu Q958 (`Proxmox-02`, i5-8400T, 16 GB, `192.168.1.11`) joins the
homelab. Disk layout mirrors node 1: **Samsung 500 GB M.2 = boot/PVE**, **Verbatim
Vi550 500 GB SATA = data** (here: the PBS datastore).

Goal, in order of value: ① off-box backups (PBS) → ② monitoring (agent) →
③ DNS redundancy (2nd AdGuard) → ④ cluster + HA prep.

## 0. Post-install (DONE / verify)
- [x] Hostname `Proxmox-02.home`, IP `192.168.1.11`, DNS `9.9.9.9`+`1.1.1.1`.
- [x] Enterprise repos disabled, `pve-no-subscription` added, `apt update` clean.
- [x] `apt full-upgrade` + reboot (now PVE 8.4.19, kernel 6.8.12-29).
- [ ] USB install stick (sdb) removed.

## STATUS (2026-06-08)
- [x] **PBS live** — pool `bkp` on the Verbatim SSD, datastore `main`, storage `pbs`
      added on node 1 (active), daily job 02:30, test backup of CT100 OK.
- [x] **Agent on Proxmox-02** — running, reporting to dashboard as `Proxmox-02` (online).
- [x] **Cluster `homelab` live** — 2 nodes, Quorate (Proxmox-01 + Proxmox-02), manage
      both from one UI. ⚠️ Joining needs node 2 GUEST-FREE (had to destroy CT 110 first)
      and the node-1 root password at the `pvecm add` prompt.
- [~] **2nd AdGuard** — CT 110 (adguard2, 192.168.1.22) recreated after the join +
      AdGuard Home installed & running. Remaining (your side): wizard + match node-1
      config + DHCP dual-DNS.
- [ ] **QDevice** — still needed: with 2 votes, if one node dies the survivor loses
      quorum and /etc/pve goes read-only. Add a 3rd vote on an always-on box
      (GL.iNet router / Pi): `apt install corosync-qnetd` there, `corosync-qdevice`
      on both nodes, then `pvecm qdevice setup <ip>`.

---

## 1. PBS — off-box backups on the Verbatim SSD

Run Proxmox Backup Server **co-installed on the PVE node** (fine for a homelab).

```sh
# On Proxmox-02. PBS is NOT in the PVE repo — add the PBS no-subscription repo:
echo "deb http://download.proxmox.com/debian/pbs bookworm pbs-no-subscription" \
  > /etc/apt/sources.list.d/pbs-no-subscription.list
apt update
apt install -y proxmox-backup-server          # PBS UI then on https://192.168.1.11:8007
# Installing PBS adds an ENTERPRISE repo (pbs-enterprise.list) that 401s without
# a subscription and breaks future `apt update`/`apt install`. Disable it:
sed -i 's|^deb|#deb|' /etc/apt/sources.list.d/pbs-enterprise.list

# ZFS pool on the empty Verbatim SSD (integrity + compression). Verify the disk
# first — it must be the 500 GB Verbatim, NOT the NVMe boot disk!
lsblk -o NAME,SIZE,MODEL                       # confirm sda = Verbatim Vi550
ls -l /dev/disk/by-id/ | grep -w sda           # grab the ata-Verbatim... by-id
wipefs -a /dev/sda; sgdisk --zap-all /dev/sda
zpool create -f -o ashift=12 -o autotrim=on -O compression=zstd bkp /dev/disk/by-id/ata-Verbatim_<id>

# Datastore for backups.
mkdir -p /bkp/datastore
proxmox-backup-manager datastore create main /bkp/datastore

# Show the fingerprint — needed when adding PBS as storage on node 1.
proxmox-backup-manager cert info | grep -i fingerprint
```

Create a PBS user + API token for node 1. ⚠️ **Token privilege-separation
gotcha:** a token's effective rights are the *intersection* of the user's and
the token's ACLs — so grant the role to **both** the user AND the token, or
node 1 gets "Cannot find datastore 'main'".
```sh
proxmox-backup-manager user create backup@pbs --password "$(openssl rand -base64 24)"
# Token secret prints once / capture it; here we write it to a root-only file:
proxmox-backup-manager user generate-token backup@pbs node1 > /root/pbs-node1-token.json
proxmox-backup-manager acl update /datastore/main DatastoreAdmin --auth-id 'backup@pbs'
proxmox-backup-manager acl update /datastore/main DatastoreAdmin --auth-id 'backup@pbs!node1'
proxmox-backup-manager cert info | grep -i fingerprint   # note the SHA-256 fp
```

### Wire it into node 1 (CLI)
On **Proxmox-01** — token value from the file, fingerprint from above:
```sh
pvesm add pbs pbs --server 192.168.1.11 --datastore main \
  --username 'backup@pbs!node1' --password '<TOKEN-VALUE>' \
  --fingerprint '<SHA256-FP>' --content backup
pvesm status        # pbs should show "active"
# (shred the token file on node 2 afterwards: shred -u /root/pbs-node1-token.json)
```

Then schedule a daily job (keeps the existing local tank-backup job too —
belt and suspenders):
```sh
pvesh create /cluster/backup --schedule "02:30" --storage pbs --vmid 100,101 \
  --mode snapshot --notes-template "{{guestname}}" \
  --prune-backups "keep-daily=7,keep-weekly=4,keep-monthly=6" \
  --comment "Off-box naar PBS node2"
```
This is the real win: backups now live on a **different machine**, not on
node 1's tank. Verified working 2026-06-08 (CT100: 1.46 GiB → 572 MiB in 13 s).

> Optional: also keep the local nightly vzdump to `tank-backup` for fast local
> restores — belt and suspenders.

---

## 2. Monitoring agent on Proxmox-02 (shows up in the dashboard)

The agent key = the dashboard's `AGENT_API_KEY` (same value node 1 uses; it's
in node 1's `/etc/homelab-agent.env`). ⚠️ It's a 62-char hex string — verify you
copied it exactly (a length/char mismatch → silent **401 unauthorized**). Sanity
check: `grep -oP '(?<=AGENT_API_KEY=).*' /etc/homelab-agent.env | tr -d '\n' | sha256sum`
must match on both nodes.

Node 2 is NOT on the tailnet, so use the dashboard's **LAN** URL (CT101):
```sh
# On Proxmox-02 — the script installs Node, clones to /opt/homelab-agent,
# builds, writes /etc/homelab-agent.env (0600), and enables the systemd service.
curl -fsSL https://raw.githubusercontent.com/Ombelll/Homelab/main/deploy/install-agent.sh -o /tmp/ia.sh
DASHBOARD_URL=http://192.168.1.21:3000 \
  AGENT_API_KEY='<62-hex from node 1>' \
  AGENT_SERVER_NAME=Proxmox-02 \
  bash /tmp/ia.sh
journalctl -u homelab-agent -n 10 --no-pager   # expect "starting — host=Proxmox-02", no 401
```
Within a tick `Proxmox-02` appears on the dashboard with its own metrics, ZFS
pool (`bkp`), SMART, sensors, power. (The dashboard itself stays on CT101 / node 1.)

> The agent warns that `http://192.168.1.21:3000` is plaintext — the key crosses
> the LAN in the clear. Low risk on a home LAN; to harden, put node 2 on the
> tailnet (`tailscale up`) and switch DASHBOARD_URL to the HTTPS tailnet name.

---

## 3. Second AdGuard — network-wide DNS redundancy

Run a 2nd AdGuard **independent of node 1** so DNS survives either node dying.
Simplest: a small LXC on Proxmox-02 running AdGuard Home.

```sh
# On Proxmox-02 — Debian LXC (CT 110, 192.168.1.22), then install AdGuard in it:
pveam update; pveam download local debian-12-standard_12.12-1_amd64.tar.zst
pct create 110 local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst \
  --hostname adguard2 --cores 1 --memory 512 --swap 256 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.22/24,gw=192.168.1.1 \
  --nameserver 9.9.9.9 --rootfs local-lvm:4 --unprivileged 1 \
  --features nesting=1 --onboot 1 --start 1
pct exec 110 -- bash -c "apt-get update -qq; apt-get install -y -qq curl ca-certificates; \
  curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v"
# AdGuard then runs on http://192.168.1.22:3000 (setup wizard).
```
Finish (your side — involves a password + router):
1. Open `http://192.168.1.22:3000`, run the wizard (admin account; DNS :53, UI :80/:3000).
2. Match node 1: upstreams DoH to `9.9.9.9`/`1.1.1.1`, same blocklists, and the
   `*.lan` DNS rewrites → `192.168.1.21`. AdGuard has no native HA — copy node 1's
   `AdGuardHome.yaml` or replicate the rewrites by hand.
3. Hand out **both** AdGuard IPs via DHCP (primary `192.168.1.21`, secondary
   `192.168.1.22`). Now a node outage no longer takes DNS down.

---

## 4. Cluster + HA prep (do while node 2 is still empty)

`/etc/hosts` on **both** nodes (Proxmox resolves node names via hosts, not DNS):
```
192.168.1.10  Proxmox-01.home  Proxmox-01
192.168.1.11  Proxmox-02.home  Proxmox-02
```

```sh
# On Proxmox-01: create the cluster.
pvecm create homelab
# On Proxmox-02: join it (enter node-1 root pw when asked).
pvecm add 192.168.1.10
# Verify on either node:
pvecm status
```

⚠️ **2-node quorum:** with exactly two votes, if one node dies the survivor
loses quorum and freezes. Fix with a **QDevice** (third vote) on a small
always-on box (the GL.iNet router or a Pi):
```sh
# On the QDevice host: apt install corosync-qnetd
# On both nodes:        apt install corosync-qdevice
# On one node:          pvecm qdevice setup <qdevice-ip>
```

With a QDevice you can enable **HA** + **ZFS replication** (`pvesr`) of CT100/CT101
to node 2, so a node failure auto-restarts them on the survivor.

> Clustering is easiest BEFORE node 2 has its own guests with overlapping IDs.
> The AdGuard LXC (CT 110) is fine; just avoid reusing IDs 100/101.

---

## Notes
- PBS on the SATA SSD is single-disk (no redundancy) — but it's a *copy* of data
  that lives elsewhere, so that's acceptable; the point is off-box, not RAID.
- Power: for true resilience put node 2 on a separate UPS/circuit, else a power
  cut still takes both down together.
