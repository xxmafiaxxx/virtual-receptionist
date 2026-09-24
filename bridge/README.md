# Corinne On-Site Bridge

Authenticated, on-site bridge between the practice's databases and the
**Corinne** virtual receptionist app. Two engines, either or both, chosen by
what you fill into `config.json`:

- **Open Dental (MySQL / MariaDB)** — `config.json > mysql`. Forwards the app's
  parameterized queries so every Open Dental feature works from the deployed
  site: patients, appointments, insurance pulls, practice sync, the task
  analyzer, and agent write-backs into the database. Writes are allowed (the
  app edits patients and records call results) — see Security notes.
- **Dentrix (c-treeACE over ODBC)** — `config.json > odbc` + `schema`.
  Read-only patient/appointment lookups.

The bridge runs on a machine inside the practice LAN (ideally the database
server itself) and serves a small token-authenticated JSON API. The Corinne app
connects to it through an outbound-only tunnel — **no router ports are opened**.

```
Corinne (Vercel) ──HTTPS──> tunnel ──> this bridge (LAN) ──> MySQL (Open Dental)
                                                       └──ODBC──> Dentrix c-treeACE
```

Why the bridge exists: the deployed app runs in Vercel's datacenters. `localhost`
and `192.168.x.x` addresses are unreachable from there, so without the bridge the
Open Dental connector only works from a dev server inside the LAN. Local
development keeps working direct — the app only routes through the bridge when a
bridge URL + token are configured (env or the connector form).

## 1. Prerequisites (on the practice machine)

- Windows with network access to the database server(s).
- **Node.js 18+ LTS (64-bit)**: https://nodejs.org — use the 64-bit installer.
- For Dentrix only: the **64-bit FairCom / c-treeACE ODBC driver**. Dentrix
  installs FairCom drivers; check `ODBC Data Sources (64-bit) → Drivers tab`. If
  only a 32-bit driver exists, install the 64-bit FairCom client driver — a
  32-bit driver will not load from 64-bit Node.

## 2. Install

```bat
cd bridge
npm install
```

(If `npm install` tries to compile and fails, install Node 20 LTS — prebuilt
binaries cover it.)

## 3. Configure

```bat
copy config.example.json config.json
```

Fill in:
- `token` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `mysql` (Open Dental) — host/port/user/password/database of the Open Dental
  MySQL / MariaDB server. Remove the block entirely if you only want Dentrix.
- `odbc` + `schema` (Dentrix) — from the probe's output (see below).

`config.json` never leaves this machine. Never commit it.

## 4. Find the Dentrix database — run the probe (Dentrix only)

```bat
node probe.js
:: or with explicit settings:
node probe.js --host 127.0.0.1 --service 5712 --uid ADMIN --pwd ADMIN
```

The probe tries known FairCom/c-tree driver names and the c-treeACE port
(Dentrix is reported to use **5712**; FairCom's own default is 6597). When it
connects it writes **`probe-report.json`** — every table with every column.
Table names matching patient/appointment patterns are flagged.

Send `probe-report.json` back (it contains schema only — no patient data) so the
`schema` section of `config.json` can be filled in.

## 5. Expose to the app (outbound-only tunnel)

**Cloudflare Tunnel (recommended, free):**
```bat
cloudflared tunnel --url http://127.0.0.1:8787
```
Copy the printed `https://<something>.trycloudflare.com` URL into the app
(Admin → Connectors). For a stable URL, create a named tunnel with
`cloudflared tunnel login` + a Cloudflare domain.

**Tailscale alternative:** `tailscale funnel 8787` and use the Funnel URL.

## 6. Run it

```bat
npm start
```

Test locally:
```bat
curl http://127.0.0.1:8787/health
```

Run at startup via Task Scheduler (Action: Start a program, Program:
`node.exe`, Arguments: `bridge.js`, Start in: this folder) or
[nssm](https://nssm.cc) (`nssm install CorinneBridge "C:\...\node.exe" bridge.js`).

## 7. Connect the app

**Open Dental:** Admin dashboard → **Connectors → Open Dental → Configure
connector** — the database host/port/user/password stay as they are (used by
local dev), and fill the **On-site bridge** fields at the bottom with the tunnel
URL and the `token` → **Save configuration** → **Test connection**. The badge
turns green and shows "via bridge" when the tunnel and the database are
reachable. Alternatively set `OPEN_DENTAL_BRIDGE_URL` and
`OPEN_DENTAL_BRIDGE_TOKEN` in the app's environment (Vercel → Settings →
Environment Variables) — that applies site-wide to every admin user.

**Dentrix:** Admin dashboard → **Connectors → Dentrix** → paste the tunnel URL
and the `token` → **Save** → **Test**.

## Endpoints (Bearer token required, except /health)

| Route | Purpose |
|---|---|
| `GET /health` | liveness + per-engine database connectivity (no token required) |
| `POST /od/query` | Open Dental: run one parameterized query `{sql, params}` (app-internal) |
| `GET /od/info` | Open Dental: server version, database, table count |
| `GET /patients?phone=` | Dentrix caller-ID lookup (exact or last-10-digits match) |
| `GET /patients?name=` | Dentrix name search |
| `GET /patients?id=` | Dentrix single patient |
| `GET /patients/:id/appointments` | Dentrix latest appointments for a patient |

## Security notes

- Dentrix side is read-only by construction: every query is a parameterized
  `SELECT` built from `config.json`; there is no endpoint that runs arbitrary
  SQL against c-treeACE.
- The Open Dental `/od/query` endpoint runs whatever SQL the app sends — it has
  to, because the app edits patients and writes call results back. The token
  therefore carries database-level power: keep it long, random, and private,
  rotate it if it leaks, and the tunnel URL with it. You can also point
  `mysql.user` at a least-privilege MySQL account instead of root if you like.
- Stacked statements are rejected (mysql2 `multipleStatements: false`), and
  query bodies are capped at 1 MB.
- The MySQL password lives only in this machine's `config.json` — it is never
  sent to or stored by the app.
