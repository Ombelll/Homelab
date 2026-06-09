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

docker exec -i authentik-worker ak shell <<'PY'
import os
from authentik.flows.models import Flow
from authentik.outposts.models import Outpost
from authentik.crypto.models import CertificateKeyPair
from authentik.core.models import Application
from authentik.providers.proxy.models import ProxyProvider, ProxyMode
from authentik.providers.oauth2.models import (
    OAuth2Provider, ClientTypes, ScopeMapping, RedirectURI, RedirectURIMatchingMode,
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

# --- forward-auth (domain level) -------------------------------------------
fwd, created = ProxyProvider.objects.update_or_create(
    name="homelab-forward-auth",
    defaults=dict(authorization_flow=auth_flow, invalidation_flow=inval_flow,
                  mode=ProxyMode.FORWARD_DOMAIN,
                  external_host="http://auth.lan", cookie_domain="lan"),
)
Application.objects.update_or_create(
    slug="homelab-forward-auth",
    defaults=dict(name="Homelab (forward-auth)", provider=fwd))
outpost = Outpost.objects.filter(name__icontains="embedded").first()
outpost.providers.add(fwd)
cfg = dict(outpost._config)
cfg["authentik_host"] = "http://auth.lan/"
cfg["authentik_host_browser"] = "http://auth.lan/"
outpost._config = cfg
outpost.save()
print("FORWARD_AUTH ok (created=%s)" % created)

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
    ruris = [RedirectURI(RedirectURIMatchingMode.STRICT, u) for u in redirects]
    prov, _ = OAuth2Provider.objects.update_or_create(
        name=slug,
        defaults=dict(
            authorization_flow=auth_flow, invalidation_flow=inval_flow,
            client_type=ClientTypes.CONFIDENTIAL,
            client_id=slug, client_secret=secret,
            signing_key=signing, redirect_uris=ruris,
        ),
    )
    prov.property_mappings.set(scopes)
    Application.objects.update_or_create(
        slug=slug, defaults=dict(name=name, provider=prov))
    print("OIDC %s ok (issuer=http://auth.lan/application/o/%s/)" % (slug, slug))

print("DONE")
PY
