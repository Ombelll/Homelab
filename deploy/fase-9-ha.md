# Fase 9 — High Availability: QDevice, ZFS-replicatie, auto-failover

Goal: when one node dies, CT 100/101 **automatically restart on the surviving
node** from a recent replica. Prerequisites already in place: 2-node cluster
`homelab` (Quorate) + PBS off-box backups.

⚠️ This is the involved phase. Do it in order; each part is independently
useful. Until it's done, the **interim failover path is PBS**: if node 1 dies,
restore CT 100/101 from the `pbs` storage onto node 2 and start them there.

> **What HA gives on LXC:** restart-failover, not live migration. On a node
> failure the guest is **restarted** on the other node from its last replicated
> snapshot → expect a brief outage + up to *replication-interval* of data loss
> (set 15 min below, so ≤15 min). Seamless live failover needs VMs + shared
> storage; not the goal here.

---

## A. QDevice — the 3rd vote (do this first; needs the router/Pi)

Without it, a 2-node cluster that loses a node is **not quorate** → `/etc/pve`
goes read-only and HA can't act. A QDevice is a tiny tie-breaker daemon on an
always-on box (GL.iNet router, a Pi, anything Debian-ish on the LAN).

```sh
# On the QDevice host (e.g. 192.168.1.1 router or a Pi):
apt install -y corosync-qnetd

# On BOTH Proxmox nodes:
apt install -y corosync-qdevice

# On ONE node:
pvecm qdevice setup <qdevice-ip>     # enter the QDevice host's root pw when asked

# Verify — expected votes should now be 3, and survive one node down:
pvecm status        # look for "Qdevice" under Membership, Expected votes: 3
```
After this, one node can fail and the survivor (1 node + QDevice = 2/3) stays
**quorate** → HA can fail guests over.

---

## B. Matching ZFS storage for the guests (the crux)

`pvesr` replication needs the guest's disks on a ZFS storage that exists with the
**same storage ID + same pool name on BOTH nodes**. Today: node 1 = pool `tank`,
node 2 = pool `bkp` (PBS). They differ, and the guests are on **LVM-thin**
(`local-lvm`), not ZFS. So: unify the pool name, then move the guests onto it.

### B1. Rename node 2's pool `bkp` → `tank` (so both nodes have `tank`)
This touches PBS (its datastore lives on that pool), so do it in a quiet window.
```sh
# On Proxmox-02:
systemctl stop proxmox-backup proxmox-backup-proxy
zpool export bkp
zpool import bkp tank                       # rename on import
zfs set mountpoint=/tank tank               # was /bkp
# PBS datastore was /bkp/datastore -> now /tank/datastore. Update PBS:
proxmox-backup-manager datastore update main --path /tank/datastore || \
  echo "if update unsupported, remove+recreate the datastore pointing at /tank/datastore"
systemctl start proxmox-backup proxmox-backup-proxy
```
> Alternative if you'd rather not touch PBS: give each node a *separate* small
> ZFS pool with an identical name reserved for guests. With no spare disks here,
> the rename is the clean path.

### B2. Guest dataset + cluster ZFS storage (run once, on either node)
```sh
# Dataset for guest disks on each node's `tank`:
ssh proxmox-01 'zfs create tank/guests'      # cluster SSH trust exists post-join
ssh proxmox-02 'zfs create tank/guests'
# Define a cluster-wide zfspool storage backed by it:
pvesm add zfspool zfs-guests --pool tank/guests --content images,rootdir --sparse 1
```

### B3. Move CT 100/101 disks onto the ZFS storage (brief downtime per CT)
```sh
pct stop 100 && pct move-volume 100 rootfs zfs-guests && pct start 100
pct stop 101 && pct move-volume 101 rootfs zfs-guests && pct start 101
# (older PVE: `pct move_volume`. Check `pct help`.)
```

---

## C. Replication jobs → node 2

```sh
# Replicate each guest to Proxmox-02 every 15 minutes:
pvesr create-local-job 100-0 proxmox-02 --schedule "*/15"
pvesr create-local-job 101-0 proxmox-02 --schedule "*/15"
pvesr status        # watch first sync complete; then it's incremental + fast
```
Now node 2 holds a ≤15-min-old copy of both guests' ZFS datasets.

---

## D. HA resources + group

```sh
# Prefer node 1, fail over to node 2:
ha-manager groupadd pref-node1 --nodes "proxmox-01:2,proxmox-02:1" --nofailback 0
ha-manager add ct:100 --group pref-node1 --state started --max_relocate 1
ha-manager add ct:101 --group pref-node1 --state started --max_relocate 1
ha-manager status
```

---

## E. Failover test (with QDevice in place!)

```sh
# Simulate node-1 loss (e.g. `reboot` node 1, or pull its network briefly).
# On node 2 watch HA take over:
watch ha-manager status
# CT 100/101 should restart on Proxmox-02 within ~1-2 min, from the last replica.
# When node 1 returns, they fail back (nofailback=0) once it's healthy.
```

---

## Notes / caveats
- **Power is still a single point of failure.** Both mini-PCs on one outlet/UPS
  means a power cut takes both down together — HA can't help there. For true
  resilience put node 2 on a separate circuit/UPS.
- **Replication ≠ backup.** Keep PBS running; replication only protects against a
  node dying, not against deletion/corruption (which replicates too).
- **`tank` capacity:** node 1's `tank` now holds backups-data + guests; node 2's
  renamed `tank` holds the PBS datastore + the guest replicas. 64 GB of guests +
  replicas fits easily in 500 GB, but keep an eye via the dashboard.
- **Single NIC:** corosync shares the LAN link. Fine for a 2-node homelab; for
  more nodes you'd want a dedicated cluster network.
