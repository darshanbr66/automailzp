# Deploying ZodiacPatent Attorney Email Automation

This guide moves the app from a single Windows PC to a hosted setup the whole team can use from a browser. **Nothing is deployed automatically.** Every step below is done by you.

| Part | Where | Address |
|---|---|---|
| Frontend (React, static files) | **Vercel** | `https://app.zodiacpatent.com` |
| Backend API (Node/Express) | **Render**, Free Web Service | `https://api.zodiacpatent.com` |
| History, workbook, template, mapping, team activity | **MongoDB Atlas M0 Free** (permanent, shared) | database `automail` |
| Sign-in sessions only | Temporary app folder on Render (no disk) | `backend/data` inside the service |
| Outgoing email | **Resend HTTPS API** (free plan) | `api.resend.com`, sender `vikram@zodiacpatent.com` |
| Access | One **shared team login** | — |

```
Browser ──HTTPS──▶ app.zodiacpatent.com (Vercel: static files only, no secrets)
   │
   └──HTTPS + session cookie──▶ api.zodiacpatent.com (Render Free, 1 instance)
                                   ├── MongoDB Atlas "automail" (permanent, shared)
                                   ├── backend/data  (sessions only; wiped on restart)
                                   └── api.resend.com (HTTPS)
```

**Where secrets live:** the MongoDB connection string, the Resend API key, the login password hash and the session secret exist **only** as Render environment variables. Vercel only knows the public API address. The browser only ever holds an HttpOnly session cookie that JavaScript can't read.

---

## Render Free with MongoDB: what is kept

All shared data lives in **MongoDB Atlas** (free M0 cluster, database `automail`), so restarts, sleep and redeploys don't lose anything except sign-in sessions.

| Data | Kept after a restart, sleep or redeploy? |
|---|---|
| Sending history, uploaded workbook, template, column mapping, team activity, in-flight send claims | **Yes** (MongoDB) |
| Sign-in sessions | No. Team members sign in again after the service restarts or wakes up. |
| Email settings, team login, environment variables | Yes (Render settings) |

- **The server will not start without the database.** `REQUIRE_MONGODB=true` is set in `render.yaml`, and in production the server connects *before* it serves requests. A wrong `MONGODB_URI`, a missing `MONGODB_DB` or `TEAM_MEMBERS`, or Atlas blocking Render all make the deploy **fail with a clear log message**, while the previous version keeps running.
- **Atlas Network Access must allow `0.0.0.0/0`.** Render Free has no fixed outgoing IP address. Access is still protected by the database user's password.
- The page shows a green **"Shared database: automail"** badge. If it says "Local files", MongoDB is not in use.
- The first request after the service has been asleep takes up to about a minute while Render starts it. Interrupted sends are recovered automatically after start-up (see DATABASE-OPERATIONS.md).
- Atlas M0 has no automatic backups: run `npm run db:backup` regularly.

---

## Email sending with Resend

Render Free blocks outgoing SMTP (ports 25, 465 and 587), so the hosted backend sends through the **Resend HTTPS API** instead of Hostinger SMTP. Templates, placeholders, duplicate checks and Sent History work exactly the same. The desktop version keeps using Hostinger SMTP (`EMAIL_PROVIDER=smtp`, the default).

**Free plan:** 3,000 emails a month, at most **100 a day**, no card needed.

**1. Verify zodiacpatent.com in Resend** so emails can be sent as `vikram@zodiacpatent.com`:

