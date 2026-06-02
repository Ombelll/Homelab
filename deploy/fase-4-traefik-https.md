# Fase 4 — Traefik reverse proxy + HTTPS (uitgewerkt)

Praktische uitwerking van Fase 4 uit [`deploy-plan.md`](../docs/deploy-plan.md).
Doel: één URL met geldige HTTPS (geen cert-warning op laptop én telefoon) i.p.v.
`http://192.168.1.21:3000`, en een router waar je later meer services achter hangt.

Artefacten in deze map:

| Bestand | Wat |
|---|---|
| [`traefik/docker-compose.traefik.yml`](traefik/docker-compose.traefik.yml) | Traefik v3-service op de `proxy`-netwerk. |
| [`traefik/traefik.yml`](traefik/traefik.yml) | Statische config (Docker + file provider, web-entrypoint). |
| [`traefik/dynamic.yml`](traefik/dynamic.yml) | Security-headers middleware + optionele Traefik-dashboard router. |
| [`docker-compose.labels.yml`](docker-compose.labels.yml) | Overlay die de dashboard-service Traefik-labels geeft. |

**Architectuur:** Traefik draait in de Docker LXC (CT 101) en routeert op
Host-header naar de containers op het `proxy`-netwerk. Voor geldige HTTPS
off-network zet **Tailscale Serve** zich vóór Traefik (Deel C) — Tailscale
levert automatisch een geldig `*.ts.net`-certificaat. Eigen domein + Let's
Encrypt is het alternatief (Deel D).

> **Volgorde:** Fase 2 (dashboard draait, ✅ op `192.168.1.21:3000`) en Fase 3
> (Tailscale op de host) moeten af zijn.

---

## Deel A — Traefik starten

In de Docker LXC, in de repo:

```bash
# Eenmalig: het gedeelde netwerk waar alle proxied services op zitten.
docker network create proxy

cd deploy/traefik
docker compose -f docker-compose.traefik.yml up -d
docker logs -f traefik     # check: geen errors, "Configuration loaded"
```

Traefik luistert nu op `:80` en ontdekt containers die `traefik.enable=true`
hebben op het `proxy`-netwerk.

---

## Deel B — Dashboard achter Traefik hangen

Zet eerst de routeer-hostname in je `.env` (repo-root). Met Tailscale Serve is
dit de tailnet-naam van de LXC — kijk 'm op met `tailscale status` of in de
admin console; meestal `docker.<jouw-tailnet>.ts.net`:

```bash
echo 'DASHBOARD_HOST=docker.<jouw-tailnet>.ts.net' >> .env
```

Start het dashboard met de labels-overlay erbij (vanuit de repo-root):

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.labels.yml up -d
```

De overlay voegt de service toe aan het `proxy`-netwerk en zet de Traefik-labels
(router op `Host(DASHBOARD_HOST)`, doel-poort 3000, security-headers). De
directe `:3000`-publish op de LXC blijft werken voor LAN-toegang; wil je
alléén via Traefik, haal dan het `ports:`-blok uit `docker-compose.yml`.

**Test op het LAN** (Traefik routeert op Host-header):

```bash
curl -H "Host: docker.<jouw-tailnet>.ts.net" http://192.168.1.21/
```

Je hoort een 200 + de dashboard-HTML terug te krijgen.

---

## Deel C — HTTPS via Tailscale Serve (aanbevolen)

Op de Docker LXC (Tailscale moet hier draaien — installeer 'm in de LXC als dat
nog niet zo is, net als op de host in Fase 3):

```bash
# Proxy tailnet-HTTPS (:443) → Traefik op :80, op de achtergrond, persistent.
tailscale serve --bg --https=443 http://127.0.0.1:80
tailscale serve status      # toont de mapping
```

Tailscale provisiont automatisch een geldig Let's Encrypt-cert voor
`docker.<jouw-tailnet>.ts.net`. Omdat Tailscale TLS afhandelt en doorstuurt
naar Traefik `:80`, blijft het `web`-entrypoint genoeg — geen `:443` op Traefik.

**Klaar-criterium:** op telefoon (Tailscale aan) en laptop open je
`https://docker.<jouw-tailnet>.ts.net` → dashboard, **groen slotje, geen
warning**.

> **Meer services later?** Op één tailnet-node heb je één hostnaam. Opties:
> (1) per service een pad: `tailscale serve --bg --https=443 --set-path=/vault http://127.0.0.1:80`
> en in Traefik een `PathPrefix`-rule; of (2) `.lan`-hostnames op het LAN via
> AdGuard/dnsmasq met Host-rules in Traefik; of (3) een eigen domein → Deel D.

---

## Deel D — Alternatief: eigen domein + Let's Encrypt

Heb je een eigen domein, dan kan Traefik zelf certs uitgeven via een DNS-01
challenge (werkt zonder publiek IP — ideaal achter NAT). In
[`traefik/traefik.yml`](traefik/traefik.yml) en
[`traefik/docker-compose.traefik.yml`](traefik/docker-compose.traefik.yml)
staan de blokken uitge-comment klaar:

1. Uncomment het `websecure`-entrypoint en de `certificatesResolvers.le`-sectie
   in `traefik.yml`; vul je e-mail + DNS-provider in (voorbeeld: Cloudflare).
2. Uncomment `- "443:443"`, het `acme`-volume en `CF_DNS_API_TOKEN` in de
   compose; zet het token in je `.env`.
3. In `docker-compose.labels.yml`: zet de router op `entrypoints=websecure`,
   voeg `tls.certresolver=le` toe, en zet `DASHBOARD_HOST` op je eigen domein.
4. Activeer HSTS in `dynamic.yml` (de `sts*`-regels) nu TLS bij Traefik eindigt.

---

## Security-noot — docker.sock

Traefik mount `/var/run/docker.sock:ro` voor service-discovery. Dat is het
standaard-patroon, maar de socket is root-equivalent: wie Traefik compromitteert,
heeft de host. Read-only beperkt schrijfacties maar niet het lezen van secrets
uit andere containers. Hardening-optie: zet een **socket-proxy**
(`tecnativa/docker-socket-proxy`) ertussen die alleen de `containers`-API
read-only doorlaat, en laat Traefik dáár tegen praten i.p.v. de echte socket.
Voor een homelab achter Tailscale is de kale `:ro`-mount een acceptabel
startpunt; noteer 't als TODO.

## Troubleshooting

| Symptoom | Fix |
|---|---|
| `404 page not found` van Traefik | Host-header matcht geen router. Check `DASHBOARD_HOST` == de naam in de Tailscale Serve-mapping. |
| Dashboard niet gevonden door Traefik | Zit de container op `proxy`? `docker network inspect proxy`. Label `traefik.docker.network=proxy` gezet? |
| `tailscale serve` weigert | Tailscale draait niet in de LXC, of HTTPS-certs staan uit in de admin console (enable HTTPS / MagicDNS). |
| Cert-warning blijft | Je benadert via IP/`.lan`, niet via de `*.ts.net`-naam. Het cert geldt alleen voor de tailnet-hostnaam. |
| 502 Bad Gateway | Doel-poort klopt niet of dashboard-container is down. `docker ps`, `docker logs homelab-dashboard`. |
