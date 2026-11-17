# ZodiacPatent – Attorney Email Automation

A small ZodiacPatent web app that runs on your own Windows computer. It lets a team member:

1. Upload an Excel workbook of attorneys.
2. Pick an attorney.
3. Get an email filled in automatically from an editable template.
4. Review and edit the email, then send it from your **ZodiacPatent Hostinger mailbox** (whichever `@zodiacpatent.com` address is set in `backend\.env`) over SMTP.
5. Keep a sending history in a separate Excel workbook, with a warning before anyone is emailed twice.

In the desktop version described here, attorney data stays on your computer. The only thing that leaves it is each email you choose to send, which goes to Hostinger's mail server. Emails are never sent automatically: you always click **Send Email** yourself.

> **Hosted team version:** the same app can also run online for the whole team (frontend on Vercel at `https://app.zodiacpatent.com`, backend on Render at `https://api.zodiacpatent.com`, with one shared team login). See **[DEPLOYMENT.md](DEPLOYMENT.md)**. In the hosted version, uploaded workbooks and the sending history are on the Render server instead of this PC.

---

## Contents

- [Prerequisites](#prerequisites)
- [Hostinger App Password](#hostinger-app-password)
- [Environment configuration (.env)](#environment-configuration-env)
- [Switching the sender mailbox](#switching-the-sender-mailbox)
- [Running the application](#running-the-application)
- [Testing the SMTP connection](#testing-the-smtp-connection)
- [Using the application](#using-the-application)
- [Stopping the application](#stopping-the-application)
- [Files and data](#files-and-data)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

---

## Prerequisites

| What | Notes |
|---|---|
| **Windows 10 or 11** | The scripts are written for Windows. |
| **Node.js 20.19 or newer (LTS)** | Download the LTS installer from <https://nodejs.org> and keep the default options (including "Add to PATH"). |
| **Google Chrome** | The app opens in Chrome. If Chrome isn't installed, your default browser is used instead. |
| **A Hostinger email mailbox** | Emails are sent from this mailbox. You need access to Hostinger hPanel to create an App Password for it. |
| **Internet access** | Needed for sending (outgoing connections to `smtp.hostinger.com` on port 465 must be allowed). During setup the installer also downloads packages from npmjs.com and cdn.sheetjs.com. |

---

## Hostinger App Password

The app logs in to Hostinger's mail server with an **App Password**: a separate password that only works for email programs and can be revoked at any time without changing anything else.

> **Use the App Password only.** Do not put your hPanel (Hostinger account) password or your normal mailbox password into the app.

1. Sign in to **Hostinger hPanel**.
2. Go to **Emails → Mailboxes**.
3. Find the mailbox you will send from (the address you put in `SMTP_USER`) and click the **three dots (⋮)** next to it.
4. Choose **App passwords**.
5. Create a new App Password (give it a name such as `ZodiacPatent Attorney Email`).
6. **Copy the password straight away.** Hostinger may only show it once.
7. Paste it into `backend\.env` as described in the next section. Don't paste it into chat, email or tickets, and don't save it anywhere else.

If the password ever leaks, or a team member leaves, delete it under **App passwords** in hPanel and create a new one.

---

## Environment configuration (.env)

All settings live in **`backend\.env`**. This file is excluded from Git and must never be shared. The password is read only by the backend; it is never sent to the browser, shown in the app, or written to the logs.

`setup.bat` creates `backend\.env` from `backend\.env.example` (only if it doesn't exist yet, so it never overwrites your password). Fill in the ZodiacPatent mailbox you send from. For example, with Vikram's mailbox:

```ini
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=vikram@zodiacpatent.com
SMTP_PASS=
SMTP_FROM=vikram@zodiacpatent.com
```

The sender address is **only** read from this file. Nothing in the source code names a mailbox.

1. Open `backend\.env` in Notepad.
2. Set `SMTP_USER` and `SMTP_FROM` to the mailbox address (both the same).
3. Paste the App Password directly after `SMTP_PASS=` on the same line, with no spaces or quotes:

   ```ini
   SMTP_PASS=<your App Password>
   ```

4. Save the file. If the app is already running, restart it (stop, then start). Settings are only read at start-up.

Values in `backend\.env` always win over any Windows environment variables with the same name.

| Variable | Required | Description |
|---|---|---|
| `SMTP_HOST` | Yes | `smtp.hostinger.com` |
| `SMTP_PORT` | Yes | `465` (SSL). `587` also works, with `SMTP_SECURE=false` (STARTTLS). |
| `SMTP_SECURE` | Yes | `true` for port 465. The app refuses mismatched combinations. |
| `SMTP_USER` | Yes | The full mailbox address you log in as, e.g. `name@zodiacpatent.com`. |
| `SMTP_PASS` | Yes | The Hostinger **App Password**. |
| `SMTP_FROM` | Yes | The sender address shown to recipients and recorded in the history. Keep it the same as `SMTP_USER`; Hostinger rejects other senders. |
| `PORT` | No | Backend port (default `4000`). |
| `FRONTEND_URL` | No | Frontend address (default `http://localhost:5173`). |

---

## Switching the sender mailbox

To move from Darshan's mailbox to Vikram's (or any other ZodiacPatent mailbox), no code changes are needed:

1. In hPanel, create an App Password for **vikram@zodiacpatent.com** (see [Hostinger App Password](#hostinger-app-password)).
2. Stop the app (**Stop ZodiacPatent Attorney Email** on the desktop).
3. Open `backend\.env` in Notepad and change these three lines:

   ```ini
   SMTP_USER=vikram@zodiacpatent.com
   SMTP_PASS=<Vikram's App Password>
   SMTP_FROM=vikram@zodiacpatent.com
   ```

4. Save, then start the app again.
5. Check that the top bar says **Sending as vikram@zodiacpatent.com**, then click **Test Email Connection**.

From then on, emails go out from the new mailbox and the history's **Sender Email** column records it. Earlier history rows keep the sender they were actually sent from, and duplicate detection still covers them. You may want to delete the old App Password in hPanel once it's no longer used.

---

## Running the application

1. **Extract the project** to a permanent folder, for example `C:\Apps\attorney-email-automation`. Don't run it from inside the zip file. The desktop shortcut points to this folder, so don't move it afterwards (or re-create the shortcut if you do).
2. **Run setup.** Double-click **`scripts\setup.bat`**. It checks Node.js, installs everything, and creates `backend\.env`. At the end it offers to create the desktop shortcuts.
3. **Add the App Password** to `backend\.env` as described [above](#environment-configuration-env).
4. **Create the desktop shortcut once** (if you skipped it during setup). Right-click `scripts\create-shortcut.ps1` → **Run with PowerShell**, or run:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
   ```

   This creates two shortcuts: **ZodiacPatent Attorney Email** (start) and **Stop ZodiacPatent Attorney Email**. Shortcuts with the old names are removed if they point to this app.
5. **Double-click "ZodiacPatent Attorney Email"** on the desktop. The backend and frontend start in the background (there are no terminal windows to keep open), and Chrome opens at <http://localhost:5173>.

Then, inside the app:

6. **Click "Test Email Connection"** (top right). See [the next section](#testing-the-smtp-connection).
7. **Upload** the attorney Excel workbook (Compose Email → step 1).
8. **Check the column mapping** (step 2). Choose which columns hold the attorney name and email address (and the registration number, if the workbook has one), then click **Save mapping**.
9. **Set up the email template** on the **Template Settings** page and click **Save Template**.
10. **Select an attorney** in the list (step 3). The list shows 10 attorneys per page; use the search box to find anyone in the whole workbook.
11. **Review and edit** the subject and body (step 4). Check the preview, then click **Send Email**.
12. **Check Sent History** to see every email the mail server accepted.

You can also run `scripts\start.bat` directly instead of using the shortcut.

---

## Testing the SMTP connection

The top bar shows the sender configured in `backend\.env` (for example **Sending as vikram@zodiacpatent.com**) and a coloured dot:

| Dot | Meaning |
|---|---|
| Orange, "Email not configured" | Something is missing in `backend\.env` (for example `SMTP_PASS` is empty). The page lists exactly what. |
| Orange, "Not tested yet" | Settings look complete, but no connection test has run since the app started. |
| Green, "Connection OK" | The app connected to `smtp.hostinger.com` over SSL and logged in with the App Password. |
| Red, "Connection failed" | The last test (or a send) failed. The message explains why. |

**Test Email Connection** connects to Hostinger and logs in, then disconnects. **It does not send an email.** Typical results:

- **"Hostinger rejected the login for <your mailbox>…"**: the App Password is wrong, was pasted with extra spaces, was deleted in hPanel, or you used the hPanel/mailbox password instead. Create a new App Password, paste it into `backend\.env`, restart the app, and test again.
- **"Could not connect to smtp.hostinger.com…"**: no internet, or a firewall/antivirus is blocking port 465.

A successful test proves the login works. To confirm end to end, send one email to an address you own and check that it arrives.

---

## Using the application

### Excel workbook

- Accepted formats: `.xlsx` and `.xls`, up to 10 MB.
- The **first worksheet** is used. Its **first row must contain column headings**.
- Empty rows are skipped. Attorneys are numbered 1, 2, 3… in the order they appear in the workbook (hover over a number to see its Excel row; row 1 of the sheet is the heading row).
- The registration number is optional. Rows without one can be emailed normally.
- Rows with a missing or invalid email address are flagged in the list and can't be sent until you fix the workbook and upload it again.
- The attorney list shows 10 records per page with **Previous / Next** buttons and the total record count. Search (name, registration number, email, firm, city or state) covers the whole workbook, not just the current page.
- The uploaded data is kept in memory only, so upload it again after restarting the app.

### Column mapping

Map these fields to your Excel columns (the app guesses them from common heading names):

- **Attorney Name** (required)
- **Registration Number** (optional): when present, it identifies the attorney for duplicate detection, so it should be unique for each attorney.
- **Recipient Email** (required)
- **Firm Name**, **City**, **State** (optional)

The mapping is saved in `backend\data\settings.json` and reused next time, as long as the workbook has the same column names.

### Template placeholders

Template Settings lets you edit the **Subject**, **Greeting**, **Main message**, **Closing** and **Signature**. The email body is put together in that order. Click a placeholder in the list to insert it at your cursor. The list shows the 8 most common placeholders; click **Show All Placeholders** to see every other Excel column, and **Show Less** to collapse it again.

| Placeholder | Value |
|---|---|
| `{{attorneyName}}` | Mapped Attorney Name column |
| `{{registrationNumber}}` | Mapped Registration Number column. Left empty (no warning) when the attorney has none; a separator left dangling at the end of the subject, such as `–`, is removed. |
| `{{recipientEmail}}` | Mapped Recipient Email column |
| `{{firstName}}`, `{{lastName}}` | The workbook's "First Name" / "Last Name" columns if it has them; otherwise the first and last word of the attorney name (titles such as Mr., Dr. or Adv. are skipped). |
| `{{firmName}}`, `{{city}}`, `{{state}}` | Mapped optional columns |
| Any other column | Its heading in camelCase. For example, "Practice Area" becomes `{{practiceArea}}` and "Bar Council" becomes `{{barCouncil}}`. |

If a placeholder has no value for an attorney, the compose screen warns you. Unknown placeholders are left unchanged so you can spot them in the preview. The template is saved in `backend\data\template.json`.

### Sending and duplicate protection

Each attorney gets a **Record ID** that is stored in the history and used to spot duplicates, including after the app restarts or the workbook is re-uploaded in a different order:

- **With a registration number**, the Record ID is the registration number.
- **Without one**, the Record ID is a fixed code starting with `AUTO-`, calculated from the attorney's name, email address, firm, city and state (ignoring capitals, extra spaces and accents). The same record always gets the same code.

If a record without a registration number changes in the workbook (for example the firm name is corrected), its `AUTO-` code changes too. So for these records the app also checks for earlier emails **to the same address**, and asks before sending rather than treating the record as new.

1. When you click **Send Email**, the app checks the history for the Record ID.
2. If the attorney has been emailed before, it shows the previous sends (date and time, recipient and status) and offers **Cancel** or **Send Again**. If the match is only *possible* (same email address, different record), it says so and offers **Cancel** or **Send Anyway**. Either way you confirm once more before anything is sent.
3. The email is sent as plain text from `SMTP_FROM` through `smtp.hostinger.com` (port 465, SSL), logging in with the App Password.
4. The attempt is written to the history with its real outcome. **Success** is recorded only after Hostinger's server accepts the email for the recipient. Failed sends are recorded as **Failed**, never as successful, and don't count as "already sent".

**"Accepted" is not the same as "delivered".** The server accepting the email means it is queued for delivery. If the address doesn't exist, a bounce message arrives in the mailbox (check it in Hostinger Webmail).

**Sent folder:** emails sent over SMTP are normally **not** copied into the mailbox's Sent folder in Hostinger Webmail. The app's **Sent History** (`sent-emails.xlsx`) is the record of what was sent.

If the connection drops *while* the message is being transmitted, the app can't know whether it went out. It tells you so ("may or may not have been sent") and records it as **Uncertain**. Uncertain sends count as possibly sent, so the duplicate warning appears if you try again; check with the recipient first.

Double-clicks and repeated requests are ignored, so one click sends one email.

### Sent History

The history is kept in **`backend\data\sent-emails.xlsx`**, with these columns: Record ID, Registration Number, Attorney Name, Recipient Email, Firm Name, City, State, Subject, Sent At, Sender Email, Status (Success, Failed or Uncertain) and Send Type (First Send or Resend). Each attempt is added as a new row; earlier rows are never changed. A history file from an earlier version is upgraded automatically: the new columns are added at the end and the existing rows are kept.

The **Sent History** page has two views, both searchable by attorney name or recipient email and shown 10 per page:

- **Attorneys**: one row per attorney already in the history, with registration number, recipient, city/state, first and last send date, how many times they were resent, and the latest status.
- **All send attempts**: every row of the history file, including the subject, sender mailbox, status and send type.

You can also filter by status, send type and date range.

You can open this file in Excel at any time. **Close it before sending.** If Excel has the file open, Windows locks it. In that case the app still sends the email, warns you, keeps the record temporarily in `sent-emails-pending.json`, and adds it to the workbook automatically the next time it can. Pending records still count for duplicate detection.

---

## Stopping the application

Double-click **Stop ZodiacPatent Attorney Email** on the desktop, or run `scripts\stop.bat`. This stops only this app's background processes, never other programs. History files are written safely, so stopping can't damage them.

---

## Files and data

```
attorney-email-automation/
├── backend/
│   ├── src/                 Express server (API, Excel, templates, record IDs, SMTP via Nodemailer)
│   ├── test/                Automated tests (fictional data, mocked SMTP)
│   ├── data/                Local data (excluded from Git):
│   │   ├── sent-emails.xlsx         sending history
│   │   ├── sent-emails-pending.json records waiting to be written to Excel
│   │   ├── template.json            email template
│   │   └── settings.json            column mapping
│   ├── .env                 your settings and App Password (excluded from Git)
│   └── .env.example         template for .env (no password)
├── frontend/                React + Vite user interface
├── scripts/
│   ├── setup.bat            one-time install
│   ├── start.bat            start the app and open Chrome
│   ├── stop.bat             stop the app
│   ├── create-shortcut.ps1  create desktop shortcuts
│   └── launcher.ps1         start/stop logic used by start.bat and stop.bat
└── logs/                    backend and frontend logs (created on first start)
```

Back up `backend\data\sent-emails.xlsx` regularly. It's your record of who has been emailed.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| **"Port 5173 (or 4000) is already used by another program"** | Another program, often another development server, is using the port. Close it and start again. |
| **"Email not configured — see README"** | Open `backend\.env`, check the setting named in the message (usually `SMTP_PASS`), save, then stop and start the app. |
| **"Hostinger rejected the login…"** | Wrong or revoked App Password, or the hPanel/mailbox password was used. Generate a new App Password in hPanel, paste it after `SMTP_PASS=` (no spaces or quotes), restart, and click **Test Email Connection**. Also check `SMTP_USER` is the full address. |
| **"Could not connect to smtp.hostinger.com"** | Check the internet connection. Corporate firewalls and some antivirus programs block outgoing port 465; allow it, or try `SMTP_PORT=587` with `SMTP_SECURE=false`. |
| **"A secure (SSL/TLS) connection … could not be established"** | Use `SMTP_PORT=465` with `SMTP_SECURE=true` (or 587 with `false`). Antivirus "email scanning" can also break SSL. |
| **"Hostinger does not allow sending as …"** | `SMTP_FROM` must be the same mailbox as `SMTP_USER`. |
| **"Hostinger rejected the recipient address"** | The address in the workbook is wrong or doesn't exist. Fix it in Excel and upload again. |
| **"Hostinger temporarily refused the request"** | Usually a sending limit. Wait a few minutes and try again. |
| **"The email may or may not have been sent"** | The connection dropped mid-send. Check with the recipient before trying again. It was not recorded. |
| **"The sending history workbook is damaged"** | Sending pauses so duplicates can't slip through. Restore a backup of `sent-emails.xlsx`, or rename the damaged file to start a new one. |
| **History warning after sending** | Close `sent-emails.xlsx` in Excel. The record is added automatically later. |
| **"Cannot reach the application server"** | The backend isn't running. Double-click the desktop shortcut again. Details are in `logs\backend-error.log`. |
| **The app doesn't start** | Read the message shown, then check the `logs` folder. Run `scripts\stop.bat` and try again. Re-run `setup.bat` if dependencies are missing. |

---

## For developers

```bash
npm run setup            # install backend + frontend dependencies
npm test                 # backend + frontend automated tests (node:test)
npm run test:e2e         # browser tests (headless Chrome, in-memory MongoDB, mocked email)
npm run test:all         # both of the above
npm run check            # backend syntax check
npm run build            # frontend production build
npm run hash-password    # create APP_PASSWORD_HASH for the shared team login (hosted version)
npm run start:backend    # backend only (http://localhost:4000)
npm run start:frontend   # Vite dev server (http://localhost:5173)
```

**Architecture:** React (Vite) frontend → Vite dev proxy (`/api`) → Express backend on `127.0.0.1:4000` → Nodemailer → `smtp.hostinger.com:465` (implicit TLS, minimum TLS 1.2, SMTP AUTH with the App Password).

**API (local only):** `GET /api/smtp/status` returns host, port, SSL flag, user, sender and the last test result (never the password). `POST /api/smtp/test` runs `transporter.verify()` (connect + login, no email). `POST /api/send` sends one email.

**Security measures:**

- **The password stays on the backend.** `SMTP_PASS` is read from `backend\.env` only, kept inside the mailer object, and excluded from every API response and log line. Nothing is stored in browser storage.
- **Encrypted transport.** Port 465 uses SSL from the first byte; on port 587 STARTTLS is required (`requireTLS`). TLS 1.2 or newer, with certificate checking.
- **Local-only API.** The backend listens on `127.0.0.1` only. Host headers are checked (DNS-rebinding protection). State-changing requests need a custom header and an allowed `Origin` (CSRF protection). No CORS is enabled.
- **Message safety.** Plain-text emails only; subjects with line breaks are refused (no header injection); Nodemailer file and URL access are disabled. The recipient is always taken from the uploaded workbook on the server, not from the browser.
- **Uploads and data.** Uploads are checked for extension, file signature and size, and parsed in memory. The attorney workbook is never written to disk. History cells are written as text, so values are never interpreted as formulas.
- **Safe history writes.** History writes are serialized through a mutex and written atomically (temporary file, then rename). Per-record locks and per-request idempotency IDs stop concurrent or repeated clicks from sending twice.

**Tests** use fictional data and a mocked Nodemailer transport; one test runs the real Nodemailer against a tiny fake SMTP server on `127.0.0.1` to check real error handling. They cover:

- Excel parsing and validation, column mapping, placeholder rendering, template save and load
- SMTP configuration validation (missing App Password, SSL/port mismatches, sender mismatch)
- SMTP status and connection test (success, wrong App Password, not configured), with checks that the password never appears in responses
- Sending: SSL options, message contents, Success recorded only after acceptance
- Failure mapping: authentication, rejected recipient/sender, connection failure, interrupted send, temporary and permanent rejections, recorded as Failed (or Uncertain) and never as Success
- Records with and without registration numbers, deterministic `AUTO-` identifiers, duplicate detection by both methods across restarts and re-ordered workbooks, possible-duplicate warnings
- Duplicate detection, confirmed resends as separate rows, idempotent and concurrent sends
- 10-per-page record lists with workbook-wide search and total counts
- Switching the sender mailbox through configuration only (status, message, SMTP login and history all follow `backend\.env`)
- Upgrading an older history workbook without losing rows
- No leftover old branding and no mailbox hard-coded in the source
- History-locked and corrupted-workbook handling
- CSRF and Host checks

No real email is ever sent by the tests, and no connection to Hostinger is made.