1. Resend dashboard → **Domains → Add domain** → `zodiacpatent.com`.
2. In Hostinger hPanel → **DNS Zone**, **add** the records Resend shows. Enter only the part before `.zodiacpatent.com` as the name, and copy the values exactly from Resend:

   | Type | Name | Value | Priority |
   |---|---|---|---|
   | MX | `send` | from Resend (e.g. `feedback-smtp.<region>.amazonses.com`) | 10 (or 20 if 10 is taken) |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` | |
   | TXT | `resend._domainkey` | `p=…` from Resend (case-sensitive) | |

3. Click **Verify** in Resend and wait for **Verified** (minutes to a few hours).

These records only add new names (`send`, `resend._domainkey`). **Don't change or delete the existing MX, SPF, DKIM or DMARC records**: they keep the Hostinger mailboxes working, and replies still arrive in Vikram's Hostinger inbox.

**2. Create an API key:** Resend → **API Keys → Create**, permission **Sending access**. Copy it once into Render as `RESEND_API_KEY`. Never put it in GitHub, Vercel or chat.

**3. Check it:** after deploying, click **Test Email Connection**. It connects to Resend without sending anything. With a sending-only key, it confirms the key is valid but can't read the domain status; check that the domain shows **Verified** in the Resend dashboard, then send one test email to an address you own.

**Delivery protection:** each send carries an idempotency key (its unique send request ID), so if the same send request reaches Resend twice (for example after a connection drop and retry), Resend sends it only once. "Success" in Sent History means Resend accepted the email (it returned an email ID); it doesn't confirm delivery.

---

## Contents

1. [Before you start](#1-before-you-start)
2. [Put the code on GitHub](#2-put-the-code-on-github)
3. [Create the shared team login](#3-create-the-shared-team-login)
4. [Deploy the backend on Render](#4-deploy-the-backend-on-render)
5. [Deploy the frontend on Vercel](#5-deploy-the-frontend-on-vercel)
6. [Custom domains and DNS](#6-custom-domains-and-dns)
7. [Check the deployment](#7-check-the-deployment)
8. [Environment variable reference](#8-environment-variable-reference)
9. [Persistent disk](#9-persistent-disk)
10. [Using the hosted app as a team](#10-using-the-hosted-app-as-a-team)
11. [Day-to-day operations](#11-day-to-day-operations)
12. [Security checklist](#12-security-checklist)
13. [Known limitations](#13-known-limitations)

---

## 1. Before you start

You need:

- A **GitHub** account (a **private** repository is strongly recommended).
- A **Render** account (the Free plan is enough for this setup; see the section above for what that costs you in stored data).
- A **Vercel** account.
- Access to the **DNS settings for zodiacpatent.com** (normally Hostinger hPanel → *Domains* → *DNS / Nameservers*, if Hostinger hosts the domain).
- A free **Resend** account, with zodiacpatent.com verified (see [Email sending with Resend](#email-sending-with-resend)). Render Free blocks SMTP, so Hostinger SMTP is only used by the desktop version.
- Node.js 20.19+ on your PC, to generate the login hash.

---

## 2. Put the code on GitHub

The project folder isn't a Git repository yet.

```bash
cd path\to\auto-email
git init
git add .
git status
```

**Before committing, check that no secrets or data are included.** `.gitignore` already excludes these, but verify:

```bash
git ls-files | findstr /i /r "\.env$ \.xlsx$ \.xls$ data/ sessions"
```

The only expected matches are `backend/.env.example` and `frontend/.env.example`. If you see `backend/.env`, any `.xlsx` file, or anything under `backend/data/` other than `.gitkeep`, stop and fix `.gitignore` first.

```bash
git commit -m "ZodiacPatent attorney email automation"
git branch -M main
git remote add origin https://github.com/<your-account>/zodiacpatent-email.git
git push -u origin main
```

Create the repository on GitHub as **Private** before pushing.

---

## 3. Create the shared team login

On your PC:

```bash
cd backend
npm install          # only needed once
npm run hash-password
```

Type the shared password twice. Nothing appears while you type. Use at least 12 characters; a long passphrase is best. The command prints:

```
APP_PASSWORD_HASH=scrypt:32768:8:1:....:....
```

- Copy the **hash** into Render (step 4). The plain password is never stored anywhere in the project or on Render.
- Share the **password** with the team through a password manager, not by email or chat.
- Choose a username, for example `zodiac-team`. It's not secret, but it's checked as well.
- `SESSION_SECRET` is generated by Render automatically when you use the Blueprint. To make one yourself, run `npm run hash-password -- --secret`.

---

## 4. Deploy the backend on Render

### Option A: Blueprint (recommended)

The repository contains `render.yaml`, which describes the service, its disk and its settings.

1. Render dashboard → **New** → **Blueprint** → connect GitHub and choose the repository.
2. Render reads `render.yaml` and shows the **zodiacpatent-api** web service on the **Free** plan, with no disk.
3. It asks for the values marked `sync: false`:

   | Variable | Value |
   |---|---|
   | `APP_USERNAME` | e.g. `zodiac-team` |
   | `APP_PASSWORD_HASH` | the `scrypt:...` value from step 3 |
   | `RESEND_API_KEY` | your Resend API key (starts with `re_`) |
   | `SMTP_FROM` | `vikram@zodiacpatent.com` (the sender; its domain must be verified in Resend) |

   `EMAIL_PROVIDER=resend` is already set by `render.yaml`. `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURE` are **not** needed on Render.

4. Apply. Render builds (`npm ci --omit=dev` in `backend/`) and starts `node src/server.js`.

### Option B: Manual setup

**New** → **Web Service** → choose the repository, then:

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Node |
| Build Command | `npm ci --omit=dev` |
| Start Command | `node src/server.js` |
| Instance type | **Free** |
| Health Check Path | `/healthz` |
| Auto-Deploy | Off (recommended; see section 11) |

Don't add a disk, and **don't set `DATA_DIR`**. Then add every variable from [section 8](#8-environment-variable-reference) under **Environment**.

> **If the log says `The data folder /var/data is not available`:** `DATA_DIR` is set in the service's Environment (for example from an earlier version of `render.yaml`). Delete the `DATA_DIR` variable and deploy again.

### What to look for in the Render logs

```
[config] WARNING: DATA_DIR is not set, so /opt/render/project/src/backend/data is used. Temporary storage: …
[config] Production mode. Data folder: /opt/render/project/src/backend/data (TEMPORARY)
[config] Team login: required
[config] Allowed frontend origin: https://app.zodiacpatent.com
[config] Sending as vikram@zodiacpatent.com via smtp.hostinger.com:465 (SSL)
Backend listening on 0.0.0.0:10000
```

The server **refuses to start** if something important is wrong, and the log says exactly what. This happens when a login variable is missing, `FRONTEND_URL` isn't `https://`, `ALLOWED_HOSTS` is empty, or `DATA_DIR` is set to a folder that doesn't exist. It never runs without a login.

