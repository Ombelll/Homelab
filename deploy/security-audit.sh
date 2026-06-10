#!/usr/bin/env bash
# Read-only security audit for a Proxmox VE host (+ its LXCs + Docker on CT101).
# Makes NO changes. Writes a full report to /tmp/sec-audit.txt and prints the
# WARN/FAIL summary at the end (console-friendly). Run on each PVE node:
#   bash deploy/security-audit.sh
# Markers: [FAIL] act now · [WARN] review · [OK] good · [INFO] context.
OUT=/tmp/sec-audit.txt
: > "$OUT"
H(){ echo; echo "=== $* ==="; } >>"$OUT"
ok(){   echo "[OK]   $*"   >>"$OUT"; }
warn(){ echo "[WARN] $*"   >>"$OUT"; }
fail(){ echo "[FAIL] $*"   >>"$OUT"; }
info(){ echo "[INFO] $*"   >>"$OUT"; }
have(){ command -v "$1" >/dev/null 2>&1; }

H "HOST $(hostname) — $(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") — $(pveversion 2>/dev/null | head -1)"
[ -f /var/run/reboot-required ] && warn "reboot required (kernel/libs updated)" || ok "no reboot-required flag"
UPG=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -c '^Inst'); info "apt upgradable packages: ${UPG:-?}"
SECUP=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -ci 'security'); [ "${SECUP:-0}" -gt 0 ] && warn "$SECUP security-related upgrades pending" || ok "no security upgrades flagged"

H "SSH daemon"
if have sshd; then
  C=$(sshd -T 2>/dev/null)
  echo "$C" | grep -qi '^permitrootlogin yes' && fail "SSH PermitRootLogin yes (root login over SSH)" || ok "PermitRootLogin not 'yes' ($(echo "$C"|grep -i permitrootlogin|head -1))"
  echo "$C" | grep -qi '^passwordauthentication yes' && warn "SSH PasswordAuthentication yes (consider keys-only)" || ok "PasswordAuthentication off"
  echo "$C" | grep -qi '^permitemptypasswords yes' && fail "SSH PermitEmptyPasswords yes" || ok "no empty SSH passwords"
else info "no sshd"; fi

H "Listening sockets (0.0.0.0 / :: = all interfaces)"
if have ss; then
  ss -tulpnH 2>/dev/null | awk '{print $1,$5,$7}' | sort -u >>"$OUT"
  PUB=$(ss -tulpnH 2>/dev/null | awk '$5 ~ /0\.0\.0\.0:|\[::\]:/{print $5}' | sort -u)
  echo "$PUB" | grep -qE ':(8006|22|3128)' && info "PVE web/ssh on all-ifaces (expected on LAN)"
  for p in $(echo "$PUB" | sed -E 's/.*:([0-9]+)$/\1/' | sort -un); do
    case "$p" in 8006|22|111|3128|8007|85) : ;; *) warn "listening on ALL interfaces: port $p"; esac
  done
else info "no ss"; fi

H "rpcbind / NFS exposure"
if have ss && ss -tulpnH 2>/dev/null | grep -q ':111 '; then fail "rpcbind listening on :111"; else ok "rpcbind not listening"; fi

H "PVE firewall"
if have pve-firewall; then
  S=$(pve-firewall status 2>/dev/null | head -1); info "pve-firewall: $S"
  echo "$S" | grep -qi 'enabled' || warn "PVE firewall not enabled (datacenter/host level)"
fi

H "PVE 2FA (which users have TFA)"
if [ -f /etc/pve/priv/tfa.cfg ]; then
  TFA=$(grep -cE '^[A-Za-z]' /etc/pve/priv/tfa.cfg 2>/dev/null)
  [ "${TFA:-0}" -gt 0 ] && ok "$TFA PVE user(s) have 2FA configured" || warn "tfa.cfg present but no users enrolled"
  grep -oE '^[^:]+' /etc/pve/priv/tfa.cfg 2>/dev/null | sed 's/^/      with 2FA: /' >>"$OUT"
else warn "no PVE 2FA configured (/etc/pve/priv/tfa.cfg missing) — root@pam has no 2FA"; fi

