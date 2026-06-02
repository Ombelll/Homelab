# Fase 5 — Echt waardevolle services (uitgewerkt)

Praktische uitwerking van Fase 5 uit [`deploy-plan.md`](../docs/deploy-plan.md):
de services die je dagelijks gebruikt, achter de Traefik-proxy uit Fase 4 en op
de gedeelde Postgres uit Fase 1.7. Alles draait in de Docker LXC (CT 101).

Artefacten in [`services/`](services):

| Service | Map | Database | Routing |
|---|---|---|---|
| AdGuard Home | [`services/adguard/`](services/adguard/docker-compose.yml) | ingebouwd | `adguard.lan` + DNS op :53 |
| Vaultwarden | [`services/vaultwarden/`](services/vaultwarden/docker-compose.yml) | Postgres CT 100 | tailnet-HTTPS naam |
| Watchtower | [`services/watchtower/`](services/watchtower/docker-compose.yml) | — | geen (achtergrond) |

> **Volgorde:** doe **AdGuard eerst** — die levert de `*.lan`-DNS waar de
> Host-routing van de andere services op leunt.

---

## Routing-model (belangrijk)

Eén tailnet-node = één `*.ts.net`-hostnaam, dus we splitsen:

- **Intern verkeer (LAN + tailnet):** AdGuard wordt je DNS en rewrite't
  `*.lan` → `192.168.1.21` (de Docker LXC). Traefik routeert dan op Host:
  `http://dashboard.lan`, `http://adguard.lan`. Werkt thuis én via Tailscale
  zodra je AdGuard als global nameserver zet (Deel B). Dit is HTTP binnen je
  vertrouwde netwerk — prima.
- **HTTPS (geldig cert):** Vaultscharden *vereist* HTTPS. Geef daarom de
  tailnet-HTTPS-naam (`docker.<tailnet>.ts.net`, via Tailscale Serve uit Fase 4)
  aan **Vaultwarden**. Het dashboard verhuist dan naar `dashboard.lan` (HTTP).
- **Wil je HTTPS voor álles?** Koop een domein en gebruik het Let's
  Encrypt-wildcardpad uit [`fase-4-traefik-https.md`](fase-4-traefik-https.md)
  Deel D → elke service krijgt `service.home.example.com` met echt TLS.

Zet de hostnamen in je repo-root `.env` (zie [`.env.example`](../.env.example)).

---

## Deel A — Voorbereiding

Het `proxy`-netwerk bestaat al uit Fase 4. Zo niet: `docker network create proxy`.
Zorg dat Traefik draait (`docker ps | grep traefik`).

---

## Deel B — AdGuard Home (DNS + blocking)

```bash
cd deploy/services/adguard
docker compose up -d
```

**First-run wizard** (eenmalig): de wizard luistert op `:3000`. Publiceer 'm
tijdelijk of bereik 'm via Traefik. Snelste: voeg eenmalig
`ports: ["3000:3000"]` toe, open `http://192.168.1.21:3000`, en in de wizard:

- **Admin Web Interface:** poort **3000** (laat staan — Traefik praat hier tegen).
- **DNS server:** poort **53**.
- Maak admin-gebruiker + wachtwoord.

Daarna het tijdelijke `ports`-blok weghalen en `docker compose up -d`. Vanaf nu
bereik je 'm op `http://adguard.lan` (na de DNS-stap hieronder).

**DNS-rewrites** (Settings → DNS rewrites): voeg toe `*.lan` → `192.168.1.21`.
Nu lossen `adguard.lan`, `dashboard.lan`, etc. op naar de Docker LXC, en
Traefik doet de rest op Host-naam.

**AdGuard als netwerk-DNS:**
1. **Thuis:** zet in je router de DNS-server op `192.168.1.21`.
2. **Via Tailscale:** admin console → **DNS** → **Global nameservers** →
   `192.168.1.21`. Nu resolven je `*.lan`-namen ook onderweg.

---

## Deel C — Vaultwarden (wachtwoordmanager)

**1. Database op de Postgres LXC** (CT 100):

```bash
pct enter 100
su - postgres -c psql

CREATE USER vaultwarden WITH PASSWORD 'genereer-met-openssl-rand-hex-16';
CREATE DATABASE vaultwarden OWNER vaultwarden;
\q
```

**2. Admin-token hashen** (niet plain opslaan):

```bash
docker run --rm vaultwarden/server /vaultwarden hash
# kopieer de $argon2id$... output
```

**3. `.env` invullen** (repo-root):

```bash
VAULTWARDEN_DB_PASSWORD=<het db-wachtwoord van stap 1>
VAULTWARDEN_ADMIN_TOKEN='$argon2id$...'        # hash uit stap 2 (single quotes!)
VAULTWARDEN_DOMAIN=https://docker.<tailnet>.ts.net
VAULTWARDEN_HOST=docker.<tailnet>.ts.net
```

**4. Starten:**

```bash
cd deploy/services/vaultwarden
docker compose up -d
```

Tailscale Serve (uit Fase 4) stuurt `https://docker.<tailnet>.ts.net` → Traefik
→ Vaultwarden. Open de URL: je hoort het web-vault met geldig slotje te zien.
Admin-pagina op `/admin` (token uit stap 2). `SIGNUPS_ALLOWED=false` — nodig
jezelf uit via de admin-pagina.

> Het dashboard verhuist hiermee naar `http://dashboard.lan`: zet
> `DASHBOARD_HOST=dashboard.lan` in `.env` en herstart de dashboard-stack.

---

## Deel D — Watchtower (auto-updates)

```bash
cd deploy/services/watchtower
docker compose up -d
```

Watchtower update **alleen** containers met de opt-in-label. Voeg die toe aan
de services die je automatisch wilt bijwerken, bv. in de labels-lijst:

```yaml
- "com.centurylinklabs.watchtower.enable=true"
```

Het draait elke nacht om 04:00 (na de Proxmox-backup van 03:00) en ruimt oude
images op. **Security:** Watchtower heeft schrijftoegang tot Docker nodig, maar
praat hier tegen een eigen scoped `docker-socket-proxy` (alleen container/image
+ POST, geen `exec`/`volumes`/host-info) i.p.v. de rauwe socket — dezelfde lijn
als Traefik in Fase 4.

> Pin kritieke services liever (laat de label weg) en update die met de hand,
> zodat een nachtelijke update je niet verrast.

---

## Troubleshooting

| Symptoom | Fix |
|---|---|
| `*.lan` lost niet op | Client gebruikt AdGuard niet als DNS, of de `*.lan`-rewrite ontbreekt. Test: `nslookup dashboard.lan 192.168.1.21`. |
| Vaultwarden "insecure context" | `DOMAIN` is geen `https://`-URL, of je benadert 'm via HTTP. Vaultwarden eist HTTPS. |
| Vaultwarden start niet | DB-connectie. Check user/db op CT 100 en `VAULTWARDEN_DB_PASSWORD`. `docker logs vaultwarden`. |
| 404 van Traefik | Host-rule matcht niet — `VAULTWARDEN_HOST`/`adguard.lan` ≠ de naam waarop je binnenkomt. |
| Watchtower doet niets | Doel-containers missen de `com.centurylinklabs.watchtower.enable=true` label. |
| Poort 53 al in gebruik in LXC | `systemd-resolved` luistert op :53. Schakel z'n DNS-stub uit (`DNSStubListener=no`) of draai AdGuard in een eigen LXC. |
