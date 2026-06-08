#!/usr/bin/env bash
# Deploy authentik (SSO). Generates any MISSING AUTHENTIK_* secrets into the
# host .env (never into git), then pulls + starts the stack. Idempotent — safe
# to re-run; existing secrets are kept, only blanks are filled.
#
#   bash deploy/services/authentik/deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
COMPOSE="$REPO_ROOT/deploy/services/authentik/docker-compose.yml"

touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# set_secret KEY VALUE — write KEY="VALUE" only if KEY is absent/empty in .env.
set_secret() {
  local key="$1" val="$2" cur
  cur="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | sed -E "s/^${key}=//" | tr -d '"' || true)"
  if [ -n "$cur" ]; then
    echo "  $key: kept"
  else
    sed -i -E "/^${key}=/d" "$ENV_FILE"
    printf '%s="%s"\n' "$key" "$val" >> "$ENV_FILE"
    echo "  $key: generated"
  fi
}

echo "== Secrets (host .env, 0600) =="
set_secret AUTHENTIK_TAG                     "2026.5.2"
set_secret AUTHENTIK_SECRET_KEY             "$(openssl rand -base64 60 | tr -d '\n')"
set_secret AUTHENTIK_PG_PASS               "$(openssl rand -hex 32)"
set_secret AUTHENTIK_BOOTSTRAP_PASSWORD    "$(openssl rand -hex 24)"
set_secret AUTHENTIK_BOOTSTRAP_TOKEN       "$(openssl rand -hex 32)"
set_secret AUTHENTIK_BOOTSTRAP_EMAIL       "admin@lan"
set_secret AUTHENTIK_IMMICH_CLIENT_SECRET    "$(openssl rand -hex 32)"
set_secret AUTHENTIK_NEXTCLOUD_CLIENT_SECRET "$(openssl rand -hex 32)"
set_secret AUTHENTIK_FORGEJO_CLIENT_SECRET   "$(openssl rand -hex 32)"
set_secret AUTHENTIK_PAPERLESS_CLIENT_SECRET "$(openssl rand -hex 32)"

echo "== Pull =="
docker compose --env-file "$ENV_FILE" -f "$COMPOSE" pull

echo "== Up =="
docker compose --env-file "$ENV_FILE" -f "$COMPOSE" up -d

echo "== Status (first boot runs DB migrations — give it ~90s to go healthy) =="
docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps

cat <<'EOF'

Next:
  - Wait until authentik-server is healthy, then browse http://auth.lan
    (login: akadmin + AUTHENTIK_BOOTSTRAP_PASSWORD from .env).
  - Run deploy/services/authentik/configure-sso.sh to create the providers.
EOF
