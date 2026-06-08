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
- [ ] Agent on Proxmox-02 (step 2)
- [ ] 2nd AdGuard (step 3)
- [ ] Cluster + QDevice (step 4)

---

## 1. PBS — off-box backups on the Verbatim SSD

Run Proxmox Backup Server **co-installed on the PVE node** (fine for a homelab).

```sh
# On Proxmox-02. PBS is NOT in the PVE repo — add the PBS no-subscription repo:
echo "deb http://download.proxmox.com/debian/pbs bookworm pbs-no-subscription" \
  > /etc/apt/sources.list.d/pbs-no-subscription.list
apt update
apt install -y proxmox-backup-server          # PBS UI then on https://192.168.1.11:8007

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

```sh
# On Proxmox-02. Pull the repo (or scp the deploy/ dir over).
apt install -y git
git clone https://github.com/Ombelll/Homelab.git /opt/Homelab
cd /opt/Homelab
# Set the agent env: same AGENT_API_KEY as node 1, dashboard URL, node name.
cp .env.example .env && nano .env      # set AGENT_API_KEY, DASHBOARD_URL=http://192.168.1.21:3000, AGENT_SERVER_NAME=Proxmox-02
bash deploy/install-agent.sh
```
Within a tick `Proxmox-02` appears on the dashboard with its own metrics, ZFS
pool (`bkp`), SMART, sensors, power. (The dashboard itself stays on CT101 / node 1.)

---

## 3. Second AdGuard — network-wide DNS redundancy

Run a 2nd AdGuard **independent of node 1** so DNS survives either node dying.
Simplest: a small LXC on Proxmox-02 running AdGuard Home.

```sh
# On Proxmox-02: create a Debian LXC (e.g. CT 110, 192.168.1.22), then inside it:
#   curl -s -S -L https://raw.githubusercontent.com/AdguardTeam/AdGuardHome/master/scripts/install.sh | sh -s -- -v
# Configure it identically to the node-1 AdGuard (same rewrites + upstreams
# DoH/DoT to 9.9.9.9 / 1.1.1.1). AdGuard has no native HA, so either keep the
# two in sync by hand or use a sync tool.
```
Then hand out **both** AdGuard IPs via DHCP (primary `192.168.1.21`, secondary
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
