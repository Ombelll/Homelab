#!/usr/bin/env bash
# Idempotent security hardening for a Proxmox VE node. Safe to re-run.
# Applies the fixable findings from deploy/security-audit.sh:
#   * mask rpcbind (no NFS client here)
#   * SSH: keys-only — PermitRootLogin prohibit-password + PasswordAuthentication no
#     (GUARDED: only flips if a root SSH key already exists, else leaves SSH as-is
#      so you can't lock yourself out; the PVE web console works either way)
#   * apply pending security updates (apt)
# Does NOT touch 2FA (needs your phone) or anything credential-related.
#   bash deploy/security-harden.sh
set -eu
say(){ echo "==> $*"; }

# --- rpcbind ---------------------------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q '^rpcbind'; then
  if systemctl is-enabled --quiet rpcbind 2>/dev/null || systemctl is-active --quiet rpcbind 2>/dev/null || systemctl is-active --quiet rpcbind.socket 2>/dev/null; then
    systemctl disable --now rpcbind.socket rpcbind 2>/dev/null || true
    systemctl mask rpcbind.socket rpcbind 2>/dev/null || true
    say "rpcbind: disabled + masked"
  else
    say "rpcbind: already inactive"
  fi
else
  say "rpcbind: not installed"
fi

# --- SSH hardening (guarded) ----------------------------------------------
SSHD=/etc/ssh/sshd_config
DROPIN=/etc/ssh/sshd_config.d/00-homelab-harden.conf
KEYS=/root/.ssh/authorized_keys
if [ -s "$KEYS" ]; then
  mkdir -p /etc/ssh/sshd_config.d
  cat > "$DROPIN" <<'EOF'
# Managed by deploy/security-harden.sh — keys-only root, no password auth.
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  # Some images hardcode these in the main file; neutralise conflicting lines.
  sed -i -E 's/^[[:space:]]*PasswordAuthentication[[:space:]]+yes/#&/I; s/^[[:space:]]*PermitRootLogin[[:space:]]+yes/#&/I' "$SSHD" 2>/dev/null || true
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    say "SSH: hardened to keys-only (root key present: $(grep -c . "$KEYS") line(s))"
  else
    rm -f "$DROPIN"; say "SSH: config test FAILED — reverted, left SSH unchanged"
  fi
else
  say "SSH: NO root authorized_keys found — leaving SSH as-is (won't risk lockout)."
  say "     Add a key first:  ssh-copy-id root@<this-host>  then re-run."
fi

# --- security updates ------------------------------------------------------
say "apt: refreshing + applying security updates..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq 2>/dev/null || true
BEFORE=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -c '^Inst')
apt-get -y -o Dpkg::Options::=--force-confold upgrade 2>&1 | tail -3 || true
AFTER=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -c '^Inst')
say "apt: upgradable went $BEFORE -> $AFTER"
[ -f /var/run/reboot-required ] && say "NOTE: reboot required to finish (kernel/libc)." || true

say "DONE on $(hostname)"
