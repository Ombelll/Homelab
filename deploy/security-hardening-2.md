# Security hardening — round 2

Round 1 (done): rpcbind off, `no-new-privileges` + `cap_drop` on containers,
agents on tailnet-HTTPS, scoped Docker socket-proxies, scrypt + rate-limited
login, optional TOTP 2FA.

Round 2 below is **host-side and security-sensitive**, so it is delivered as a
runbook — apply each step deliberately yourself. Two of these (firewall,
fail2ban) can lock you out if done carelessly, so each has a safety net.

---

## 1. Firewall (use the Proxmox firewall, not raw nftables)

On a Proxmox host, use the **built-in Proxmox firewall** — raw `nft`/`iptables`
scripts fight Proxmox's own management and can break CT/VM networking. Default
posture: allow management + Tailscale + established, drop the rest inbound.

### Lockout-safe apply
Proxmox's firewall is **off until you enable it at the datacenter level**, and
even then the **host stays reachable on the LAN by default**. Still, add the
allow-rules *before* flipping it on, and keep a console session open (Proxmox
shell / IPMI) as a fallback.

`/etc/pve/firewall/cluster.fw` (datacenter level):
```ini
[OPTIONS]
enable: 1

[RULES]
# Management + monitoring — restrict source to your LAN + tailnet.
IN ACCEPT -source 192.168.1.0/24 -p tcp -dport 8006 -log nolog  # Proxmox web UI
IN ACCEPT -source 192.168.1.0/24 -p tcp -dport 22   -log nolog  # SSH
IN ACCEPT -source 100.64.0.0/10  -p tcp -dport 8006 -log nolog  # tailnet web UI
IN ACCEPT -source 100.64.0.0/10  -p tcp -dport 22   -log nolog  # tailnet SSH
IN ACCEPT -p udp -dport 41641 -log nolog                        # Tailscale
```
Then per node (`Datacenter → <node> → Firewall → Options`): set the **input
policy to DROP**. Established/related and loopback are allowed automatically.

> Safety net: before setting input policy to DROP, run this on the host so the
> firewall auto-disables in 5 min if you lock yourself out:
> `( sleep 300 && pve-firewall stop && systemctl stop nftables 2>/dev/null ) &`
> If you're still connected after testing, `kill %1` to cancel and it stays on.

CTs (100/101): give each a CT-level firewall in the GUI, or rely on the host —
their services (AdGuard 53, dashboard 3000, Traefik 80/443) are LAN/tailnet
only already.

## 2. fail2ban on SSH (host + CTs)

The dashboard login is already rate-limited in-app (5/min/IP) + optional 2FA,
so the remaining brute-force surface is **SSH**. fail2ban bans an IP after a
few failed SSH logins — low lockout risk (you'd need to fail SSH ~5× yourself).

```sh
apt-get install -y fail2ban
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
maxretry = 5
findtime = 10m
bantime  = 1h
# Never ban your own LAN / tailnet:
ignoreip = 127.0.0.1/8 192.168.1.0/24 100.64.0.0/10
EOF
systemctl enable --now fail2ban
fail2ban-client status sshd
```

## 3. Dashboard login — status (already hardened)
- scrypt password hashing, constant-time compare, user-enumeration-safe timing.
- **Rate limit:** 5 attempts/IP/min on `/api/auth/login` (429 + retry-after).
- **Optional TOTP 2FA** per account (Settings → Account). Recommended: enable it.
- Reached only over the tailnet (Tailscale Serve HTTPS), not the public internet.

No action needed beyond turning on 2FA if you haven't.

## 4. Agent self-update — trust model

The `agent.update` job re-runs `deploy/install-agent.sh`, which does
`git reset --hard origin/main` from the **pinned official repo over HTTPS** and
restarts the agent **as root**. The job payload is empty (`{}`) — it can't
inject a command; it only triggers a pull of *whatever is on `main`*.

So the trust anchors are:
1. **Who can push to `main`.** → Enable **GitHub branch protection** on `main`
   (require PR / restrict pushes) and **2FA on the GitHub account**. This is the
   real mitigation: a forced/compromised push to `main` would otherwise become
   root RCE on every host on the next update.
2. **Who can enqueue the job.** → It requires dashboard **admin** auth (or a
   valid agent key). Keep admin creds behind 2FA; keep agent keys `0600` and
   rotate via Settings → Agent API keys if leaked.
3. **Transport.** → Agents must use the **HTTPS/tailnet** `DASHBOARD_URL` (the
   agent warns on plaintext HTTP) so the key + job can't be sniffed/forged.

## Checklist
- [ ] Proxmox firewall enabled (cluster.fw rules + node input policy DROP)
- [ ] fail2ban on the host and CT 100 / CT 101
- [ ] TOTP 2FA on the dashboard admin account
- [ ] GitHub branch protection on `main` + 2FA on the GitHub account
- [ ] Agent keys `0600`, `DASHBOARD_URL` on tailnet HTTPS
