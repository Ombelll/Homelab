# Fase 10 — Single Sign-On met authentik

One identity provider for the whole homelab: **authentik** at `http://auth.lan`.
Two integration styles:

1. **Forward-auth** (Traefik middleware) — a login gate in front of apps that have
   no good auth of their own. One authentik session unlocks all of them.
2. **Native OIDC** — apps that speak OpenID Connect log you in *as an authentik
   user* (real accounts, groups, avatars): Immich, Nextcloud, Forgejo, Paperless.

Everything authentik-side is code in `deploy/services/authentik/` and is applied
by two idempotent scripts. Secrets live only in the host `/opt/Homelab/.env`.

---

## What got deployed

| Piece | Where |
|-------|-------|
| authentik server + worker + Postgres + Redis | `deploy/services/authentik/docker-compose.yml` |
| Forward-auth Traefik middleware `authentik@file` | `deploy/traefik/dynamic.yml` |
| Secret generation + stack up | `deploy/services/authentik/deploy.sh` |
| akadmin + API token seed | `deploy/services/authentik/bootstrap-admin.sh` |
| Forward-auth provider + OIDC providers | `deploy/services/authentik/configure-sso.sh` |

Deploy / re-run anytime (idempotent):

```bash
cd /opt/Homelab && git pull
bash deploy/services/authentik/deploy.sh          # secrets + stack
bash deploy/services/authentik/configure-sso.sh   # providers + apps
```

> ⚠️ **Traefik file-watch caveat:** changing `deploy/traefik/dynamic.yml` via
> `git pull` swaps the file's inode, which Traefik's watcher misses. After any
> dynamic.yml change run `docker restart traefik`, or routers that reference
> `authentik@file` will 404.

---

## First login (do this once)

1. Browse **http://auth.lan** (needs AdGuard DNS; no Chrome Secure-DNS/DoH).
2. Log in as **`akadmin`** with the password in `/opt/Homelab/.env`
   (`AUTHENTIK_BOOTSTRAP_PASSWORD`).
3. **Change that password** (top-right → Settings) — it was machine-generated.
4. **Create your own user** (Admin → Directory → Users) and add it to the
   *authentik Admins* group, then use that day to day.
5. **Enrol TOTP/passkey** (Settings → MFA Devices) so SSO itself is 2FA-protected.

The static API token `authentik-bootstrap-token` is what `configure-sso.sh` uses.
You may rotate/revoke it after setup; just update `AUTHENTIK_BOOTSTRAP_TOKEN` in
`.env` and re-run the seed if you want it back.

---

## Forward-auth — already live

These hosts now 302-redirect to authentik and require a login:

`tools.lan` · `logs.lan` · `pdf.lan` · `search.lan` · `speed.lan` ·
`dockge.lan` · `prowlarr.lan` · `sonarr.lan` · `radarr.lan` · `bazarr.lan` ·
`qb.lan` · `requests.lan` (Jellyseerr) · `uptime.lan` · `home.lan` (Homepage)

**Deliberately NOT forward-auth'd** (would break non-browser clients — these use
native OIDC or keep their own auth):

| App | Why not forward-auth | SSO instead |
|-----|----------------------|-------------|
| Jellyfin, Immich | phone/TV apps can't follow the redirect | native OIDC |
| Nextcloud | WebDAV/CalDAV/desktop sync | native OIDC |
| Forgejo | `git` over https | native OIDC |
| Paperless | mobile/API | native OIDC |
| n8n | inbound webhooks | own auth (gating breaks hooks) |
| Navidrome, Kavita | Subsonic / e-reader apps | own auth / optional OIDC |
| **Vaultwarden** | Bitwarden clients + it's the vault | **own strong login + 2FA, never gated** |

**Inter-app traffic is unaffected:** Sonarr→qBittorrent, Prowlarr→Sonarr/Radarr
etc. talk over the internal `proxy` network by container name, not via the
`.lan` host, so the gate doesn't touch them. The dashboard `/wan` page likewise
calls `http://speedtest-tracker` internally.

