# Self-hosting Estimation on Proxmox

Run Estimation on a Proxmox home server and give friends a subdomain to play
on — **without opening any ports on your router**.

Both games in this repo are one clone, so if you already followed the root
[`../DEPLOY.md`](../DEPLOY.md) for Liar's Dice, **most of the work is done**:
the same container, the same Node install, the same Cloudflare Tunnel. You just
add a second service on a second port and a second hostname. Jump to
[Already running Liar's Dice?](#already-running-liars-dice).

Starting from nothing? Follow the root [`../DEPLOY.md`](../DEPLOY.md) sections
1–2 (create the Debian LXC, install Node 20, clone the repo, create the
`liarsdice` service user), then come back here.

The app is tiny and stateless — no database, games live in memory — so a
1-core / 512 MB–1 GB container runs both games comfortably.

---

## 1. Install this app's dependencies

The repo clone at `/opt/liars_dice` already contains this app in its
`estimation/` subdirectory, but each app has its **own** `package.json`, so
dependencies are installed per app:

```bash
cd /opt/liars_dice/estimation
sudo -u liarsdice npm install --omit=dev
```

Smoke test it on its own port:

```bash
sudo -u liarsdice PORT=3001 node server.js &
sleep 1 && curl -s localhost:3001/healthz && echo
kill %1
```

You should see `{"ok":true}`.

---

## 2. Run it as a service

The unit ships in this folder and is already set to port **3001**, so it sits
alongside Liar's Dice on 3000 rather than fighting it for the port:

```bash
cp /opt/liars_dice/estimation/deploy/estimation.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now estimation
systemctl status estimation        # active (running)
journalctl -u estimation -f        # live logs
```

It now starts on boot and restarts if it crashes. On your LAN it's reachable at
`http://<container-ip>:3001`.

---

## 3. Give it a subdomain

You need a domain managed by Cloudflare (free tier is fine). If you already
have a tunnel running, skip to
[Already running Liar's Dice?](#already-running-liars-dice) — **one tunnel
serves both games**, you don't need a second one.

Otherwise install and authenticate `cloudflared` per the root guide's section
4, then:

```bash
cloudflared tunnel create games                # note the printed tunnel UUID
cp /opt/liars_dice/deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml
nano /etc/cloudflared/config.yml               # fill in the UUID + your hostnames
cloudflared tunnel route dns games estimation.example.com
cloudflared service install
systemctl status cloudflared
```

Share **https://estimation.example.com**. Socket.IO works through the tunnel
with no extra config, and **no router ports are open**.

---

## Already running Liar's Dice?

Three steps, and both games share one tunnel and one container:

1. **Install this app's deps and service** — sections 1 and 2 above.
2. **Add an ingress rule** to `/etc/cloudflared/config.yml`. Order matters, and
   the catch-all `http_status:404` must stay **last**:

   ```yaml
   ingress:
     - hostname: liarsdice.example.com
       service: http://localhost:3000
     - hostname: estimation.example.com
       service: http://localhost:3001
     - service: http_status:404
   ```

3. **Route DNS and restart** the tunnel:

   ```bash
   cloudflared tunnel route dns <your-tunnel-name> estimation.example.com
   systemctl restart cloudflared
   ```

Check it end to end with `curl -s https://estimation.example.com/healthz`.

---

## Keeping strangers out

The game has no login, so anyone with the link can join a lobby — though they'd
still need a room code to enter a specific game. To lock the door properly, add
a **Cloudflare Access** policy (Zero Trust dashboard → Access → Applications)
for `estimation.example.com` allowing specific emails or a one-time PIN.

---

## Updating

```bash
cd /opt/liars_dice
sudo -u liarsdice git pull
cd estimation && sudo -u liarsdice npm install --omit=dev
systemctl restart estimation
```

Do updates **between game sessions** — a restart clears in-memory games. If the
pull also touched the root app, `systemctl restart liars-dice` too.

---

## If you'd rather use a reverse proxy

Using Nginx Proxy Manager, Caddy or Traefik on your Proxmox box instead of a
tunnel? Point the subdomain at `<container-ip>:3001` — but **WebSockets must be
enabled** or the game will load and then sit there dead, because Socket.IO
can't upgrade the connection:

- **Nginx Proxy Manager:** tick **Websockets Support** on the proxy host. This
  is the single most common cause of "it loads but nothing happens".
- **Caddy:** `estimation.example.com { reverse_proxy <container-ip>:3001 }` —
  WebSockets work by default, nothing to add.
- **Plain nginx:** in the `location /` block you need

  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  ```

Going this route means forwarding port 443 on your router, which exposes your
home IP — add DDNS if your IP is dynamic, and harden accordingly. The tunnel
avoids all of that.

---

## Notes & limits

- **In-memory state:** a server or container restart ends live games. The
  reconnect token handles dropped *clients*, not a server restart.
- **Two apps, two ports:** 3000 for Liar's Dice, 3001 here. If you change one,
  change it in both the systemd unit and the tunnel ingress.
- **Resources:** trivial — the container mostly idles. Cap its RAM in the
  Proxmox config as a backstop and snapshot after setup.
- **Security:** runs as a non-root user with systemd sandboxing, behind
  Cloudflare (plus Access, if you add it). Keep the box patched
  (`apt upgrade`) and dependencies current (`npm audit`).
