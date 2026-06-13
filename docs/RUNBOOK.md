# Homelab recovery runbook

"It's broken — what now." Incident-recovery procedures + the cluster gotchas that
have actually bitten us. For the full design see [ARCHITECTURE.md](../ARCHITECTURE.md);
for phase history see [deploy-plan.md](deploy-plan.md).

## Topology quick-ref

| What | Where | IP | Notes |
|------|-------|----|-------|
| node1 | Proxmox-01 (host) | 192.168.1.10 | primary; runs CT100 + CT101 |
| node2 | Proxmox-02 (host) | 192.168.1.11 | 24 GB RAM; runs CT110 + CT111 |
| CT100 | postgres (LXC, node1) | 192.168.1.20 | shared Postgres |
| CT101 | docker (LXC, node1) | 192.168.1.21 | Traefik + all apps + **AdGuard #1** |
| CT110 | adguard2 (LXC, node2) | 192.168.1.22 | **AdGuard #2** (DNS redundancy) |
| CT111 | qdevice (LXC, node2) | 192.168.1.30 | **qnetd** (cluster tiebreaker) |
| router | GL-MT3000 (OpenWrt) | 192.168.1.1 | DHCP + DNS; SSH key-only from node1 |

Apps are at `https://<name>.lan` (Traefik TLS on `192.168.1.21:443`, local-CA cert).
DHCP hands out DNS = `192.168.1.21, 192.168.1.22` (both AdGuard).

## Out-of-band access (when the LAN / home internet is down)

The LAN (192.168.1.x) is unreachable if you're off the home network (e.g. on a phone
hotspot). Use **Tailscale**:

- **node1:** `ssh root@100.100.16.63` (proxmox-01 tailnet IP) — the reliable lifeline.
- Reach the **LXCs** through a node: `ssh root@100.100.16.63 "pct exec 101 -- <cmd>"`.
- node2 / CT101 also have tailnet IPs (`tailscale status` to list); node1 is the one
  that's always been dependable for OOB.
- PC SSH key is `%USERPROFILE%\.ssh\id_ed25519` (added to root on both nodes).

## ⚠️ The big gotcha: the QDevice lives on node2

`qnetd` (the 3rd quorum vote) runs in **CT111 on node2**, so it is NOT independent.
**Taking node2 down (crash OR maintenance) drops node1 to 1/3 votes = no quorum.**
With HA active, node1 then self-fences (reboots), and HA-managed guests may not
auto-start → full outage. Seen for real twice (failover test + a RAM swap).

→ **Permanent fix (TODO): move qnetd to an independent box** (a Pi Zero 2 W on the
LAN, or anything always-on that survives either node). Then either node can fail
gracefully. Until then, follow the maintenance procedure below.

### Safe node2 maintenance (planned downtime)

Do NOT just power node2 off. Either:
- **Best:** temporarily move CT111 (qdevice) to node1 first so node1 keeps the
  tiebreaker vote while node2 is down; or
- Accept the outage and use the recovery steps below when node2 returns.

(`pvecm expected 1` does NOT work while a QDevice is configured — it refuses the
override. That's why forcing quorum on a lone node1 failed during the incident.)

## Recovery: node1 rebooted / lost quorum / containers stopped

Symptoms: home DNS/internet down, `https://*.lan` dead, CT100/CT101 `stopped`.

1. Get in via Tailscale: `ssh root@100.100.16.63`.
2. Check state: `pvecm status | grep -i quorate` and `pct list`.
3. **If non-quorate because node2 is down:** the only clean fix is to bring node2
   back (power on; it may halt at a BIOS "press any key" prompt after a hardware
   change — that's normal, press a key). Once node2 is on the LAN, quorum returns to
   3 automatically.
4. With quorum back: `pct start 100 && pct start 101`. CT101's ~39-container docker
   stack takes a few minutes; AdGuard `.21` coming up restores home DNS.
5. If HA was set to `ignored` during maintenance, re-enable:
   `ha-manager set ct:100 --state started && ha-manager set ct:101 --state started`.

## DNS / "wifi offline"

Home clients use AdGuard `.21` (node1) + `.22` (node2) via DHCP option 6. Either one
alone keeps DNS + ad-blocking working; both down (or both nodes down) = no DNS.

- **Check an AdGuard correctly:** query it directly — `Resolve-DnsName home.lan -Server
  192.168.1.22` (should → 192.168.1.21) and a public name (proves upstream). Do NOT
  judge `.22` from the node2 *host* (`systemctl`/`ss` there read the wrong namespace —
  the unit + `:53` live inside CT110). Use `pct exec 110 -- systemctl is-active AdGuardHome`.
- **Emergency DNS fallback:** point DHCP back at the router (which resolves `*.lan` →
  .21 itself). On node1: `ssh root@192.168.1.1 'uci set ... ; uci commit dhcp; /etc/init.d/dnsmasq restart'`
  then clients `ipconfig /flushdns` or renew. The router DNS = no ad-blocking but works.
- `.22` config is a clone of `.21` (same blocklists/upstream/login); regenerate with
  `deploy/https-proxy/gen-certs.sh` is for the TLS cert, not DNS.

## HTTPS / Traefik won't route (every host 404)

If Traefik logs `client version 1.24 is too old, minimum 1.40` and loads no routers:
Docker Engine 29 dropped API < 1.40 but Traefik pins 1.24. Fix is the host drop-in
**`/etc/systemd/system/docker.service.d/min-api.conf`** = `Environment=DOCKER_MIN_API_VERSION=1.24`
on CT101 (`systemctl daemon-reload && systemctl restart docker`). After any Traefik
recreate, confirm `docker version` shows `MinAPIVersion: 1.24`.

After a `git pull` that changes `deploy/traefik/dynamic.yml`, `docker restart traefik`
(inode-swap makes the file-watcher miss it).

## HA layout

- CT100 + CT101 in HA group `pref-node1` (Proxmox-01 prio 2, Proxmox-02 prio 1).
- node2 now has 24 GB, so CT101 (12 GB) CAN fail over to node2.
- BUT real cross-node failover is only safe once the QDevice is independent (see above);
  until then a node2 loss still breaks node1's quorum.

## Wake-on-LAN (node1)

OS-side WoL is enabled (`ethtool -s enp1s0 wol g`, MAC 68:84:7e:ab:01:f4) and
`pvenode wakeonlan Proxmox-01` is configured from node2 — but it only works if BIOS
WoL is enabled (unverified). Don't rely on it; physical power button is the fallback.
