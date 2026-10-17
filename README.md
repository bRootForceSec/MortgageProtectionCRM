# Mortgage Protection CRM

A small calling CRM that runs on your own computer. It imports your lead spreadsheets, gives you a one-lead-at-a-time calling queue, and records every call and outcome without overwriting history.

**Status: Phase 1 (leads and call history).** You still dial on your phone (Sideline) and log each call here with one keypress. Phase 2 adds calling from the computer through Telnyx. The full plan is in [docs/phase-0-plan.md](docs/phase-0-plan.md).

## What works now

- **Import** Excel (.xlsx) or CSV lead sheets. Columns are matched automatically and the match is remembered for next time. A preview shows every problem row with the reason before anything is saved. Re-importing the same file adds nothing. Rejected rows are kept in the import record and can be downloaded.
- **Calling queue**: due callbacks first, then past appointments, then new leads (newest batch first), then retries 4 hours after the last attempt. Skip moves a lead to the end for today.
- **Logging a call**: press the outcome key (`1`–`9`, `0`, `H`, `D`) then `Enter`. Each call is its own record with the caller ID you used. Changing an outcome later keeps the earlier one.
- **Dead pile**: a do-not-call request moves the lead out of the queue. Everything else goes back into rotation. "Disconnected / invalid" and "wrong person" go to an invalid pile. Both piles can be restored.
- **Duplicates**: leads with the same phone are linked (not merged), so co-borrowers and re-bought leads stay separate. Importing a phone number that's in the dead pile is flagged in the preview.
- **Export** any table to CSV or Excel, or everything as one Excel file or a full JSON dump. Health fields are left out unless you tick the box.
- **Backups** are verified copies of the database. Restore keeps the current database aside instead of deleting it.

## Setup on Fedora

Install once. After that the app runs in the background and updates itself.

```bash
sudo dnf install nodejs npm git gcc-c++ make python3   # Node 22 or newer
git clone https://github.com/bRootForceSec/MortgageProtectionCRM.git
cd MortgageProtectionCRM
bash scripts/install.sh
```

The script:
- builds the app into `~/.local/share/mpcrm-app`;
- sets it up as a background service that starts when you log in;
- adds **Mortgage Protection CRM** to your app menu, which opens it in your browser.

If you started the app before with `npm start`, stop that copy first (Ctrl+C). Your data carries over. You can delete the cloned folder afterwards.

Your data lives in `~/.local/share/mpcrm/` (database, backups, copies of imported files). Folders are private to your user account (mode 700). Keep your disk encrypted (Fedora's default LUKS option) because the database itself is not encrypted.

### Updates

- The app checks GitHub for a new version every hour. It builds the new version and runs its tests next to the running copy, without touching it.
- When a new version is ready, a bar appears at the top of the app: **Update ready · What's new · Restart now · Later**. The app never restarts while you're working. If you leave the bar, the update installs itself at 3 AM.
- Every update takes a verified backup first. If the new version doesn't start, the app goes back to the previous version and the data as it was just before the update, and tells you so.
- **Export & backup → Version and updates** shows the version you're running and lets you check for updates now.

To remove the app (your data is kept): `bash ~/.local/share/mpcrm-app/repo/scripts/install.sh --uninstall`.

### Settings

Put these in `~/.config/mpcrm/env` (one `NAME=value` per line, mode 600), then run `systemctl --user restart mpcrm`:

| Variable | Default | Meaning |
|---|---|---|
| `MPCRM_DATA_DIR` | `~/.local/share/mpcrm` | Where the database and files live |
| `MPCRM_PORT` | `5170` | Local port (the app only listens on 127.0.0.1) |
| `MPCRM_BACKUP_DIR` | `<data dir>/backups` | Put this on an external drive if you can |
| `MPCRM_BACKUP_KEEP` | `30` | How many backups to keep |
| `MPCRM_BACKUP_AGE_RECIPIENT` | none | An [age](https://github.com/FiloSottile/age) public key; backups are then encrypted |

### Running by hand (development)

`npm ci && npm run build && npm start` prints a link like `http://127.0.0.1:5170/?t=…`. The link contains your access key, so don't share it. To make a new key, run `npm run cli -- rotate-token` and restart. A copy started this way doesn't update itself.

## Daily use

1. **Import** a batch: Import → choose the file → check the column matches → Preview → fill in the batch name and cost → Import.
2. **Numbers**: add your Sideline number once, so each call records which caller ID you used.
3. **Calling**: the current lead's details are in the middle. Press `C` to copy the phone number, dial on your phone, then press the outcome key and `Enter`. Press `N` for the next lead.

| Key | Action |
|---|---|
| `N` | Next lead |
| `S` | Skip this lead for today |
| `/` | Search by name or phone |
| `C` | Copy phone number |
| `A` | Write a note |
| `1`–`9`, `0`, `H`, `D` | Pick an outcome |
| `Enter` | Save the outcome |
| `Esc` | Cancel |

Callbacks and appointments ask for a time. A do-not-call request asks you to confirm before the lead moves to the dead pile.

## Backups and restore

Back up any time from **Export & backup → Back up now**, or with `npm run cli -- backup`.

A backup runs every night at 11:30 PM, and before every update.

Restore (stop the app first):

```bash
systemctl --user stop mpcrm
cd ~/.local/share/mpcrm-app/current
node dist/server/cli.js backups                  # list
node dist/server/cli.js verify-backup <file>     # check it opens and is intact
node dist/server/cli.js restore <file>           # current database is kept as crm.sqlite.pre-restore-…
systemctl --user start mpcrm
```

Other commands (same folder): `node dist/server/cli.js verify` checks that derived lead status matches the call history; `node dist/server/cli.js rebuild` recomputes it.

## How the data is kept

- Every imported row is stored, including rejected ones, with the original cell values.
- Every call is a separate record. Raw call events are append-only.
- Outcomes are separate from calls. Changing an outcome adds a new record that supersedes the old one.
- Lead status (new, retry, callback, appointment, invalid, dead) is calculated from that history and can be rebuilt at any time.
- Appointment outcomes like "sat", "no-show" or "sale" stay on the IMO site, which remains the official record.

## Development

```bash
npm run dev          # API on 5170 with reload, UI on http://127.0.0.1:5173 (open the API's start link once first)
npm test             # unit and integration tests
npm run test:e2e     # builds, then drives the real app in Chromium
npm run typecheck
node scripts/secret-scan.mjs
```

Code layout:

| Path | What |
|---|---|
| `src/server/db/migrations/` | SQL schema, applied in order on start |
| `src/server/domain/` | Import, normalization, queue, call logging, lead status, export. No HTTP in here |
| `src/server/http/` | API routes and local-access security |
| `src/server/backup.ts`, `cli.ts` | Backup, restore, rebuild |
| `scripts/install.sh`, `scripts/mpcrm-update.mjs` | Install, background service, self-update and rollback |
| `src/web/` | React UI |
| `test/` | Unit, integration and end-to-end tests |
