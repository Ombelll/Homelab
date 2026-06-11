# Fase 9b — Full auto-failover design (incl. CT101's data)

Goal: a node-1 crash auto-restarts CT100 **and** CT101 (with its data) on node 2.
Builds on Fase 9 Part A (QDevice — DONE; cluster has 3 votes, quorate).

## The problem this solves
CT101's bulk data lives in **bind mounts on node-1's `tank`** (`mp0 /tank/immich`,
`mp1 /tank/media`, `mp2 /tank/nextcloud`). Bind mounts are NOT replicated by
`pvesr`, so a plain HA failover starts CT101 on node 2 *without its data* →
Immich/Jellyfin/Nextcloud/*arr break. For real failover those mounts must become
**Proxmox-managed ZFS volumes** that replicate with the guest.

## Why now
Snapshot of sizes (2026-06-11): immich 146M, media 184K, nextcloud 533M →
**< 1 GB total**. Migrating + replicating is trivial today. Once the media
library fills up this becomes a multi-hundred-GB job. **Do it while it's empty.**

## Capacity trade-off (accept this)
Replicated data lives on BOTH 500 GB SSDs. Effective ceiling for
immich+media+nextcloud ≈ **min(node1 free, node2 free) ≈ ~400 GB**, since every
GB is stored twice. Fine for now; watch it as the media library grows (dashboard
disk alerts cover it).

## Failover semantics
Restart-failover, not live. On a node-1 crash the guests **restart** on node 2
from their last replica → brief outage + up to *replication-interval* (15 min)
of data loss. Replication ≠ backup — keep PBS.

---

## Execution plan (ordered; each step verified before the next)

### 1. QDevice — DONE
CT 111 `qdevice` (192.168.1.30, Debian) runs corosync-qnetd; `pvecm status` =
Expected 3 / Quorate Qdevice.

### 2. Unify the pool name (node 2 `bkp` → `tank`) — ⚠️ touches PBS
Replication needs the same pool name on both nodes. Quiet window; PBS has the
only off-box copy but node-1 local `tank-backup` + offsite still exist as safety.
```sh
ssh proxmox-02 'systemctl stop proxmox-backup proxmox-backup-proxy
  zpool export bkp && zpool import bkp tank && zfs set mountpoint=/tank tank
  proxmox-backup-manager datastore update main --path /tank/datastore
  systemctl start proxmox-backup proxmox-backup-proxy
  proxmox-backup-manager datastore list'          # verify "main" healthy
```
Also fix the cluster storage pins afterward: the `pbs` storage path is unchanged
(it points at the datastore name, not the pool path). Verify a test backup +
that snapshots are still listed.

### 3. Cluster ZFS storage for guests (both nodes)
```sh
ssh proxmox-01 'zfs create tank/guests'
ssh proxmox-02 'zfs create tank/guests'
pvesm add zfspool zfs-guests --pool tank/guests --content images,rootdir --sparse 1
```

### 4. Move CT100 (clean — no data mounts)
```sh
pct stop 100 && pct move-volume 100 rootfs zfs-guests && pct start 100
```

### 5. CT101 — rootfs + convert the 3 bind mounts to managed ZFS volumes
The bind mounts must become storage-backed mountpoints so they replicate. Data
is tiny, so copy it across. Per mount (immich/media/nextcloud):
```sh
pct stop 101
pct move-volume 101 rootfs zfs-guests
# For each bind mount: add a managed volume, copy the data in, swap the mp.
# Example for immich (repeat for media, nextcloud):
pct set 101 -mp3 zfs-guests:8,mp=/mnt/immich-new          # size in GB, grow later
pct start 101 && pct exec 101 -- rsync -aHAX /mnt/immich/ /mnt/immich-new/ && pct stop 101
# then point mp0 at the new managed volume and drop the bind mount + tmp mp:
#   edit /etc/pve/lxc/101.conf: mp0 -> zfs-guests:subvol-101-disk-N,mp=/mnt/immich
pct start 101
```
> This is the fiddly part — managed mountpoints replicate; bind mounts don't.
> Validate each service (Immich/Jellyfin/Nextcloud/*arr) sees its data after.
> Keep the old `/tank/immich` datasets until validated, then remove.

### 6. Replication → node 2 (every 15 min)
```sh
pvesr create-local-job 100-0 proxmox-02 --schedule '*/15'
pvesr create-local-job 101-0 proxmox-02 --schedule '*/15'
pvesr status     # watch first sync; then incremental
```

### 7. HA resources + group
```sh
ha-manager groupadd pref-node1 --nodes 'proxmox-01:2,proxmox-02:1' --nofailback 0
ha-manager add ct:100 --group pref-node1 --state started --max_relocate 1
ha-manager add ct:101 --group pref-node1 --state started --max_relocate 1
ha-manager status
```

### 8. Failover test
Reboot node 1; on node 2 `watch ha-manager status` → CT100/101 restart on node 2
(with data, from the ≤15-min replica) within ~1-2 min; fail back when node 1
returns.

---

## Risks & rollback
- **Pool rename (step 2)** is the riskiest — it moves the PBS datastore path. If
  import/path-update fails: re-`zpool import`, re-point the datastore. Node-1
  local vzdumps + offsite remain as backup during the window.
- **CT101 mount conversion (step 5)** — keep the original `/tank/*` datasets
  until each service validates against the new managed volume; only then delete.
- **Power is still a single point of failure** — both mini-PCs on one outlet =
  a power cut takes both down. Separate circuit/UPS for true resilience.
- **QDevice on node 2** — protects node-1 failure (the goal). A node-2 failure
  loses the qdevice too; move qnetd to a Pi for symmetric quorum (see Fase 9 A).
