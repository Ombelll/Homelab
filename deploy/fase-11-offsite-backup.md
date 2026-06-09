# Fase 11 — Off-site backup (disaster recovery)

Everything is currently backed up **on-site only**: PBS on node 2 holds all
guest backups, and node 1's local copy sits on the same desk. A fire, theft,
flood, or a ransomware'd LAN takes out both. This phase mirrors the PBS
datastore to the **cloud, client-side encrypted**, so there's always a copy
that isn't in the house.

```
guests ──vzdump──▶ PBS datastore (/bkp/datastore, node 2) ──rclone crypt──▶ Backblaze B2
        02:30/03:00 nightly                                  04:30 nightly (encrypted)
```

Because the PBS datastore contains **every** guest backup (CT100/101/110 + any
future), mirroring that one directory covers the whole homelab.

## Why rclone + crypt (not PBS-native)
PBS has no built-in cloud target. `rclone sync` mirrors the chunk store
incrementally (only new chunks upload), and an rclone **`crypt`** remote
encrypts filenames + contents locally first — so Backblaze only ever sees
ciphertext. The crypt password is the **DR key**: without it the cloud copy is
unrecoverable. Store it in Vaultwarden **and** somewhere off the homelab (you
can't restore from a backup whose password only lived on the dead server).

## Files in this repo
- `deploy/offsite/pbs-offsite-sync.sh` — the sync (with an overlap lock + an
  empty-source safety guard so a missing mount can't wipe the cloud copy).
- `deploy/offsite/pbs-offsite-sync.service` / `.timer` — nightly at 04:30.

---

## Setup (one-time, on node 2 / Proxmox-02)

### 1. Backblaze B2 (≈ $6/TB/month, 10 GB free)
1. Create a Backblaze account → **B2 Cloud Storage**.
2. Create a **private** bucket, e.g. `homelab-pbs-<random>`.
3. Create an **Application Key** scoped to that bucket; note the **keyID** and
   **applicationKey** (shown once).

(Any rclone backend works — S3, Storj, a friend's Minio, a remote PBS box.
Swap the `b2` remote below for your provider; the crypt layer stays the same.)

### 2. Install + configure rclone on node 2
```bash
apt-get update && apt-get install -y rclone
rclone config
```
Create **two** remotes:

**a) the cloud remote** (`offsite-b2`):
```
n) New remote
name> offsite-b2
Storage> b2
account> <keyID>
key> <applicationKey>
(accept defaults for the rest)
```

**b) the encryption wrapper** (`offsite-crypt`) pointing at the bucket:
```
n) New remote
name> offsite-crypt
Storage> crypt
remote> offsite-b2:homelab-pbs-<random>/datastore
filename_encryption> standard
directory_name_encryption> true
password> <generate a strong one — THIS IS THE DR KEY>
password2> <generate a second (salt) — also save it>
```
> Save BOTH crypt passwords in Vaultwarden + off-site. Losing them = losing the
> backup. The B2 keyID/appKey are NOT enough to decrypt.

Quick check: `rclone lsd offsite-crypt:` should connect without error.

### 3. Optional tuning — `/etc/pbs-offsite.env`
```bash
RCLONE_REMOTE="offsite-crypt:pbs"
RCLONE_BWLIMIT="20M"     # cap upload so it doesn't saturate your line (0 = full)
```

### 4. Install the sync + timer
From a checkout of this repo on node 2 (or scp the files over):
```bash
install -m755 deploy/offsite/pbs-offsite-sync.sh /usr/local/bin/pbs-offsite-sync.sh
cp deploy/offsite/pbs-offsite-sync.service deploy/offsite/pbs-offsite-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pbs-offsite-sync.timer
```

### 5. First run (foreground, watch it work)
```bash
RCLONE_REMOTE="offsite-crypt:pbs" /usr/local/bin/pbs-offsite-sync.sh
tail -f /var/log/pbs-offsite-sync.log
systemctl list-timers pbs-offsite-sync.timer   # confirm next run = 04:30
```

---

## Restore (the part everyone forgets to test)
On any machine with rclone + the crypt passwords configured:
```bash
# Pull the (decrypted) datastore back to a local dir or a fresh PBS host:
rclone sync offsite-crypt:pbs /bkp/datastore-restored --progress
```
Then point a PBS install at that datastore and restore guests as usual
(`proxmox-backup-client` / the PBS UI → Restore). **Do a test restore now**, not
during an actual disaster — verify one snapshot pulls back and decrypts.

## Monitoring
The sync logs to `/var/log/pbs-offsite-sync.log`. Consider adding a check that
the last line is recent + says `OK` (Uptime Kuma push monitor, or a healthcheck
ping) so a silently-failing sync gets noticed. The dashboard's backup-freshness
alerting only watches local backups today.

## Cost / sizing
Current datastore is small (hundreds of MB–few GB). At B2 pricing that's cents/
month; even a few hundred GB of photos (Immich) is a few €/month. Set
`RCLONE_BWLIMIT` if the first full upload would saturate your uplink.