**Double-login on the *arr apps:** they still show their own login behind the
authentik gate. Optional: in each *arr Settings → General → Security set
*Authentication Required = Disabled for Local Addresses*, or Authentication
Method = External, to lean on the authentik gate alone.

To gate another app, append the middleware to its Traefik router label and
recreate it:

```yaml
- "traefik.http.routers.<name>.middlewares=security-headers@file,authentik@file"
```

---

## Native OIDC — finish per app

The authentik providers already exist (run by `configure-sso.sh`). Each app
just needs its side wired up. All use, per app slug `<s>` ∈
{immich, nextcloud, forgejo, paperless}:

- **Discovery URL:** `http://auth.lan/application/o/<s>/.well-known/openid-configuration`
- **Client ID:** `<s>` (e.g. `forgejo`)
- **Client secret:** `AUTHENTIK_<APP>_CLIENT_SECRET` in `/opt/Homelab/.env`
- **Scopes:** `openid email profile`

> OIDC runs over plain HTTP on the LAN here. All four apps below accept that;
> if one ever refuses, front it with Tailscale Serve / HTTPS like the dashboard.

> **Back-channel DNS:** the app containers' DNS doesn't know `*.lan`, so the
> OIDC discovery/token calls to `auth.lan` fail by default. Each OIDC app
> compose therefore has `extra_hosts: ["auth.lan:192.168.1.21"]` (CT101/Traefik).
> Recreate the app after adding it, or discovery 500s with "no such host".

### Forgejo (`git.lan`) — additive, safest
Site Administration → Identity & Access → Authentication Sources → Add Source:
- Type **OAuth2**, Provider **OpenID Connect**, Name **authentik**
  (the name matters — it sets the callback `…/user/oauth2/authentik/callback`).
- Client ID `forgejo`, Secret from `.env`,
  Auto-Discover URL = the discovery URL above.
- Adds a "Sign in with authentik" button. Existing local logins keep working.

### Paperless-ngx (`paperless.lan`) — DONE (compose env)
The OIDC env (`PAPERLESS_APPS`, `PAPERLESS_SOCIALACCOUNT_PROVIDERS`,
`PAPERLESS_SOCIAL_AUTO_SIGNUP`) is in `deploy/services/paperless/docker-compose.yml`.
The login page gains an authentik option; local admin login still works.

### Forgejo + Nextcloud — scripted
Run once (idempotent), after the containers are up:
```bash
bash deploy/services/authentik/configure-oidc-apps.sh
```
- Forgejo: adds an "authentik" OAuth2 auth source (needs the source name to be
  `authentik` so the callback matches).
- Nextcloud: installs the `user_oidc` app and registers the authentik provider.
Both are additive. If a command's syntax differs on your image version, the
script prints which step to do by hand.

### Immich (`immich.lan`) — admin UI, additive
Administration → Settings → **OAuth**:
- Issuer URL = discovery URL above, Client ID `immich`, Secret from `.env`,
  Scope `openid email profile`. Enable; keep password login on as a fallback.

### Nextcloud (`nextcloud.lan`) — user_oidc app
Install the **OpenID Connect user backend** app, then on CT 101:
```bash
docker exec -u www-data nextcloud php occ user_oidc:provider authentik \
  --clientid="nextcloud" --clientsecret="<AUTHENTIK_NEXTCLOUD_CLIENT_SECRET>" \
  --discoveryuri="http://auth.lan/application/o/nextcloud/.well-known/openid-configuration" \
  --scope="openid email profile" --mapping-uid="preferred_username"
```
Adds a "Log in with authentik" button.

After enabling, test each in a private window **before** logging out elsewhere,
so a misconfig can't lock you out.

---

## Recovery

- **Locked out of an app's SSO:** forward-auth apps — remove `,authentik@file`
  from the router label and recreate. OIDC apps — each keeps local login.
- **akadmin password lost:** re-run `bash deploy/services/authentik/bootstrap-admin.sh`
  (re-seeds from `.env`).
- **authentik down:** `docker compose -f deploy/services/authentik/docker-compose.yml logs -f authentik-server`.
  The shipped `system/bootstrap.yaml` is no-op'd on purpose (see
  `system-bootstrap.yaml`) — don't remove that override or the server crash-loops.
