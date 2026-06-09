#!/usr/bin/env bash
# Configure authentik's SSO objects, reproducibly, via the Django ORM inside the
# worker container (more robust than poking the REST API + parsing JSON). Reads
# the per-app OIDC client secrets from AUTHENTIK_*_CLIENT_SECRET in the worker
# container env. Idempotent — safe to re-run.
#
# Creates:
#   * a domain-level forward-auth proxy provider + app, bound to the embedded
#     outpost, and points the outpost at http://auth.lan (browser-facing).
#   * OIDC (OAuth2) providers + apps for Immich, Nextcloud, Forgejo, Paperless.
#
#   bash deploy/services/authentik/configure-sso.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

docker exec -i \
  -e AUTHENTIK_IMMICH_CLIENT_SECRET="${AUTHENTIK_IMMICH_CLIENT_SECRET:-}" \
  -e AUTHENTIK_NEXTCLOUD_CLIENT_SECRET="${AUTHENTIK_NEXTCLOUD_CLIENT_SECRET:-}" \
  -e AUTHENTIK_FORGEJO_CLIENT_SECRET="${AUTHENTIK_FORGEJO_CLIENT_SECRET:-}" \
  -e AUTHENTIK_PAPERLESS_CLIENT_SECRET="${AUTHENTIK_PAPERLESS_CLIENT_SECRET:-}" \
  authentik-worker ak shell <<'PY'
import os
from authentik.flows.models import Flow
from authentik.outposts.models import Outpost
from authentik.crypto.models import CertificateKeyPair
from authentik.core.models import Application
from authentik.providers.proxy.models import ProxyProvider, ProxyMode
from authentik.providers.oauth2.models import (
    OAuth2Provider, ClientType, ScopeMapping, RedirectURI, RedirectURIMatchingMode,
)

auth_flow = Flow.objects.get(slug="default-provider-authorization-implicit-consent")
inval_flow = (Flow.objects.filter(slug="default-provider-invalidation-flow").first()
              or Flow.objects.get(slug="default-invalidation-flow"))
signing = CertificateKeyPair.objects.filter(name__icontains="self-signed").first()
scopes = list(ScopeMapping.objects.filter(
    managed__in=[
        "goauthentik.io/providers/oauth2/scope-openid",
        "goauthentik.io/providers/oauth2/scope-email",
        "goauthentik.io/providers/oauth2/scope-profile",
    ]
))

# --- forward-auth (per-app, forward_single) --------------------------------
# NOT domain-level: that needs a shared cookie domain, but browsers reject
# Domain=lan cookies (single-label "TLD"), so the state cookie is dropped and
# the outpost callback 400s. forward_single sets a host-only cookie per app;
# one authentik session still SSO's across all of them (just a quick redirect
# per host). authentik picks the provider by the forwarded Host header, so the
# single Traefik authentik@file middleware covers every app.
FORWARD_APPS = [
    "tools", "logs", "pdf", "search", "speed", "dockge", "prowlarr", "sonarr",
    "radarr", "bazarr", "qb", "requests", "uptime", "home",
]
outpost = Outpost.objects.filter(name__icontains="embedded").first()
fwd_provs = []
for slug in FORWARD_APPS:
    p, _ = ProxyProvider.objects.update_or_create(
        name="fwd-%s" % slug,
        defaults=dict(authorization_flow=auth_flow, invalidation_flow=inval_flow,
                      mode=ProxyMode.FORWARD_SINGLE,
                      external_host="http://%s.lan" % slug),
    )
    Application.objects.update_or_create(
        slug="fwd-%s" % slug, defaults=dict(name="%s (SSO)" % slug, provider=p))
    fwd_provs.append(p)
# Embedded outpost holds exactly these proxy providers (drops the old broken
# domain-level one). OIDC/OAuth2 providers are not outpost providers.
outpost.providers.set(fwd_provs)
cfg = dict(outpost._config)
cfg["authentik_host"] = "http://auth.lan/"
cfg["authentik_host_browser"] = "http://auth.lan/"
outpost._config = cfg
outpost.save()
Application.objects.filter(slug="homelab-forward-auth").delete()
ProxyProvider.objects.filter(name="homelab-forward-auth").delete()
print("FORWARD_AUTH ok (forward_single, %d apps)" % len(fwd_provs))

# --- native OIDC apps ------------------------------------------------------
# client_id is a readable, non-secret string; the secret comes from .env.
OIDC = [
    ("immich",    "Immich",     "AUTHENTIK_IMMICH_CLIENT_SECRET",
     ["http://immich.lan/auth/login", "http://immich.lan/user-settings",
      "app.immich:///oauth-callback"]),
    ("nextcloud", "Nextcloud",  "AUTHENTIK_NEXTCLOUD_CLIENT_SECRET",
     ["http://nextcloud.lan/apps/user_oidc/code"]),
    ("forgejo",   "Forgejo",    "AUTHENTIK_FORGEJO_CLIENT_SECRET",
     ["http://git.lan/user/oauth2/authentik/callback"]),
    ("paperless", "Paperless",  "AUTHENTIK_PAPERLESS_CLIENT_SECRET",
     ["http://paperless.lan/accounts/oidc/authentik/login/callback/"]),
]
for slug, name, secret_env, redirects in OIDC:
    secret = os.environ.get(secret_env)
    if not secret:
        print("SKIP %s (%s not set in env)" % (slug, secret_env))
        continue
    prov, _ = OAuth2Provider.objects.update_or_create(
        name=slug,
        defaults=dict(
            authorization_flow=auth_flow, invalidation_flow=inval_flow,
            client_type=ClientType.CONFIDENTIAL,
            client_id=slug, client_secret=secret, signing_key=signing,
        ),
    )
    # redirect_uris is a property over the _redirect_uris JSON field.
    prov.redirect_uris = [RedirectURI(RedirectURIMatchingMode.STRICT, u) for u in redirects]
    prov.save()
    prov.property_mappings.set(scopes)
    Application.objects.update_or_create(
        slug=slug, defaults=dict(name=name, provider=prov))
    print("OIDC %s ok (issuer=http://auth.lan/application/o/%s/)" % (slug, slug))

print("DONE")
PY
