# Corinne Dentrix Bridge

Read-only, on-site bridge between the practice's **Dentrix** database (FairCom
c-treeACE, accessed over ODBC) and the **Corinne** virtual receptionist app.

The bridge runs on a Windows machine inside the practice LAN (ideally the Dentrix
server itself), queries c-treeACE locally through the FairCom ODBC driver, and
serves a small token-authenticated JSON API. The Corinne app connects to it
through an outbound-only tunnel — **no router ports are opened**.

```
Corinne (Vercel) ──HTTPS──> tunnel ──> this bridge (LAN) ──ODBC──> Dentrix c-treeACE
```

## 1. Prerequisites (on the practice machine)

- Windows with network access to the Dentrix database server.
- **Node.js 18+ LTS (64-bit)**: https://nodejs.org — use the 64-bit installer.
- The **64-bit FairCom / c-treeACE ODBC driver**. Dentrix installs FairCom
  drivers; check `ODBC Data Sources (64-bit) → Drivers tab`. If only a 32-bit
  driver exists, install the 64-bit FairCom client driver — a 32-bit driver will
  not load from 64-bit Node.

## 2. Install

```bat
cd bridge
npm install
```

(If `npm install` tries to compile and fails, install Node 20 LTS — prebuilt
binaries cover it.)

## 3. Find the database — run the probe

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

## 4. Configure

```bat
copy config.example.json config.json
```

Fill in:
- `token` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `odbc` — from the probe's connection output (`dsn` **or** `dsnLess`).
- `schema` — real Dentrix table/column names from `probe-report.json`.

`config.json` never leaves this machine. Never commit it.

## 5. Expose to the app (outbound-only tunnel)

**Cloudflare Tunnel (recommended, free):**
```bat
cloudflared tunnel --url http://127.0.0.1:8787
```
Copy the printed `https://<something>.trycloudflare.com` URL into the app
(Admin → Connectors → Dentrix). For a stable URL, create a named tunnel with
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

Admin dashboard → **Connectors → Dentrix** → paste the tunnel URL and the
`token` → **Save** → **Test**. The badge turns green when the bridge and the
database are reachable.

## Endpoints (Bearer token required)

| Route | Purpose |
|---|---|
| `GET /health` | liveness + database connectivity (no token required) |
| `GET /patients?phone=` | caller-ID lookup (exact or last-10-digits match) |
| `GET /patients?name=` | name search |
| `GET /patients?id=` | single patient |
| `GET /patients/:id/appointments` | latest appointments for a patient |

## Security notes

- Read-only by construction: every query is a parameterized `SELECT` built from
  `config.json`; there is no endpoint that runs arbitrary SQL.
- The token is the only credential the tunnel exposes — keep it long and rotate
  if it leaks.
- Accessing the Dentrix database directly is unofficial (see the Dentrix
  Developer Program for the sanctioned route). Queries here are read-only and
  throttled to small result sets.