Check `https://<service-name>.onrender.com/healthz`. It should return `{"ok":true}`.

---

## 5. Deploy the frontend on Vercel

1. Vercel → **Add New… → Project** → import the GitHub repository.
2. **Root Directory: `frontend`**. Vercel detects Vite. `frontend/vercel.json` sets the build command (`npm run build`), the output folder (`dist`) and the security headers.
3. **Environment Variables: none.** In particular, **don't set `VITE_API_BASE_URL` or `VITE_API_URL`**. Delete them if they exist. The app calls `/api/...` on its own address (`https://automailzp.vercel.app`), and the first rewrite in `frontend/vercel.json` forwards those requests to `https://automailzp.onrender.com/api/...`. Never add SMTP or login values to Vercel.
4. **Deploy**.

**Why a proxy:** `automailzp.vercel.app` and `automailzp.onrender.com` count as different sites to browsers, so a login cookie set by Render directly would not be sent back (and is blocked outright by browsers that block third-party cookies). Through the proxy, the browser only ever talks to the Vercel address, and the session cookie is an ordinary first-party cookie for that address.

> Vercel *preview* deployments (other `*.vercel.app` URLs) can load the page but **can't sign in**, because the backend only accepts requests whose Origin is `FRONTEND_URL` (`https://automailzp.vercel.app`). That's intentional.
>
> If you rename the Render service, update the destination in `frontend/vercel.json`. If you rename the Vercel project, update `FRONTEND_URL` and `ALLOWED_HOSTS` on Render.

---

## 6. Custom domains and DNS

Add each domain in its platform first. The platform then shows the exact DNS record to create.

### api.zodiacpatent.com → Render

1. Render → service → **Settings → Custom Domains → Add** → `api.zodiacpatent.com`.
2. At your DNS provider, add the record Render shows. Normally that's:

   | Type | Name / Host | Value / Target |
   |---|---|---|
   | CNAME | `api` | `<service-name>.onrender.com` |

