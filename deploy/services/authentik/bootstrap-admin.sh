#!/usr/bin/env bash
# Idempotently ensure the akadmin superuser + a static API token exist. Reads
# AUTHENTIK_BOOTSTRAP_* from the authentik-worker container env. This replaces
# the upstream system bootstrap blueprint, which we no-op (see
# system-bootstrap.yaml for the why). Safe to re-run.
#
#   bash deploy/services/authentik/bootstrap-admin.sh
set -euo pipefail

seed() {
  docker exec -i authentik-worker ak shell <<'PY'
import os
from authentik.core.models import User, Group, Token, TokenIntents
g, _ = Group.objects.get_or_create(name="authentik Admins", defaults={"is_superuser": True})
g.is_superuser = True
g.save()
u, _ = User.objects.get_or_create(
    username="akadmin",
    defaults={"name": "authentik Default Admin",
              "email": os.environ.get("AUTHENTIK_BOOTSTRAP_EMAIL", "admin@lan")},
)
u.is_active = True
if os.environ.get("AUTHENTIK_BOOTSTRAP_PASSWORD"):
    u.set_password(os.environ["AUTHENTIK_BOOTSTRAP_PASSWORD"])
u.save()
u.ak_groups.add(g)
if os.environ.get("AUTHENTIK_BOOTSTRAP_TOKEN"):
    t, _ = Token.objects.get_or_create(
        identifier="authentik-bootstrap-token",
        defaults={"intent": TokenIntents.INTENT_API, "user": u, "expiring": False},
    )
    t.key = os.environ["AUTHENTIK_BOOTSTRAP_TOKEN"]
    t.user = u
    t.expiring = False
    t.intent = TokenIntents.INTENT_API
    t.save()
print("OK akadmin superuser=", u.is_superuser)
PY
}

for i in $(seq 1 40); do
  if seed 2>/dev/null | grep -q "OK akadmin"; then
    echo "  akadmin + API token ensured"
    exit 0
  fi
  echo "  waiting for authentik to be ready ($i/40)..."
  sleep 5
done
echo "  WARN: could not seed akadmin (authentik never became ready)" >&2
exit 1
