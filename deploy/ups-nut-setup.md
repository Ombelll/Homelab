# UPS auto-shutdown — Green Cell MicroPower 600VA + NUT (Proxmox host)

Goal: when mains power fails, bridge on battery; when the battery gets low,
**gracefully shut the Proxmox host down** (which in turn cleanly stops all
CTs/VMs — CT 100 Postgres, CT 101 Docker stack). When mains returns, the UPS
powers back on and the host boots.

NUT (Network UPS Tools) is a **daemon**, not a cron job: `upsd` reads the UPS
over USB and `upsmon` reacts to the `OB` (on-battery) / `LB` (low-battery)
flags automatically. Nothing to schedule.

Hardware: Green Cell MicroPower 600VA / 360W, line-interactive + AVR, USB data.
Per the NUT hardware list it speaks the Megatec/Voltronic "Q*" protocol →
driver `nutdrv_qx` (modern) or `blazer_usb` (older, also fine).
Ref: https://networkupstools.org/ddl/Greencell/Micropower_600.html

Run everything below as root on the Proxmox host, with the UPS USB cable
plugged into the host.

---

## 1. Install

```sh
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nut nut-client nut-server
```

## 2. Confirm the host sees the UPS + pick the driver

```sh
lsusb                 # expect a line for the UPS (often "Cypress", "MEC",
                      #   "INNO TECH" or a generic HID PDC — note idVendor:idProduct)
nut-scanner -U        # prints a ready-made ups.conf block if it auto-detects
```

If `nut-scanner` prints a block, use its `driver`/`port`. Otherwise use the
config below (`nutdrv_qx`, `port = auto`); if that fails to start, switch the
driver line to `blazer_usb`.

## 3. Config files

`/etc/nut/nut.conf` — single machine that both reads the UPS and shuts down:
```ini
MODE=standalone
```

`/etc/nut/ups.conf` — define the UPS:
```ini
[greencell]
    driver = nutdrv_qx
    port = auto
    desc = "Green Cell MicroPower 600VA"
    # Fallback if nutdrv_qx won't detect it:
    #   driver = blazer_usb
    # If still nothing, pin the USB IDs from `lsusb` (example):
    #   vendorid = 0665
    #   productid = 5161
```

`/etc/nut/upsd.conf` — listen on localhost only (default is fine):
```ini
LISTEN 127.0.0.1 3493
```

`/etc/nut/upsd.users` — account `upsmon` uses to talk to `upsd`
(**pick your own strong password**, same value goes in upsmon.conf):
```ini
[upsmon]
    password = CHANGE_ME_STRONG
    upsmon master
```

`/etc/nut/upsmon.conf` — the shutdown logic:
```ini
MONITOR greencell@localhost 1 upsmon CHANGE_ME_STRONG master
MINSUPPLIES 1
SHUTDOWNCMD "/sbin/shutdown -h +0"
POWERDOWNFLAG /etc/killpower
POLLFREQ 5
POLLFREQALERT 5
HOSTSYNC 15
DEADTIME 15
```

Lock down the files that hold the password:
```sh
chown root:nut /etc/nut/upsd.users /etc/nut/upsmon.conf
chmod 640 /etc/nut/upsd.users /etc/nut/upsmon.conf
```

## 4. Start + enable

```sh
# Debian uses nut-driver-enumerator to spawn a per-UPS driver service from
# ups.conf. Re-run it after editing ups.conf, then start the daemons.
systemctl restart nut-driver-enumerator.service
systemctl enable --now nut-server nut-monitor
systemctl restart nut-server nut-monitor
```

## 5. Verify communication (no shutdown involved)

```sh
upsc greencell           # full variable dump
upsc greencell ups.status        # expect: OL  (online / on mains)
upsc greencell battery.charge    # expect: 100 (or close)
```

`ups.status` flags: `OL` = on mains, `OB` = on battery, `LB` = low battery.

## 6. Safe test

- **Detection test (safe):** briefly pull the UPS's mains plug. `upsc greencell
  ups.status` should flip to `OB` and `battery.charge` should start dropping;
  `/var/log/syslog` shows `UPS greencell on battery`. Plug back in → `OL`.
  This proves monitoring works **without** triggering a shutdown.
- **Full shutdown test (optional, disruptive):** leave it on battery until it
  hits `LB` — the host should run `SHUTDOWNCMD` and halt, taking the CTs with
  it. Only do this when you can afford the downtime.

## 7. Make auto-restart complete the loop

- **BIOS:** set *Restore on AC Power Loss = Power On* on the mini-PC, so when
  the UPS powers back up after mains returns, the host boots by itself.
- **UPS power-off:** the `POWERDOWNFLAG /etc/killpower` line lets NUT tell the
  UPS to cut its own output once the OS has halted, so the battery isn't drained
  to zero; it restores power (and the host boots) when mains is back.

## Notes / tuning

- **What shuts down:** only the host is told to halt. A Proxmox host shutdown
  cleanly stops all guests, so CT 100 (Postgres) and CT 101 (Docker) go down
  gracefully — no need to configure NUT on the containers. (Optionally set a
  sane guest *Start/Shutdown order* in the Proxmox UI per CT.)
- **Also plug the network gear** (router/switch/modem) into the UPS so Tailscale
  + the dashboard stay reachable during a dip and NUT can finish its work.
- **Shut down earlier than `LB`?** If you'd rather halt after a fixed time on
  battery (e.g. 5 min) instead of waiting for low-battery, add `upssched` with a
  `NOTIFYCMD` + an `AT ONBATT ... START-TIMER onbatt 300` rule that runs
  `upsmon -c fsd`. Not needed for a first setup.
- **Battery is a consumable** (~3–5 yr). `upsc greencell battery.charge` /
  `battery.voltage` show health; replace when runtime drops off.
- After it's working, the homelab agent already reports the host fine; the UPS
  state could later be surfaced in the dashboard via `upsc` if wanted.
