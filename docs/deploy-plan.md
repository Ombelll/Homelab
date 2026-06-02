# Homelab Deployment Plan

**Target hardware:** Intel i5-9400T mini-PC, 16 GB RAM, 500 GB NVMe + 250 GB SATA SSD.
Doel: Proxmox VE 8 hypervisor met een Debian-LXC voor Docker, een dedicated
PostgreSQL LXC, een tweede ZFS pool voor backups op de SATA SSD, en de
Homelab Control Center plus uitbreidingen daar bovenop.

**Aanpak:** elf opeenvolgende fases. Iedere fase is een avond of weekend-middag
werk en heeft een duidelijk "klaar"-criterium. Niet verder zonder dat het
vorige werkt.

> Dit document is de markdown-mirror van `Homelab-Plan.docx`. Word-versie
> is voor printen / annoteren; deze is voor zoeken / kopiëren / git diff.

---

## Fase 0 — Voorbereiding (30 min, alleen denkwerk)

**Doel:** weten wat je nodig hebt voor je aan iets begint.

### Checklist

- Mini-PC bereikbaar via toetsenbord + scherm (een keer, voor install)
- USB-stick van 8 GB+ klaar voor Proxmox ISO
- Bekabeld netwerk (geen WiFi tijdens setup)
- Tailscale-account aangemaakt (gratis personal plan voldoende)
- Optioneel: een eigen domein gekocht (mag ook `*.ts.net` via Tailscale blijven)

### Disk-layout

Beslissingen op basis van de hardware:

- **NVMe 500 GB** → `rpool` (Proxmox + LXC/VM root disks, fast IO)
- **SATA SSD 250 GB** → `tank` (data + Proxmox Backup Server target)

NVMe en SATA SSD mirroren elkaar niet: ze hebben verschillende capaciteit en
sterk verschillende snelheid. Twee aparte ZFS pools is de juiste keuze.

**Eind-toestand:** je weet voor jezelf de antwoorden hierop.

---

## Fase 1 — Proxmox foundation (1 avond, ~2 uur)

**Doel:** hypervisor draait, je kunt 'm via browser bereiken.

### Stappen

