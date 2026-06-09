#!/usr/bin/env bash
# App-side native OIDC wiring for apps that need a runtime command (not just
# compose env). Additive — each app keeps its local login. Idempotent.
#   * Forgejo  (git.lan)       — adds an "authentik" OAuth2 auth source
#   * Nextcloud (nextcloud.lan)— installs user_oidc + registers the provider
#
# Paperless and Immich are handled elsewhere (Paperless: compose env; Immich:
# admin UI — see deploy/fase-10-sso.md). Reads secrets from the host .env.
#
#   bash deploy/services/authentik/configure-oidc-apps.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

AUTH="http://auth.lan/application/o"

# --- Forgejo ---------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx forgejo; then
  if docker exec -u git forgejo forgejo admin auth list 2>/dev/null | grep -qiw authentik; then
    echo "Forgejo: authentik auth source already present"
  else
    docker exec -u git forgejo forgejo admin auth add-oauth \
      --name authentik --provider openidConnect \
      --key forgejo --secret "${AUTHENTIK_FORGEJO_CLIENT_SECRET}" \
      --auto-discover-url "${AUTH}/forgejo/.well-known/openid-configuration" \
      --scopes "openid email profile" \
      && echo "Forgejo: added authentik auth source" \
      || echo "Forgejo: add-oauth failed (check 'forgejo admin auth' syntax for this version)"
  fi
else
  echo "Forgejo: container not running, skipped"
fi

# --- Nextcloud -------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx nextcloud; then
  docker exec -u www-data nextcloud php occ app:install user_oidc 2>/dev/null \
    || docker exec -u www-data nextcloud php occ app:enable user_oidc 2>/dev/null \
    || echo "Nextcloud: user_oidc install/enable returned non-zero (may already be present)"
  docker exec -u www-data nextcloud php occ user_oidc:provider authentik \
    --clientid="nextcloud" --clientsecret="${AUTHENTIK_NEXTCLOUD_CLIENT_SECRET}" \
    --discoveryuri="${AUTH}/nextcloud/.well-known/openid-configuration" \
    --scope="openid email profile" --mapping-uid="preferred_username" \
    && echo "Nextcloud: authentik provider registered" \
    || echo "Nextcloud: user_oidc:provider failed (check occ command for this version)"
else
  echo "Nextcloud: container not running, skipped"
fi

echo "DONE — test each login button in a private window before logging out elsewhere."