3. Wait until Render shows the domain as **Verified** and the certificate as **Issued**.

### app.zodiacpatent.com → Vercel

1. Vercel → project → **Settings → Domains → Add** → `app.zodiacpatent.com`.
2. Add the record Vercel shows, normally:

   | Type | Name / Host | Value / Target |
   |---|---|---|
   | CNAME | `app` | `cname.vercel-dns.com` (use the exact value Vercel displays) |

3. Wait until Vercel shows **Valid Configuration**.

### Important DNS notes

- **Don't change the existing MX, SPF (TXT), DKIM or DMARC records.** They make the zodiacpatent.com mailboxes work. You're only adding two new CNAME records.
- If the zone has **CAA** records, they must allow the certificate authorities Render and Vercel use (Let's Encrypt, among others), or HTTPS certificates won't be issued.
- DNS changes can take from a few minutes up to 24–48 hours to take effect.
- Both addresses must stay under **zodiacpatent.com**. The login cookie relies on `app.` and `api.` being the same site (see section 12).

---

## 7. Check the deployment

1. `https://api.zodiacpatent.com/healthz` → `{"ok":true}`.
2. `https://api.zodiacpatent.com/api/history` → `401` with "Your session has ended. Please sign in again." This confirms the API is protected.
3. Open `https://app.zodiacpatent.com`. You should see only the homepage with the **Sign in** card. Loading it makes no request to Render (it can stay asleep). When **Login** is clicked, the page first polls `/api/health` (proxied to Render, `{"ok":true,"data":{"ready":true}}`, public, no session), shows "Waking up server…" while Render starts (up to ~90 s, then a Retry button), and only then sends the sign-in request, once.
4. Sign in with the shared username and password.
5. The top bar shows **Sending as <mailbox>**. Click **Test Email Connection**. It must say it connected to Resend and that zodiacpatent.com is verified (no email is sent).
6. Upload a workbook, check the mapping and template, then send **one** test email to an address you own.
7. **Sent History** shows the send. On Render Free this history is temporary (see the top of this guide).
8. **Sign out**, then sign in again.
9. Expect the "Temporary storage" warning at the top of the page. It's correct for Render Free.

---

## 8. Environment variable reference

### Render (backend), all set on the Render service

| Variable | Required | Example / default | Notes |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Turns on production mode: login required, Secure cookies, HSTS, `.env` file ignored. |
| `NODE_VERSION` | Recommended | `20` | Node.js version Render installs (20.19 or newer). |
| `DATA_DIR` | **No (leave unset on Render Free)** | `/var/data` | Only with a persistent disk: set it to the disk's mount path. Unset means the temporary app folder is used. If set, the folder must exist or the server won't start. |
| `FRONTEND_URL` | Yes | `https://app.zodiacpatent.com` | The **only** origin allowed to call the API (exact match, https, no path). |
| `ALLOWED_HOSTS` | Yes | `api.zodiacpatent.com` | Host names the API answers to. Render's own `*.onrender.com` name is added automatically. Comma-separated if several. |
| `TRUST_PROXY` | Recommended | `1` | Number of proxy hops in front of the app, used to find the client IP for login rate limiting. |
| `APP_USERNAME` | Yes | `zodiac-team` | Shared username (not case-sensitive). |
| `APP_PASSWORD_HASH` | Yes | `scrypt:32768:8:1:…` | From `npm run hash-password`. **Never** the plain password. |
| `SESSION_SECRET` | Yes | (random, ≥ 32 characters) | Generated by Render with the Blueprint. Changing it signs everyone out. |
| `SESSION_IDLE_HOURS` | No | `2` | Sign-out after this long without activity. |
| `SESSION_MAX_AGE_HOURS` | No | `12` | Maximum session length, even when active. |
| `EMAIL_PROVIDER` | Yes | `resend` | `resend` = Resend HTTPS API (needed on Render Free). `smtp` = Hostinger SMTP (desktop version; blocked on Render Free). |
| `RESEND_API_KEY` | Yes (Resend) | `re_…` | Resend API key. Secret: Render only, never logged or sent to the browser. |
| `SMTP_FROM` | Yes | `vikram@zodiacpatent.com` | Sender address for both providers. With Resend, its domain must be verified there. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Only for `smtp` | | Hostinger SMTP settings; not used with `EMAIL_PROVIDER=resend`. |
| `PORT` | No | set by Render | Don't set it yourself. |
| `REQUIRE_MONGODB` | Yes | `true` | Refuse to start without MongoDB (never fall back to temporary files). |
| `MONGODB_URI` | Yes | `mongodb+srv://<user>:<password>@<cluster>/?retryWrites=true&w=majority` | Atlas connection string. **Secret**: Render dashboard only; never logged or sent to the browser. |
| `MONGODB_DB` | Yes | `automail` | Database name. Required in production (no default). |
| `TEAM_MEMBERS` | Yes | `Vikram, Vikram2` | Names offered in "Who is using this browser?" (comma-separated). Required in production. |
| `AUDIT_CLIENT_IP_HOPS` | Recommended | `2` | Proxies in front of the backend (Vercel + Render) for the activity log's reported client IP. |
| `ACTIVITY_RETENTION_DAYS` | No | (unset) | Delete team-activity entries older than this many days (minimum 90). Unset keeps them forever. |

### Vercel (frontend)

None. Leave `VITE_API_BASE_URL` (and `VITE_API_URL`) **unset**. The `/api` rewrite in `frontend/vercel.json` does the routing.

On Render, for this free setup: `FRONTEND_URL=https://automailzp.vercel.app`, `ALLOWED_HOSTS=automailzp.onrender.com,automailzp.vercel.app`, `TRUST_PROXY=1`.

**About `TRUST_PROXY=1` behind the Vercel proxy:**
- **Why 1:** the app trusts only Render's own load balancer. That's the only part of the request path that records the address that actually connected and can't be forged. A higher value would make the app believe client-supplied `X-Forwarded-For` entries, and anyone calling the Render URL directly could then fake a new address for every sign-in attempt and get around the per-client limit.
- **Trade-off:** behind Vercel, the "client" the limiter sees is the Vercel edge server forwarding the request, not each person's own address. Team members reaching the same Vercel edge share one counter: 5 wrong passwords there pause sign-in for 15 minutes for everyone on that edge. The overall limit (50 failures per 15 minutes) is unchanged. A restart of the Render service clears the counters.

### Local Windows use (unchanged)

The desktop launcher keeps working as before with `backend\.env`. Without `APP_USERNAME`/`APP_PASSWORD_HASH`/`SESSION_SECRET` there, the local app needs no sign-in. It only listens on `127.0.0.1`.

---

## 9. Persistent disk (optional, paid; not used on Render Free)

> On Render Free there is no disk: the same files below are written to the temporary `backend/data` folder and lost on restart (see the top of this guide). This section applies once you add a disk and set `DATA_DIR=/var/data`.

With a disk, everything that must survive restarts and deploys is written under `/var/data`:

```
/var/data/
├── sent-emails.xlsx           sending history (Excel)
├── sent-emails-pending.json   history rows waiting to be written to the workbook
├── template.json              email template
├── settings.json              column mapping
└── sessions/                  one small file per signed-in browser (named by an HMAC, not the cookie)
```

- **Never stored on disk:** the uploaded attorney workbook (kept in memory only), passwords, the Resend API key and SMTP credentials.
- **Deploys never overwrite these files.** The app only creates them when they're first needed, and nothing in the build writes to `/var/data`. The source folder (`/opt/render/project/src`) is replaced on every deploy, so nothing persistent is kept there.
- **Missing disk:** the server stops at start-up with a clear message rather than writing to temporary storage.
- **Backups:** Render takes automatic daily snapshots of persistent disks (see *Disks* in the Render dashboard, where you can restore one). For your own copies, download `sent-emails.xlsx` regularly using Render's **Shell** or SSH (`scp`). See Render's documentation on transferring files.
- **Bringing over history from the Windows PC:** if the PC's `backend\data\sent-emails.xlsx` (and `template.json`) should carry over, copy them to `/var/data/` **before the team starts sending from the hosted app**, while the service has no history yet. Don't copy over an existing hosted history file. Duplicate detection only knows about sends recorded in the history file it reads.

---

## 10. Using the hosted app as a team

- **One shared login.** Everyone uses the same username and password; each browser gets its own session. There's no per-person user management.
- **One shared workbook.** The uploaded attorney workbook is shared by everyone signed in. **Uploading a different workbook replaces it for the whole team.** Agree who uploads, and re-check the attorney list after someone else uploads.
- **After a restart or deploy, upload the workbook again.** It's kept in memory only (by design, so attorney data isn't stored on the server). On Render Free the template, column mapping and history are lost too (with a disk they would be kept).
- **Sending is one at a time.** When two people click **Send Email** together, the second waits until the first has finished, including the duplicate check and history write. So the second person always sees the first person's send, and the duplicate warning works across the team.
- **Template edits are shared.** The last person to click **Save Template** wins.
- **Sign out** on shared computers. Sessions end after 2 hours of inactivity or 12 hours in total.

