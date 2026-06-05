#!/bin/sh
# Idempotent NUT setup for the Green Cell MicroPower 600VA on the Proxmox host.
# Configures upsd (reads the UPS over USB) + upsmon (auto-shuts-the-host-down
# on low battery). Localhost-only; the upsmon<->upsd password is machine-
# generated (not a user credential) and stored 0640 root:nut.
#
# Safe to re-run: it regenerates configs but preserves the password if one was
# already written, and never triggers a shutdown by itself (that only happens
# on a real low-battery event).
#
# Driver: Green Cell speaks Megatec/Voltronic "Q*" → nutdrv_qx, with an
# automatic fallback to blazer_usb if the first doesn't talk to the UPS.
set -u

UPSNAME=greencell
PWFILE=/etc/nut/.upsmon_pw   # remember the generated password across re-runs

say() { echo ">>> $*"; }

# 1. Install (idempotent)
say "installing nut packages (if missing)"
DEBIAN_FRONTEND=noninteractive apt-get install -y nut nut-client nut-server >/dev/null 2>&1 || true

# 2. Show what the host sees on USB (diagnostic)
say "lsusb:"
lsusb || true
say "nut-scanner -U:"
nut-scanner -U 2>/dev/null || true

# 3. Password: reuse if present, else generate one
if [ -f "$PWFILE" ]; then
  PW=$(cat "$PWFILE")
  say "reusing existing upsmon password"
else
  PW=$(openssl rand -hex 16)
  ( umask 077; printf '%s' "$PW" > "$PWFILE" )
  say "generated new upsmon password"
fi

write_configs() {
  driver="$1"
  cat > /etc/nut/nut.conf <<EOF
MODE=standalone
EOF

  cat > /etc/nut/ups.conf <<EOF
[$UPSNAME]
    driver = $driver
    port = auto
    desc = "Green Cell MicroPower 600VA"
EOF

  cat > /etc/nut/upsd.conf <<EOF
LISTEN 127.0.0.1 3493
EOF

  cat > /etc/nut/upsd.users <<EOF
[upsmon]
    password = $PW
    upsmon master
EOF

  cat > /etc/nut/upsmon.conf <<EOF
MONITOR $UPSNAME@localhost 1 upsmon $PW master
MINSUPPLIES 1
SHUTDOWNCMD "/sbin/shutdown -h +0"
POWERDOWNFLAG /etc/killpower
POLLFREQ 5
POLLFREQALERT 5
HOSTSYNC 15
DEADTIME 15
EOF

  chown root:nut /etc/nut/upsd.users /etc/nut/upsmon.conf 2>/dev/null || true
  chmod 640 /etc/nut/upsd.users /etc/nut/upsmon.conf 2>/dev/null || true
}

start_nut() {
  systemctl restart nut-driver-enumerator.service 2>/dev/null || true
  systemctl enable --now nut-server nut-monitor >/dev/null 2>&1 || true
  systemctl restart nut-server nut-monitor 2>/dev/null || true
  sleep 4
}

talks() {
  # 0 if upsd answers with a real status for the UPS
  upsc "$UPSNAME" ups.status >/dev/null 2>&1
}

# 4. Try nutdrv_qx, fall back to blazer_usb
for drv in nutdrv_qx blazer_usb; do
  say "configuring driver: $drv"
  write_configs "$drv"
  start_nut
  if talks; then
    say "SUCCESS with driver $drv"
    break
  else
    say "driver $drv did not talk to the UPS yet"
  fi
done

# 5. Report
echo
say "=== upsc $UPSNAME (summary) ==="
if talks; then
  upsc "$UPSNAME" 2>/dev/null | grep -E '^(device\.mfr|device\.model|ups\.status|ups\.load|battery\.charge|battery\.runtime|battery\.voltage|input\.voltage)' || upsc "$UPSNAME"
  echo
  say "ups.status = $(upsc "$UPSNAME" ups.status 2>/dev/null)  (OL=on mains, OB=on battery, LB=low)"
  say "NUT_OK"
else
  say "NUT_NOT_TALKING — neither nutdrv_qx nor blazer_usb got a status."
  say "Check the lsusb line above for the UPS idVendor:idProduct and pin it in"
  say "/etc/nut/ups.conf (vendorid=/productid=). Driver logs:"
  journalctl -u "nut-driver@$UPSNAME" -n 20 --no-pager 2>/dev/null || true
  journalctl -u nut-driver-enumerator -n 10 --no-pager 2>/dev/null || true
fi
echo NUT_SETUP_DONE
