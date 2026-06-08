# Self-hosting on Proxmox

A step-by-step for running Liar's Dice on a Proxmox home server and letting
friends play remotely — **without opening any ports on your router**.

**Plan:** a lightweight Debian LXC running the app under `systemd`, exposed via
a **Cloudflare Tunnel** (free HTTPS, your home IP stays hidden, optional login
gate). Tailscale and LAN-only alternatives are at the bottom.

The app is tiny and stateless (no database; games live in memory), so a
1‑core / 512 MB–1 GB container is plenty.

---

## 1. Create the LXC container

In the Proxmox web UI:

1. **Download a template** (once): *Datacenter → your node → local → CT
   Templates → Templates*, pick **debian-12-standard**. (CLI equivalent:
   `pveam update && pveam available | grep debian-12` then
   `pveam download local debian-12-standard_*_amd64.tar.zst`.)
2. **Create CT** (top-right *Create CT*):
   - Uncheck *Unprivileged container*? **No — leave it unprivileged** (more
     secure; we don't need Docker).
   - Hostname `liarsdice`, set a root password or SSH key.
   - Template: the Debian 12 one.
   - Disk: 8 GB. CPU: 1 core. Memory: 512–1024 MB, Swap 512 MB.
   - Network: bridge `vmbr0`, IPv4 DHCP (or a static IP on your LAN).
3. **Start** the container and open its **Console** (or SSH in).

---

## 2. Install Node.js and the app

Inside the container (as root):

```bash
apt update && apt -y upgrade
apt -y install curl git

# Node.js 20 LTS from NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs
node --version   # should print v20.x

# A dedicated, login-less service user
adduser --system --group --home /opt/liars_dice liarsdice

# Get the code (use your repo; clone the branch or main once merged)
git clone https://github.com/danielpearson90/liars_dice.git /opt/liars_dice
chown -R liarsdice:liarsdice /opt/liars_dice

# Production dependencies only (skips the dev-only test client)
cd /opt/liars_dice
sudo -u liarsdice npm install --omit=dev
```

Quick smoke test:

```bash
sudo -u liarsdice PORT=3000 node server.js &
sleep 1 && curl -s localhost:3000/healthz && echo
kill %1
```

You should see `{"ok":true}`.

---

## 3. Run it as a service

```bash
cp /opt/liars_dice/deploy/liars-dice.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now liars-dice
systemctl status liars-dice        # active (running)
journalctl -u liars-dice -f        # live logs
```

It now starts on boot and restarts if it crashes. At this point it's reachable
on your LAN at `http://<container-ip>:3000`.

---

## 4. Expose to friends with a Cloudflare Tunnel

You'll need a domain managed by Cloudflare (free tier is fine).

```bash
# Install cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared any main" \
  > /etc/apt/sources.list.d/cloudflared.list
apt update && apt -y install cloudflared

# Authenticate (opens a URL to approve in your browser) and create the tunnel
cloudflared tunnel login
cloudflared tunnel create liars-dice      # note the printed tunnel UUID
```

Create `/etc/cloudflared/config.yml` from the example, filling in your UUID and
hostname:

```bash
cp /opt/liars_dice/deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml
nano /etc/cloudflared/config.yml
```

Then point DNS at the tunnel and run it as a service:

```bash
cloudflared tunnel route dns liars-dice liarsdice.example.com
cloudflared service install
systemctl status cloudflared
```

Share **https://liarsdice.example.com** — friends open it in any browser. WebSockets
(Socket.IO) work through the tunnel with no extra config, and **no router ports
are open**.

### Optional: only let your friends in

Add a **Cloudflare Access** policy (Zero Trust dashboard → Access →
Applications) for `liarsdice.example.com` that allows specific emails / a one-time
PIN. Since the game itself has no login, this is a clean way to keep strangers
out of your lobby.

---

## 5. Updating

```bash
cd /opt/liars_dice
sudo -u liarsdice git pull
sudo -u liarsdice npm install --omit=dev
systemctl restart liars-dice
```

Do updates **between game sessions** — a restart clears in-memory games.

---

## Alternatives to Cloudflare

- **Tailscale (most private, no domain needed):** `apt install tailscale &&
  tailscale up`. Have friends install Tailscale and share the node, then they
  reach `http://<tailscale-ip>:3000`. Or `tailscale funnel 3000` for a public
  HTTPS URL without port forwarding.
- **LAN only:** skip steps 4 — everyone on your home network uses
  `http://<container-ip>:3000`.
- **Reverse proxy + port forward (Caddy):** only if you specifically want a
  public site without a tunnel; forward 443, use Caddy for automatic HTTPS, and
  add DDNS if your IP is dynamic. This exposes your IP and an open port, so
  harden accordingly.

---

## Notes & limits

- **In-memory state:** a server (or container) restart ends any live games.
  Reconnect handles dropped *clients*, not a server restart.
- **Resources:** trivial; the container will mostly idle. Cap its RAM in the
  Proxmox config as a backstop and take a snapshot after setup.
- **Security:** runs as a non-root user with systemd sandboxing; behind
  Cloudflare Access (or Tailscale) only invited people can reach it. Keep the
  box patched (`apt upgrade`) and dependencies current (`npm audit`).