---

## 11. Day-to-day operations

| Task | How |
|---|---|
| **Deploy a new version** | Push to GitHub, then Render → **Manual Deploy**. Vercel deploys the frontend on push. The backend is briefly unavailable during a deploy (services with a disk can't run old and new side by side). Avoid deploying while someone is sending. |
| **Turn on automatic backend deploys** | Set `autoDeploy: true` in `render.yaml` (or Render → Settings → Auto-Deploy). |
| **Change the sender address** | Render → Environment: change `SMTP_FROM` (it must be on a domain verified in Resend), then save. Render restarts the service. Then **Test Email Connection**. History rows keep the sender they were actually sent from. |
| **Change the shared password** | Run `npm run hash-password`, replace `APP_PASSWORD_HASH` on Render, and tell the team. Existing sessions stay valid until they expire. To sign everyone out immediately, also change `SESSION_SECRET`. |
| **Sign everyone out** | Change `SESSION_SECRET` on Render. |
| **Someone is locked out ("Too many failed sign-in attempts")** | Wait 15 minutes, or restart the service. The rate limiter is in memory. |
| **Look at errors** | Render → Logs. Passwords, App Passwords, session IDs and attorney data are never written to the logs. |

---

## 12. Security checklist

**Secrets and configuration**
- [ ] The repository is **private**, and `git ls-files` shows no `.env`, `.xlsx` or `backend/data/*` files.
- [ ] `RESEND_API_KEY`, `APP_PASSWORD_HASH` and `SESSION_SECRET` are set **only** on Render, not on Vercel, not in GitHub, not in chat.
- [ ] The shared password is long (a passphrase of 4+ random words, or 16+ characters) and is shared through a password manager.
- [ ] `SESSION_SECRET` is random and at least 32 characters (Render-generated).
- [ ] Vercel has no environment variables (in particular no `VITE_API_BASE_URL`); `/api` is proxied by `frontend/vercel.json`.

**Network and domains**
- [ ] `FRONTEND_URL` is exactly `https://app.zodiacpatent.com`. CORS allows only this origin, with credentials, never `*`.
- [ ] `ALLOWED_HOSTS` is `api.zodiacpatent.com`. Requests for other host names are refused.
- [ ] Both domains have valid HTTPS certificates. The API sends HSTS. `frontend/vercel.json` sends HSTS, a strict Content-Security-Policy (scripts and styles only from the site itself; API calls only to `api.zodiacpatent.com`), `X-Frame-Options: DENY`, `nosniff` and `no-referrer`.
- [ ] MX/SPF/DKIM/DMARC records for zodiacpatent.com are untouched.

**Login and sessions** (built in; check after deploying)
- [ ] All `/api/*` endpoints except sign-in/sign-out/session status return 401 without a session.
- [ ] The cookie is `__Host-zp_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`. It's only ever sent to `api.zodiacpatent.com`, and JavaScript can't read it. `app.` and `api.` are the same *site*, so the browser includes it on the app's requests. Other websites' requests never carry it.
- [ ] Changes (`POST`/`PUT`/`DELETE`) need the session's CSRF token (`X-CSRF-Token`), the app's custom header, and the exact allowed `Origin`.
- [ ] Sessions expire (2 h idle / 12 h maximum). Sign-out deletes the server-side session. Signing in always issues a new session ID.
- [ ] Sign-in is rate-limited: 5 failures per client per 15 minutes, and 50 failures in total per 15 minutes. The password check is constant-time and always runs, even for a wrong username.
- [ ] The password is stored only as an scrypt hash (N=32768, r=8, p=1, random salt). Session files are named by HMAC-SHA256(SESSION_SECRET, session ID), so the disk contents can't be turned into a valid cookie.

**Operations**
- [ ] Only **one** Render instance (don't scale out).
- [ ] Everyone on the team knows that on Render Free, history and duplicate protection reset on every restart.
- [ ] Health check path is `/healthz`. It reveals nothing beyond OK / not OK.
- [ ] Download a copy of `sent-emails.xlsx` regularly, in addition to Render's disk snapshots.
- [ ] Use a Resend API key with **Sending access** only, and delete/replace it in the Resend dashboard (and change the shared password) when someone leaves the team.

---

## 13. Known limitations

These were considered and deliberately left as they are for a small team, but you should know about them.

1. **Render Free storage is temporary.** History, the saved template, the column mapping and sessions are lost on every restart, sleep or redeploy, and duplicate protection only covers sends since the last restart (see the top of this guide). Free services also sleep when idle and take up to a minute to wake. Render Free blocks outgoing SMTP ports, which is why emails are sent through the Resend HTTPS API.
2. **Not yet tested on real Render/Vercel/DNS.** Everything was tested locally:
   - 71 automated backend tests, including production-mode login, cookies, CSRF, CORS, host checks, session persistence and expiry, rate limiting and team concurrency.
   - Isolated `npm ci` installs of `backend/` and `frontend/` to mimic how Render and Vercel build.
   - An end-to-end browser test with the frontend and API on separate origins of the same site, using production-mode cookies and the Vercel security headers.

   Run the checks in [section 7](#7-check-the-deployment) after the first deploy.
3. **Uploaded workbook is in memory.** It's lost on every restart or deploy and must be uploaded again. It's shared by everyone, so the last upload wins.
4. **Single instance, brief downtime on deploy.** Services with a persistent disk can't do zero-downtime deploys or run several instances. The app's locks (one send at a time, serialized history writes) assume one process.
5. **Sending is serialized.** If the email service is slow or times out (up to about 30 seconds per send with Resend), other team members' sends wait.
6. **Shared login = no per-person audit trail.** The history records the sending *mailbox*, not which team member clicked Send.
7. **Rate limiting is in memory.** It resets on restart. Per-client limits rely on Render passing the real client IP (`TRUST_PROXY=1`). If that ever stops working, all clients share one counter, so 5 wrong attempts would briefly lock out the whole team (safe, but inconvenient).
8. **Session revocation** for everyone at once is done by changing `SESSION_SECRET`. There's no "sign out this one browser remotely".
9. **Hosted history and PC history are separate.** If the Windows desktop version is still used for sending, its `backend\data\sent-emails.xlsx` is a different file, and duplicate detection won't see sends made in the other one. Use one or the other, or copy the history over once (section 9) and stop sending from the PC.
10. **Attorney data now leaves the PC.** When hosted, the uploaded workbook goes to the Render server (in memory) over HTTPS, and history (names, emails, firms) is stored on the Render disk. Make sure this fits your data-handling obligations.
11. **Resend free-plan limits.** 100 emails per day (resets at midnight UTC) and 3,000 per month. Sends above the limit are refused with a clear message and recorded as Failed. Emails sent through Resend do not appear in the Hostinger Webmail Sent folder; the Resend dashboard (Emails) lists them for 30 days, and Sent History is the app's record.
12. **The history workbook can only be downloaded through Render's Shell/SSH.** There's no download button in the app yet.