H "fail2ban"
if have fail2ban-client && systemctl is-active --quiet fail2ban; then
  ok "fail2ban active"; fail2ban-client status 2>/dev/null | sed 's/^/      /' >>"$OUT"
else warn "fail2ban not active (brute-force attempts unthrottled)"; fi

H "Accounts: UID0 / empty passwords / login shells"
awk -F: '($3==0){print "      UID0: "$1}' /etc/passwd >>"$OUT"
EMPTY=$(awk -F: '($2==""){print $1}' /etc/shadow 2>/dev/null)
[ -n "$EMPTY" ] && fail "empty-password accounts: $EMPTY" || ok "no empty-password accounts"
awk -F: '($7 ~ /(bash|sh|zsh)$/){print "      shell: "$1" "$7}' /etc/passwd >>"$OUT"

H "sudoers NOPASSWD"
NOPW=$(grep -rhsE 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | grep -v '^#')
[ -n "$NOPW" ] && warn "NOPASSWD sudo rules present:" && echo "$NOPW" | sed 's/^/      /' >>"$OUT" || ok "no NOPASSWD sudo rules"

H "Cron (root + /etc/cron.d)"
{ crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null; } | grep -vE '^\s*#|^\s*$|^\s*[A-Z_]+=' | sed 's/^/      /' >>"$OUT"

H "Tailscale exposure"
if have tailscale; then
  tailscale serve status 2>/dev/null | sed 's/^/      serve: /' >>"$OUT"
  if tailscale funnel status 2>/dev/null | grep -qiE 'https|enabled|:443'; then fail "Tailscale FUNNEL active — something is exposed to the public internet:"; tailscale funnel status 2>/dev/null | sed 's/^/      /' >>"$OUT"; else ok "no Tailscale funnel (nothing public via tailnet)"; fi
else info "no tailscale on this host"; fi

H "LXC containers (unprivileged?)"
if have pct; then
  for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    cfg=$(pct config "$id" 2>/dev/null)
    unp=$(echo "$cfg" | grep -E '^unprivileged:' | awk '{print $2}')
    feat=$(echo "$cfg" | grep -E '^features:' | sed 's/features: //')
    name=$(echo "$cfg" | grep -E '^hostname:' | awk '{print $2}')
    if [ "$unp" = "1" ]; then ok "CT$id ($name) unprivileged${feat:+ — features: $feat}"; else fail "CT$id ($name) is PRIVILEGED${feat:+ — features: $feat}"; fi
    echo "$cfg" | grep -qE 'features:.*nesting=1' && info "CT$id has nesting=1"
    echo "$cfg" | grep -qE 'features:.*keyctl=1' && info "CT$id has keyctl=1"
  done
fi

H "Docker on CT101"
if have pct && pct status 101 >/dev/null 2>&1; then
  pct exec 101 -- sh -c '
    command -v docker >/dev/null || { echo "[INFO] no docker in CT101"; exit 0; }
    for c in $(docker ps --format "{{.Names}}"); do
      insp=$(docker inspect "$c" 2>/dev/null)
      priv=$(echo "$insp" | grep -m1 "\"Privileged\": true")
      caps=$(echo "$insp" | tr -d " \n" | grep -oE "\"CapAdd\":\[[^]]*\]" | grep -v "null")
      sock=$(echo "$insp" | grep -E "/var/run/docker.sock" | grep -v ":ro")
      [ -n "$priv" ] && echo "[FAIL] container $c is --privileged"
      [ -n "$caps" ] && echo "[WARN] container $c CapAdd: $caps"
      [ -n "$sock" ] && echo "[WARN] container $c mounts docker.sock READ-WRITE"
    done
    echo "[INFO] published ports (host-exposed):"
    docker ps --format "{{.Names}} {{.Ports}}" | grep -E "0.0.0.0|:::" | sed "s/^/      /"
  ' >>"$OUT" 2>&1
fi

# ---- summary ----
echo
echo "################ SECURITY AUDIT SUMMARY — $(hostname) ################"
echo "FAIL=$(grep -c '\[FAIL\]' "$OUT")  WARN=$(grep -c '\[WARN\]' "$OUT")  (full report: $OUT)"
echo "---------------- findings (FAIL/WARN) ----------------"
grep -E '\[FAIL\]|\[WARN\]' "$OUT"
echo "######################################################################"
