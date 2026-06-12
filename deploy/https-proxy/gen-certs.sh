#!/usr/bin/env bash
# Generate a local-CA TLS certificate for the LAN so every *.lan host is valid
# HTTPS without warnings. Traefik (deploy/traefik) terminates TLS on :443 and
# serves lan.crt as the default certificate (see dynamic.yml tls.stores.default).
#
# Why explicit SANs and not just *.lan? schannel (Windows curl/Chrome) and some
# other clients reject a bare single-label wildcard like *.lan, so each host is
# listed explicitly. The *.lan SAN is kept as a convenience for clients that do
# accept it. Add new hosts to HOSTS below and re-run, then reload Traefik:
#   docker restart traefik
#
# Trust the CA once per device (then *.lan is green):
#   - Linux:   copy certs/ca.crt to /usr/local/share/ca-certificates/ && update-ca-certificates
#   - Windows: Import-Certificate -FilePath ca.crt -CertStoreLocation Cert:\LocalMachine\Root  (admin)
#   - the CA private key (ca.key) never leaves this host and is gitignored.
#
#   bash deploy/https-proxy/gen-certs.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
mkdir -p certs
cd certs

# Every *.lan host Traefik routes (keep in sync with the service router rules),
# plus infra hosts (auth, traefik, dns, adguard).
HOSTS="auth dockge traefik dns adguard home immich jellyfin logs music n8n \
nextcloud paperless pdf prowlarr qb radarr bazarr requests search sonarr \
speed tools uptime git"

# 1. Local CA (created once; reused on subsequent runs so the trust import sticks).
if [[ ! -f ca.key || ! -f ca.crt ]]; then
  openssl req -x509 -newkey rsa:4096 -nodes -keyout ca.key -out ca.crt \
    -days 3650 -sha256 -subj "/CN=Homelab Local CA/O=Homelab"
  echo "Created new CA (certs/ca.crt) — re-import it on your devices."
fi

# 2. Build the SAN list: wildcard + bare lan + one explicit entry per host.
SAN="DNS:*.lan,DNS:lan"
for h in $HOSTS; do SAN="$SAN,DNS:$h.lan"; done

# 3. Leaf key + CSR + CA-signed cert.
openssl req -new -newkey rsa:2048 -nodes -keyout lan.key -out lan.csr \
  -subj "/CN=lan/O=Homelab"
printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
  "$SAN" > lan.ext
openssl x509 -req -in lan.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -sha256 -extfile lan.ext -out lan.crt
rm -f lan.csr lan.ext

# 4. Deploy to Traefik's mounted cert dir.
install -d ../../traefik/certs
cp lan.crt lan.key ../../traefik/certs/

echo "OK — wrote certs/lan.crt (+ key) and copied to deploy/traefik/certs/."
openssl x509 -in lan.crt -noout -ext subjectAltName
