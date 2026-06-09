# Fase 11 — Off-site backup (disaster recovery)

Everything is currently backed up **on-site only**: PBS on node 2 holds all
guest backups, and node 1's local copy sits on the same desk. A fire, theft,
flood, or a ransomware'd LAN takes out both. This phase mirrors the PBS
datastore to the **cloud, client-side encrypted**, so there's always a copy
that isn't in the house.

```
guests ──vzdump──▶ PBS datastore (/bkp/datastore, node 2) ──rclone crypt over SFTP──▶ Hetzner Storage Box (1 TB)
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

### 1. Hetzner Storage Box (1 TB)
In the Hetzner console (Robot → Storage Box), on your box:
1. **Enable SSH support** (checkbox under "Settings" — needed for SFTP/rsync).
2. Note the **username** (`uXXXXXX`) and **hostname** (`uXXXXXX.your-storagebox.de`).
   SFTP/SSH is on **port 23**.
3. Auth: either set a password, or (recommended) upload an SSH public key.
   Generate one on node 2 and install it on the box:
   ```bash
   ssh-keygen -t ed25519 -f /root/.ssh/hetzner_storagebox -N ""
   # Hetzner: upload /root/.ssh/hetzner_storagebox.pub via the console, OR:
   cat /root/.ssh/hetzner_storagebox.pub | ssh -p23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key
   ```

(The sync script is backend-agnostic — any rclone remote works. We use Hetzner
over SFTP here; the crypt layer below is identical for any target.)

### 2. Install + configure rclone on node 2
```bash
apt-get update && apt-get install -y rclone
rclone config
```
Create **two** remotes:

**a) the Storage Box over SFTP** (`offsite-hetzner`):
```
n) New remote
name> offsite-hetzner
Storage> sftp
host> uXXXXXX.your-storagebox.de
user> uXXXXXX
port> 23
key_file> /root/.ssh/hetzner_storagebox      # (or set a password instead)
(accept defaults for the rest)
```

**b) the encryption wrapper** (`offsite-crypt`) pointing at a folder on the box:
```
n) New remote
name> offsite-crypt
Storage> crypt
remote> offsite-hetzner:pbs-datastore
filename_encryption> standard
directory_name_encryption> true
password> <generate a strong one — THIS IS THE DR KEY>
password2> <generate a second (salt) — also save it>
```
> Save BOTH crypt passwords in Vaultwarden + off-site. Losing them = losing the
> backup. SSH access to the Storage Box is NOT enough to decrypt.

Quick check: `rclone lsd offsite-crypt:` should connect without error
(first connect: accept the Storage Box host key).

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
Fixed-price 1 TB Storage Box — no per-GB or egress fees, so the only limit is
the 1 TB. Current datastore is tiny (hundreds of MB–few GB); even the full
Immich library should fit comfortably. Set `RCLONE_BWLIMIT` (e.g. `20M`) if the
first full upload would saturate your uplink.
