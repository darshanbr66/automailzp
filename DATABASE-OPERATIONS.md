# Database operations (MongoDB)

How the shared MongoDB database is protected, backed up, restored, checked and
migrated. Everything here uses free services only (MongoDB Atlas M0, your own
computer). All commands are run in the `backend` folder on a computer that has
`backend/.env`.

> **Never test a restore against the production database.** Restores only write
> into a new, empty database. The scripts refuse anything else.

---

## 1. Safety rules built into the scripts

- **The connection string is never printed.** A database is shown as a label
  `<database>@<fingerprint>`, for example `zodiacpatent@3f9a1c2e`. The fingerprint
  is a hash of the cluster's host names and the database name. It contains no
  password and no full host name. Error messages are scrubbed as well.
- **No assumed database.** Every script reads `MONGODB_URI` and `MONGODB_DB` from
  `backend/.env`, or from the file named with `--env-file <file>`. `MONGODB_DB`
  must be set explicitly. If it's missing, the scripts stop.
- **Reading is safe; writing needs the exact label.** `db:backup`, `db:verify`,
  `db:reconcile` and a migration dry run only read. A write (`db:restore`,
  `db:migrate --apply`, `db:migrate:rollback --apply`) refuses to run until you
  add `--confirm-target <label>`, using the label it just printed.
- **Production needs a second switch.** `zodiacpatent`, plus any names in
  `MONGODB_PRODUCTION_DBS`, count as production databases. Writing to one also
  requires `--production`. A restore never writes into one at all.
- **A restore never overwrites.** It refuses the app's configured database, any
  production database, the database the backup came from, and any database that
  already holds data. Nothing is ever dropped.
- **Never put a connection string on a command line.** For another cluster, put
  it in an environment variable and pass the variable's name with
  `--target-uri-env NAME`.

Exit codes: `0` OK, `1` failed or problems found, `2` usage, `3` refused by a
safeguard (nothing changed), `4` migration blocked by its preflight checks.

---

## 2. How a send is protected against duplicates

Every send in the app goes through a durable **claim** in `pending_emails`. Only
one claim can exist per attorney and per email address, across every user and
every server process.

| Step | Claim state | If the server or the database fails here |
|---|---|---|
| Checks (history, workbook version) | `claimed` | The provider was never called. The claim is removed and nothing is recorded. |
| Written to MongoDB **before** the provider is called | `sending` | Outcome unknown. Recorded as **Uncertain**. |
| Provider confirmed acceptance (message id stored) | `accepted` | Recorded as **Success**, because the provider confirmed it. |
| Provider confirmed refusal | `failed` | Recorded as **Failed**. |
| Provider's answer unknown | `uncertain` | Recorded as **Uncertain**. |

- The claim is deleted only after the outcome is in `email_history`. If the
  history write fails, the claim stays and keeps blocking that attorney for
  everyone.
- A claim whose server stopped is recovered once its heartbeat is about 2 minutes
  old. Any running server does this, including the restarted one: a few seconds
  after start-up, then every minute. Several servers recovering at once still
  record each send only once, because each claim has a unique history record.
- **Uncertain is never resent automatically,** not even with "Send again". The
  attorney stays blocked until a team member reconciles it (section 3).
- A send is marked Success only with the provider's confirmation. An Uncertain
  record turns into Success or Failed automatically only when the provider's
  own answer arrives late. Every such change is logged with the operator
  "system (automatic recovery)".

---

## 3. Reconciling "Uncertain" sends

1. List them (read-only): `npm run db:reconcile`. The same records appear in the
   app under **Sent History → All send attempts**.
2. Look each one up at the provider:
   - **Resend:** dashboard → **Emails**, search for the recipient. The app's
     request is identified by the idempotency key `zp-send-<request id>`, which
     `db:reconcile` prints.
   - **Hostinger SMTP:** the **Sent** folder in Webmail.
3. In the app, click **Correct…** on the record and choose **It was sent** or
   **It was not sent**, with a reason. The change is audited with your name.
   "Not sent" makes the record **Failed**, and the attorney can then be emailed.
4. If you chose wrongly, click **Correct / undo…** on the record. The send becomes
   Uncertain again. Voids can be undone the same way. Nothing is ever deleted,
   and every change is kept in the record's correction list and in Team Activity.

An Uncertain record can't be voided. Its outcome must be decided instead.

---

## 4. Backup

```
npm run db:backup                         # the app's database (read-only)
npm run db:backup -- --out D:\backups\zp  # choose the folder
```

The backup writes one canonical Extended-JSON file per collection, so ids and
dates restore exactly. It also writes `manifest.json`, which holds counts, SHA-256
checksums, the index definitions and a verification result. Copies of the legacy
files in `backend/data` are included too.

- Back up before every migration, rollback or restore, and regularly (for
  example weekly). Atlas M0 has no automatic backups.
- The backup is consistent when nobody is sending. If the app was in use,
  `changedDuringBackup` names the collections that changed while it ran.
- Backups contain attorney names and addresses. Keep them private, and never
  in the repository (`backend/data/*` is git-ignored).

## 5. Restore (always into a separate database)

```
npm run db:restore -- --from <backup folder> --target-db zodiacpatent_restore_20261118
#   -> verifies the checksums, shows the target label, changes nothing
npm run db:restore -- --from <backup folder> --target-db zodiacpatent_restore_20261118 --confirm-target zodiacpatent_restore_20261118@<fingerprint>
#   -> creates the indexes, inserts every document with its original id, then
#      verifies the counts against the manifest and checks the relationships
```

To restore onto a separate free test cluster, put its connection string in a
variable, for example `MONGODB_RESTORE_URI=...` in a private env file. Then add
`--target-uri-env MONGODB_RESTORE_URI --env-file <that file>`.

