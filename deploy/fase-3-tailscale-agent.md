# Fase 3 — Tailscale + agent (uitgewerkt)

Dit is de praktische uitwerking van Fase 3 uit [`deploy-plan.md`](../docs/deploy-plan.md),
met productie-klare artefacten in deze map:

| Bestand | Wat |
|---|---|
| [`homelab-agent.service`](homelab-agent.service) | Gehardende systemd-unit (draait `node dist/index.js`, geen `tsx`). |
| [`install-agent.sh`](install-agent.sh) | Idempotent install/update-script: Node + build + env-file + service. |

> **Volgorde-let op:** de agent rapporteert *aan het dashboard*, dus Fase 2
> (Docker LXC + dashboard draaiend) moet af zijn voordat de agent iets nuttigs
> doet. Tailscale kun je los al opzetten.

---

## Deel A — Tailscale op de Proxmox host

Installeer Tailscale **op de host** (`192.168.1.10`), niet in een LXC. Zo bereik
je via één node je hele LAN (Proxmox UI, dashboard, Postgres) van onderweg.

```bash
curl -fsSL https://tailscale.com/install.sh | sh

# Adverteer je LAN-subnet zodat je ook .20/.30 etc. via de tailnet bereikt.
# --accept-dns=false voorkomt dat Tailscale je host-resolver overneemt.
tailscale up --advertise-routes=192.168.1.0/24 --accept-dns=false
```

Daarna in de [Tailscale admin console](https://login.tailscale.com/admin/machines):

1. Open de machine `proxmox-01` → **Edit route settings** → vink het
   `192.168.1.0/24`-subnet aan (subnet routing approven).
2. **Disable key expiry** voor deze machine. Een server die elke 180 dagen
   uitlogt = een homelab die op reis onbereikbaar wordt.
3. Optioneel: zet **MagicDNS** aan, dan krijg je `proxmox-01.<tailnet>.ts.net`.

**Test vanaf je telefoon** (Tailscale aan, op mobiel netwerk):
- `https://192.168.1.10:8006` → Proxmox UI
- `http://192.168.1.30:3000` → dashboard (na Fase 2)

> IP-forwarding moet aan staan voor subnet routing. Het install-script van
> Tailscale zet dit meestal goed; check met
> `sysctl net.ipv4.ip_forward` (moet `1` zijn). Zo niet:
> `echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-tailscale.conf && sysctl -p /etc/sysctl.d/99-tailscale.conf`

---

## Deel B — Agent op de Proxmox host

De host-agent meet CPU/RAM/disk + **ZFS-pools** (`tank`, en je LVM-disks) en
hwmon-sensors. Hij heeft daarvoor root nodig (`zpool status`), wat de unit
afhandelt. Er draait geen Docker op de host zelf, dus container-control loopt
hier niet — dat doet de agent in de Docker LXC (Deel C).

Op de host:

```bash
# Genereer/pak de agent-key uit je dashboard .env (AGENT_API_KEY).
# Tijdelijk klonen om aan het script te komen — daarna leeft de code in /opt:
DASHBOARD_URL=http://192.168.1.30:3000 \
AGENT_API_KEY=<key-uit-dashboard-.env> \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Ombelll/Homelab/main/deploy/install-agent.sh)"
```

Of, als je de repo al lokaal hebt staan:

```bash
cd /pad/naar/Homelab
DASHBOARD_URL=http://192.168.1.30:3000 AGENT_API_KEY=<key> ./deploy/install-agent.sh
```

Wat het script doet (idempotent — opnieuw draaien = code updaten + herstarten):

1. Installeert Node 20 + git als die ontbreken.
2. Klont/updatet de repo naar `/opt/homelab-agent`.
3. `npm ci && npm run build` in `agent/`.
4. Schrijft `/etc/homelab-agent.env` (0600, root) — je secret komt **niet** in
   het unit-bestand of de logs.
5. Installeert en start `homelab-agent.service`.

**Verifiëren:**

```bash
systemctl status homelab-agent
journalctl -u homelab-agent -f
```

Je ziet `[agent] starting — host=proxmox-01 ...` en elke 30s een tick. In het
dashboard → **Servers** verschijnt de host binnen ~30 sec, met live grafiek en
je `tank`-pool erbij.

---

## Deel C — Agent in de Docker LXC (CT 100 e.v.)

In de LXC die Docker draait wil je óók de agent — dáár werkt container
start/stop/restart/logs vanuit het dashboard. Zelfde script:

```bash
pct enter <docker-lxc-id>
DASHBOARD_URL=http://192.168.1.30:3000 AGENT_API_KEY=<key> \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/Ombelll/Homelab/main/deploy/install-agent.sh)"
```

De agent detecteert Docker automatisch en begint de container-lijst te syncen.

---

## Updaten / roteren

- **Code updaten:** her-run het script (of `systemctl restart homelab-agent`
  na een handmatige `git pull && npm run build`).
- **Key roteren:** pas `AGENT_API_KEY` in `/etc/homelab-agent.env` én in de
  dashboard-config aan, dan `systemctl restart homelab-agent`.
- **Verwijderen:** `systemctl disable --now homelab-agent && rm /etc/systemd/system/homelab-agent.service /etc/homelab-agent.env && systemctl daemon-reload`

## Troubleshooting

| Symptoom | Oorzaak / fix |
|---|---|
| `missing required env var: DASHBOARD_URL` | env-file niet geladen — check `EnvironmentFile=/etc/homelab-agent.env` bestaat en is gevuld. |
| Agent draait, host niet in dashboard | `AGENT_API_KEY` matcht niet, of `DASHBOARD_URL` onbereikbaar vanaf de host. Test: `curl -sv $DASHBOARD_URL/api/health`. |
| Geen ZFS-pool zichtbaar | agent draait niet als root, of `zpool` niet op PATH. `journalctl -u homelab-agent` toont de fout. |
| `401` in de logs | key mismatch tussen `/etc/homelab-agent.env` en dashboard. |
| Crash-loop | `StartLimitBurst` stopt na 5 pogingen/60s; fix config, dan `systemctl reset-failed homelab-agent && systemctl start homelab-agent`. |