1. Download Proxmox VE 8 ISO van [proxmox.com](https://proxmox.com)
2. Flash op USB met Rufus (DD-mode!)
3. Boot mini-PC vanaf USB en installeer:
   - Target disk: **alleen NVMe** (`/dev/nvme0n1`)
   - Filesystem: ZFS RAID0 (single-disk mode, geen mirror want sizes verschillen)
   - Hostname: bv. `homelab.lan`
   - Network: statisch IP (anders breekt alles als je router 'm verschuift)
4. Boot, open in browser: `https://<ip>:8006`
5. Run de community helper-script voor "Proxmox VE Post Install":

   ```bash
   bash -c "$(wget -qLO - https://github.com/community-scripts/ProxmoxVE/raw/main/misc/post-pve-install.sh)"
   ```

   Dit fixt no-subscription repos en verwijdert nag-popups.

6. Update en reboot:

   ```bash
   apt update && apt full-upgrade -y && reboot
   ```

**Klaar-criterium:** je logt in op de Proxmox web UI zonder subscription-popup,
en je ziet je hardware (CPU, RAM, disk pool `rpool`) in het dashboard.

---

## Fase 1.4 — Claude Code op je homelab (10 min)

**Doel:** Claude beschikbaar in de terminal van je Proxmox host of LXC, zodat
je vanaf je homelab zelf vragen kunt stellen (config debuggen, container
labels schrijven, een nieuwe service genereren) zonder steeds tussen
machines te wisselen.

**Waar installeren?** Op het systeem waar je het meest commands draait. Voor
jou wordt dat de Docker LXC (na Fase 2). Tip: installeer 'm ook op je
Windows desktop, dan kun je vanaf beide locaties praten.

### Vereisten

- Node.js 18+ (in de Docker LXC en op de Proxmox host meestal al aanwezig)
- Een Anthropic API-key OF een Claude Pro / Max abonnement (gratis tier werkt niet)
- SSH-toegang naar de target machine

### Stappen op een Debian / Proxmox LXC

1. Installeer Node.js (sla over als al gedaan):

   ```bash
   apt update && apt install -y curl
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   node --version    # check: v20.x.x
   ```

2. Installeer Claude Code globally:

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

3. Start en authenticeer:

   ```bash
   claude
   ```

   Eerste run vraagt om login. Twee opties:
   - **Claude Pro/Max-account**: er opent een browser-link, log in zoals op claude.ai
   - **API-key**: pak hem op [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key

4. Klaar — typ in elke directory `claude` en je hebt een sessie.

### Stappen op een Windows machine (je desktop)

1. Installeer Node.js van [nodejs.org](https://nodejs.org) (LTS versie)
2. Open PowerShell:

   ```powershell
   npm install -g @anthropic-ai/claude-code
   ```

3. Start in elke project-folder:

   ```powershell
   cd C:\pad\naar\je\project
   claude
   ```

### Tips

- Vanaf de Proxmox host kan Claude rechtstreeks `pct` en `zpool` commands draaien
- Op de Docker LXC kan Claude direct docker-compose files genereren, env vars roteren, en logs analyseren
- Voor langere taken: laat de sessie ergens lopen, je kunt altijd `exit` en later `claude --continue`
- **Pas op met permissies**: Claude Code kan files schrijven en commands draaien. Het vraagt vooraf, maar denk twee keer na voor je "allow" kiest op productie-machines.

**Klaar-criterium:** je typt `claude` in een SSH-sessie op je Docker LXC en je krijgt de Claude prompt. Vraag "wat is mijn Linux kernel versie?" en je krijgt antwoord uit de echte `uname -r` output.

---

## Fase 1.5 — Tweede ZFS pool (`tank`, 10 min)

**Doel:** de SATA SSD beschikbaar maken als aparte pool voor backups en bulk data.

### Stappen

1. Identify de SATA SSD:

   ```bash
   lsblk
   ```

   Zoek het apparaat dat NIET je `rpool` draagt (vaak `/dev/sda`).

2. Maak de pool aan:

   ```bash
   zpool create -o ashift=12 tank /dev/sda
   zfs set compression=lz4 tank
   zfs set atime=off tank
   zpool status
   ```

   `compression=lz4` wint zo'n 1.3-2× op tekstuele backups, kost niets aan CPU.
   `atime=off` scheelt schrijfacties op de SSD = langer leven.

3. Registreer in Proxmox UI: **Datacenter → Storage → Add → ZFS**
   - ID: `tank`
   - ZFS Pool: `tank`
   - Content: Disk image, Container, VZDump backup file

**Klaar-criterium:** in Proxmox UI zie je twee storages: `rpool` (NVMe, fast) en `tank` (SATA, big).

---

## Fase 1.6 — Backup vanaf dag 1 (20 min)

**Doel:** zodra je iets waardevols deployt, is er al een backup-target klaar.
Geen "over een paar weken regel ik het wel".

### Stappen

1. In Proxmox UI: **Datacenter → Backup → Add**
   - Schedule: daily 03:00
   - Storage: `tank`
   - Mode: Snapshot
   - Compression: zstd
   - Retention: keep-last 7, keep-daily 14, keep-weekly 4
2. Selectie: alle CTs/VMs (vink "All" aan, of voeg ze handmatig toe als ze er nog niet zijn)

**Optioneel: Proxmox Backup Server.** Voor offsite backups en deduplication kun
je later PBS toevoegen op een tweede machine (Pi, NAS, oude laptop). Dat hoeft
nu nog niet — de lokale backup naar `tank` dekt de meeste rampen al.

**Klaar-criterium:** er staat een Backup Job in de UI, status "enabled".
Volgende ochtend om 03:01 check je dat er een snapshot bestaat in `tank`.

---

## Fase 1.7 — PostgreSQL shared LXC (15 min)

**Doel:** een centrale Postgres die elke toekomstige app kan gebruiken (Immich,
n8n, Nextcloud, Outline...). Dashboard houden we op SQLite — overkill om te migreren.

### Snelste pad: Community Script

Op de Proxmox host:

```bash
bash -c "$(wget -qLO - https://github.com/community-scripts/ProxmoxVE/raw/main/ct/postgresql.sh)"
```

Maakt automatisch een Debian 12 LXC met Postgres 16, `listen_addresses=*`, en
een initial superuser. Het script print credentials onderaan — schrijf op.

### Per app een user + database

Op de Postgres LXC:

```bash
su - postgres
psql

CREATE USER vaultwarden WITH PASSWORD 'gen-via-pwgen';
CREATE DATABASE vaultwarden OWNER vaultwarden;

CREATE USER n8n WITH PASSWORD '...';
CREATE DATABASE n8n OWNER n8n;
\q
```

### Verbinden vanuit een Docker-app

```yaml
services:
  vaultwarden:
    image: vaultwarden/server:latest
    environment:
      DATABASE_URL: postgresql://vaultwarden:<pwd>@<postgres-lxc-ip>:5432/vaultwarden
```

**Klaar-criterium:** vanaf een andere LXC werkt
`psql -h <postgres-ip> -U postgres -c 'SELECT version();'` en geeft Postgres 16.x terug.

---

## Fase 2 — Docker LXC + Homelab dashboard (1 avond, ~1,5 uur)

**Doel:** deze dashboard draait. Je bezoekt 'm vanaf je gewone PC.

### Stappen

1. In Proxmox UI: **Datacenter → homelab → local → CT Templates → debian-12-standard** downloaden
2. **Create LXC** (ID 100):
   - Naam: `docker`
   - Template: Debian 12
   - Disk: 32 GB op `rpool`
   - CPU: 4 cores
   - Memory: 6144 MB, Swap 1024 MB (royaal nu je 16 GB hebt)
   - Network: bridge `vmbr0`, statisch IP
   - **Belangrijk**: na create → Options → Features → vink `nesting` aan (anders draait Docker niet)
3. Start LXC en open een shell:

   ```bash
   pct enter 100
   ```

4. Install Docker:

   ```bash
   apt update && apt install -y curl ca-certificates git
   curl -fsSL https://get.docker.com | sh
   systemctl enable --now docker
   ```

5. Clone en start het dashboard:

   ```bash
   git clone https://github.com/Ombelll/Homelab.git
   cd Homelab
   cp .env.example .env
   sed -i "s|replace-with-a-long-random-string|$(openssl rand -hex 32)|" .env
   docker compose up -d --build
   ```

6. Vind het IP van de LXC:

   ```bash
   ip a
   ```

7. Browser: `http://<lxc-ip>:3000` → `/register` → maak admin account

**Klaar-criterium:** je ziet je eigen Dashboard pagina in de browser, en
`docker ps` toont 1 container die healthy is.

---

## Fase 3 — Tailscale + eerste agent (zaterdagochtend, ~2 uur)

**Doel:** dashboard bereikbaar vanaf je telefoon onderweg, en mini-PC zelf
rapporteert metrics aan zijn eigen dashboard.

> **Uitgewerkt:** zie [`deploy/fase-3-tailscale-agent.md`](../deploy/fase-3-tailscale-agent.md)
> voor de productie-versie met een gehardende systemd-unit en een idempotent
> `install-agent.sh`. De inline unit hieronder is de oorspronkelijke schets
> (draait `npm run start` via `tsx`); gebruik bij voorkeur het script.

### Stappen

1. Tailscale installeren **op de Proxmox host** (niet in de LXC):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   tailscale up --advertise-routes=192.168.1.0/24    # pas aan aan jouw LAN
   ```

2. In Tailscale admin → enable subnet routing voor jouw Proxmox machine
3. Test: vanaf je telefoon (Tailscale aan) → `http://<proxmox-lan-ip>:8006` werkt → en `http://<lxc-lan-ip>:3000` ook
4. Agent installeren op de mini-PC zelf:

   ```bash
   cd /opt
   git clone https://github.com/Ombelll/Homelab.git homelab-agent
   cd homelab-agent/agent
   apt install -y nodejs npm
   npm install
   ```

5. Maak een systemd service voor de agent:

   ```bash
   cat > /etc/systemd/system/homelab-agent.service <<EOF
   [Unit]
   Description=Homelab Agent
   After=network.target

   [Service]
   Environment=DASHBOARD_URL=http://<lxc-ip>:3000
   Environment=AGENT_API_KEY=<de key uit je .env>
   WorkingDirectory=/opt/homelab-agent/agent
   ExecStart=/usr/bin/npm run start
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   EOF
   systemctl daemon-reload
   systemctl enable --now homelab-agent
   ```

6. In dashboard → Servers → je ziet je eigen host binnen 30 sec

**Klaar-criterium:** dashboard bereikbaar via Tailscale vanaf telefoon, en je
ziet realtime CPU/RAM/disk grafiek van de host zelf.

---

## Fase 4 — Reverse proxy + clean URLs (zaterdagmiddag, ~2 uur)

**Doel:** `homelab.<jouw-tailnet>.ts.net` ipv `http://<ip>:3000`, automatische HTTPS.

> **Uitgewerkt:** zie [`deploy/fase-4-traefik-https.md`](../deploy/fase-4-traefik-https.md)
> voor de productie-versie met een Traefik v3-compose, security-headers, een
> dashboard labels-overlay, en HTTPS via Tailscale Serve (of eigen domein +
> Let's Encrypt). De stappen hieronder zijn de oorspronkelijke schets.

### Stappen

1. Voeg Traefik toe als nieuwe service in een `traefik-compose.yml`:

   ```yaml
   services:
     traefik:
       image: traefik:v3
       ports: ["80:80", "443:443"]
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock:ro
         - ./traefik:/etc/traefik
       command:
         - "--providers.docker=true"
         - "--providers.docker.exposedbydefault=false"
         - "--entrypoints.web.address=:80"
         - "--entrypoints.websecure.address=:443"
   ```

2. Tailscale Serve aanzetten op de docker LXC, OF dnsmasq voor `*.lan` resolutie
3. Container labels toevoegen aan je Homelab compose voor Traefik routing
4. Verifieren: `https://homelab.<tailnet>.ts.net` werkt met een geldig TLS-cert

**Klaar-criterium:** één URL, HTTPS, op laptop en telefoon zonder cert warning.

---

## Fase 5 — Echt waardevolle services (week 1)

**Doel:** services die je dagelijks gebruikt. Met 16 GB RAM kun je deze
allemaal in week 1 erbij zetten — geen reden om verdeeld over 4 weken te wachten.

> **Uitgewerkt:** zie [`deploy/fase-5-services.md`](../deploy/fase-5-services.md)
> voor productie-klare composes (AdGuard, Vaultwarden, Watchtower) met
> Traefik-labels, Postgres- en DNS-setup, en het routing-model (`*.lan` via
> AdGuard + tailnet-HTTPS voor Vaultwarden).

| Service | RAM | Database | Waar |
|---|---|---|---|
| Homelab Dashboard | 400 MB | SQLite (al gedaan) | Docker LXC |
| AdGuard Home | 200 MB | ingebouwd | Eigen LXC of Docker |
| Vaultwarden | 80 MB | Postgres LXC | Docker LXC |
| Traefik | 100 MB | n.v.t. | Docker LXC |
| Watchtower | 30 MB | n.v.t. | Docker LXC |

Totaal: ~800 MB. Past ruim in je 6 GB Docker LXC quota, met buffer voor pieken.
Postgres LXC blijft op de gedeelde 2 GB en heeft genoeg ruimte voor 10+ apps.

### Week 2 — Backup pipeline verfijnen

PBS op een tweede machine zetten (Pi, NAS, oude laptop) en daar je `tank`
backups naar pushen. Offsite-equivalent.

---

## Fase 6 — Naar smaak uitbreiden (vanaf maand 2)

Geen volgorde meer — pak waar je behoefte aan hebt. Allemaal kunnen ze je
shared Postgres LXC gebruiken.

- **Home Assistant OS** in een VM (smart home, Zigbee dongles via USB passthrough) — ~2 GB
- **Jellyfin** + arr-stack (media) — 500 MB idle, 1-2 GB tijdens transcoden
- **Immich** (Google Photos vervanging, ML voor face/object detection) — ~600 MB + Postgres
- **Uptime Kuma** (tweede mening op je Homelab dashboard health checks) — 100 MB
- **Forgejo** (eigen Git host) — 150 MB + Postgres
- **Code-server** (VS Code in browser, via Tailscale) — 300 MB
- **n8n** (workflow automation, ipv Zapier) — 250 MB + Postgres
- **Outline** (eigen Notion / wiki) — 200 MB + Postgres + Redis

---

## Beslismomenten waar ik wil dat je terugkomt

Niet alles vooruit beslissen. Wel deze:

| Moment | Vraag |
|---|---|
| Eind Fase 1.7 | Werkt de shared Postgres? Connectie vanaf docker LXC succesvol? |
| Eind Fase 2 | Werkt het dashboard zoals verwacht? Iets dat tegenviel? |
| Eind Fase 3 | Hoe voelt Tailscale? Wil je liever Cloudflare Tunnels of nginx-proxy-manager? |
| Eind Fase 4 | Heb je een eigen domein gekocht of blijf je op `*.ts.net`? |
| Maand 2 | Welke 3 services gebruik je écht dagelijks? Daar bouw je op uit. |

---

## Wanneer extra hardware?

Met 16 GB en dual storage zit je voorlopig goed. Maar als je deze symptomen
krijgt, dan is het tijd:

| Symptoom | Actie |
|---|---|
| RAM altijd > 14 GB gebruikt | Upgrade naar 32 GB (vaak een tweede SODIMM) |
| NVMe > 80% vol | Migreer cold data (media, oude backups) naar `tank` pool |
| `tank` > 80% vol | Externe disk via USB-C OF kleine NAS naast de mini-PC |
| GPU nodig (transcoding, ML) | Niet de mini-PC, dedicated low-power tweede machine |

**Niet** een tweede mini-PC tot je de eerste écht hebt volgepropt. Verspilling
van geld en complexiteit.

---

## Wat ik voor je kan doen vanaf nu

Per fase ben ik beschikbaar voor:

| Fase | Waarmee ik help |
|---|---|
| Fase 1 | Live debuggen als Proxmox install raar doet (boot order, UEFI vs Legacy) |
| Fase 1.4 | Claude Code installatie + authenticatie troubleshooting |
| Fase 1.5/1.6 | ZFS pool tunen, backup retention policies |
| Fase 1.7 | Postgres user/db per app aanmaken, pg_hba.conf scope |
| Fase 2 | Het docker-compose extenden, env vars uitleggen |
| Fase 3 | Systemd unit fine-tunen, Tailscale ACLs configureren |
| Fase 4 | Traefik labels voor je eerste 5 services tegelijk uitschrijven |
| Fase 5+ | Per service een ready-to-go docker-compose.yml snippet + Traefik labels + Postgres user setup |

**Begin met Fase 1 vanavond of dit weekend.** Laat me weten zodra Proxmox
draait — dan ga ik mee de pools opzetten, Postgres LXC bouwen, en dit
dashboard erin krijgen.