**Restore drill.** Run this monthly and after any change to the data layout:

1. `npm run db:backup`
2. `npm run db:restore` into a new `<name>_restore_<date>` database.
3. `npm run db:verify -- --db <name>_restore_<date>`. Expect `Result: OK` and the
   same counts as the backup.
4. Delete the drill database in the Atlas UI when you're done.

**Real recovery.** If production data is damaged or lost:

1. Stop sending. Tell both team members.
2. Restore the latest good backup into a **new** database name, then run
   `db:verify` on it.
3. The owner changes `MONGODB_DB` on Render to the new name and redeploys. The
   old database is left untouched for investigation.
4. Run `npm run db:reconcile` against the new database. Any sends made after the
   backup are missing from it. Check the Resend dashboard for that period, and
   record those sends with **Mark as sent** so they aren't emailed twice.

## 6. Verify

`npm run db:verify` (or `-- --db <name>`, `-- --json`) is read-only. It checks:

- document counts and history by status;
- records without a valid UTC date;
- duplicate claim ids, successful request ids or legacy fingerprints;
- whether the current workbook is complete;
- attorney rows without a workbook;
- activity entries that point to missing history;
- claims still in progress;
- unresolved Uncertain sends.

It exits with code 1 when there are integrity problems.

---

## 7. Production migration (file history → MongoDB)

Production currently runs on Render Free **without a disk**. Its history lives in
a temporary folder that is wiped on every restart, every sleep (after about 15
idle minutes) and every deploy. **Exporting it is therefore the first step, and
it must happen while the service is awake.** Deploying the new version wipes the
old history too.

Don't run this until the owner approves a time. Both team members must agree to
a sending freeze of about 30 minutes.

### 7.1 Before the window

- [ ] Choose the target database name, for example `zodiacpatent`, and set it in
      `backend/.env` as `MONGODB_DB`. Atlas M0 must be reachable from this
      computer (Network Access).
- [ ] Rehearse the whole procedure against a **test** database, using a copy of
      a real export: set `MONGODB_DB=zodiacpatent_rehearsal` in a separate env
      file and pass `--env-file`.
- [ ] Back up the local desktop data folder (`backend/data`), if a desktop
      install is also in use.

### 7.2 In the window

1. **Freeze.** Both team members stop sending and stay signed in.
2. **Export the production history** right away, while Render is awake. Signed
   in to the production site, open `https://<site>/api/history` and save the
   page as `prod-history-<date>.json`. Also click **Export to Excel** in Sent
   History and keep that file.
3. **Record the counts.** Note the number of entries in the JSON
   (`data.entries.length`) and the counts per status shown in Sent History.
   Pending ("Not yet saved") and Uncertain entries are part of the export and
   are migrated unchanged.
4. **Dry run.** This writes nothing:
   ```
   npm run db:migrate -- --history-json prod-history-<date>.json --history-json-timezone UTC --legacy-timezone Asia/Kolkata --report pre-migration.json
   ```
   Check the preflight:
   - row and status counts match step 3;
   - `unreadable` dates and `invalid UTC` values are 0 (unreadable rows block the
     import unless `--allow-unparsable-dates`);
   - rows outside 2015..tomorrow are explained;
   - the fingerprint figures make sense: rows found in both the files and the
     export are counted once, and genuinely repeated identical rows are kept.
5. **Second export.** Export `/api/history` again and compare its count with
   step 3. If it grew, someone sent during the freeze: use the newer export
   (the import is idempotent).
6. **Apply.** This takes a backup first, imports, then verifies:
   ```
   npm run db:migrate -- --history-json prod-history-<date>.json --history-json-timezone UTC --legacy-timezone Asia/Kolkata --apply --confirm-target <label> --production --report post-migration.json
   ```
   Keep the printed **run id** (`mig-...`). Expect `Verification: OK`, with
   every legacy row present and the count after equal to the count before plus
   the rows imported.
7. `npm run db:verify` should print `Result: OK`. `npm run db:reconcile` should
   list exactly the Uncertain rows from the export.
8. **Cut over.** The owner sets `MONGODB_URI`, `MONGODB_DB` and `TEAM_MEMBERS` on
   Render and deploys this version.
9. **Post-migration check.** In the app, the Sent History count per status must
   equal step 3 (plus any desktop rows). Then send one test email to an internal
   address.
10. **End the freeze.**

### 7.3 Rollback

- **Before cutover** (the data is wrong, or verification failed): run
  `npm run db:migrate:rollback -- --run <mig-...>` to see what would be removed,
  then add `--apply --confirm-target <label> --production`. Only rows that this
  run imported are removed, and only if nobody has corrected them since.
  Corrected rows are listed and kept. A template or mapping that the run
  replaced is put back. Records written by the app are never touched. For a
  complete reset, restore the backup taken in step 6 into a new database
  (section 5).
- **After cutover** (the new version misbehaves):
  1. Freeze sending.
  2. Export **Sent History → Export to Excel** from the new version, so sends
     made since cutover are kept.
  3. The owner redeploys the previous commit and removes `MONGODB_URI` from
     Render.
  4. Note that the old version on Render Free keeps its history only until the
     next restart. Duplicate protection then covers only sends made since that
     restart, so check the exported Excel file before every send. Leave the
     MongoDB data in place, so you can switch back without migrating again.

---

## 8. Storage and retention

- Atlas M0 holds 512 MB. Check the size with `npm run db:verify` and the Atlas
  UI. History records are small, about 1 KB each.
- Team activity grows with every action. Set `ACTIVITY_RETENTION_DAYS` (minimum
  90) to remove old activity entries automatically. Sending history is never
  removed automatically.
- Rows from replaced or failed workbook uploads are removed automatically. A
  failed upload never replaces the current workbook.
