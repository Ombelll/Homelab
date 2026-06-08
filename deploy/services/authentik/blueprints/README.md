# authentik blueprints (homelab)

This directory is bind-mounted into both authentik containers at
`/blueprints/homelab` (read-only) and scanned on boot. Drop `*.yaml` blueprint
files here to declaratively manage authentik objects (providers, applications,
groups) in git.

For this homelab the SSO objects (forward-auth proxy provider + the per-app
OIDC providers) are created by `../configure-sso.sh`, which talks to the REST
API with the bootstrap token. That script introspects the live default-flow IDs
instead of hard-coding slugs, so it stays correct across authentik versions.

Secrets (OIDC client secrets) are never stored here — they live in the host
`.env` and are referenced by the configure script at runtime.
