# Mortgage Protection CRM

A small calling CRM that runs on your own computer. It imports your lead spreadsheets, gives you a one-lead-at-a-time calling queue, and records every call and outcome without overwriting history.

**Status: Phase 1 (leads and call history).** You still dial on your phone (Sideline) and log each call here with one keypress. Phase 2 adds calling from the computer through Telnyx. The full plan is in [docs/phase-0-plan.md](docs/phase-0-plan.md).

## What works now

- **Import lead PDFs** (one lead per page). Typed pages are read straight from the page. Scanned cards are read by AI: your Claude account through Claude Code, an Anthropic API key, or a local model (Ollama, LM Studio). Anything missing or uncertain opens in a review window next to the page image, with **OK**, **Discard** and **Cancel**. Cancel keeps the import as a draft to finish later.
- **Import** Excel (.xlsx) or CSV lead sheets. Columns are matched automatically and the match is remembered for next time. Rows with something missing open in the same review window. Rows that were blanked out to take them off the call list are discarded. A Status column becomes call history, dated "on or before" the day the file was saved, because the real time isn't known. Re-importing the same file adds nothing.
- **Lead types and prices** (FE-A to E, editable in Settings). Pick the type per order, and change it for some leads when an order is mixed. Each lead keeps its own price.
- **Counties and area codes**: every lead is grouped by the county it was bought for, taken from the lead page or else the address. Each county is linked to its usual area codes automatically (built in for Indiana, Michigan and Ohio; change them in Settings). Picking an area code means every county under that code, never the lead's own phone number. The same county and area-code choice applies on Calling, Leads, Calls and Today, and typing a 3-digit area code in any search box works the same way.
- **Calling queue**: due callbacks first, then new leads (newest batch first), then retries after the gap you set (4 hours unless you change it). Skip moves a lead to the end for today.
- **Logging a call**: press the outcome key (`1`–`9`, `0`, `H`, `D`) then `Enter`. Each call is its own record with the caller ID you used. Changing an outcome later keeps the earlier one.
- **Dial counter**: dialed twice before giving up? Press `→` (or `>`) for each extra dial and `←` (or `<`) to take one off. It's still one attempt; your numbers count both attempts and dials.
- **Working list**: the Calling page keeps the list you started with. Worked leads stay in it, greyed out, so you see it go down; `↑`/`↓` move through it, and "Refresh list" brings in new leads. Callbacks that come due are added at the top.
- **Undo**: press `Z` within 10 seconds of saving to go back to that lead and pick a different outcome. Older mistakes: "Undo call" in the history. An undone call stays in the history, marked, and stops counting.
- **Dialing from the computer**: `C` copies the number, shows a QR code to scan with your phone (Android or iPhone), or sends the number to your phone with KDE Connect. It also starts a call timer that fills in talk minutes when someone picks up.
- **Today page**: callbacks for the day, in your time and the lead's. A desktop alert and a sound when one comes due.
- **Appointment set** is a call outcome with no date or time. The lead leaves the calling queue. Appointment times and results (sat, sold, no-show) are tracked in Unitrust, not here.
- **Reports**: today or any dates, for the counties or area codes you pick. Activity (dials, attempts, contacts, talks of 2+ minutes, appointments), by hour, best time to call by the lead's local time, by county, by batch (cost per lead reached and booked, from each lead's own price) and against the flier's benchmarks by lead type (booked per contact; edit the targets on the page). Click any number to see the calls or leads behind it. "Export to Excel" saves the whole report.
- **Numbers page**: calls, dials and pick-up rate for each caller ID (today, 7 and 30 days), appointments set from it, a warning before retiring a number you set appointments from, and a reputation checklist with the dates you did each check. The app never switches numbers by itself.
- **Scripts** (`P`) with the lead's name, lender and address filled in, **daily goals** in the top bar, **edit a lead** (`E`) with the old values kept, and **keyboard shortcuts you can change** in Settings.
- **Dead pile**: a do-not-call request moves the lead out of the queue. Everything else goes back into rotation. "Disconnected / invalid" and "wrong person" go to an invalid pile. Both piles can be restored.
- **Duplicates**: leads with the same phone are linked (not merged), so co-borrowers and re-bought leads stay separate. Importing a phone number that's in the dead pile is flagged in the preview.
- **Export** any table to CSV or Excel, or everything as one Excel file or a full JSON dump. Health fields are left out unless you tick the box.
- **Backups** are verified copies of the database. Restore keeps the current database aside instead of deleting it. Once a week the app restores the newest backup into a scratch copy to check it works, and shows the result on Export & backup.

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

### AI for scanned pages

Choose it in **Settings**. The default is **Claude with your Claude account**: install [Claude Code](https://claude.com/claude-code) and sign in once (`claude`), and the app uses it to read each scanned page, which costs a fraction of a cent of your usage per page. Haiku is the default model. API keys for the other options are kept in `<data dir>/secrets.json` (mode 600). They are never shown in the app and never included in exports or backups. The local-model option needs `pdftoppm` (`sudo dnf install poppler-utils`).

### Running by hand (development)

`npm ci && npm run build && npm start` prints a link like `http://127.0.0.1:5170/?t=…`. The link contains your access key, so don't share it. To make a new key, run `npm run cli -- rotate-token` and restart. A copy started this way doesn't update itself.

## Daily use

1. **Import** a batch: Import → pick the lead type → choose the PDF or spreadsheet → (spreadsheet: check the column matches → Continue) → check any leads that need a look → set types for mixed orders → Import.
2. **Numbers**: add your Sideline number once, so each call records which caller ID you used.
3. **Calling**: the current lead's details are in the middle. Press `C` to dial (copy, QR code or KDE Connect, chosen in Settings), call on your phone, press `→` for each extra dial, then press the outcome key and `Enter`. `Enter` saves and moves straight on to the next lead. Callback times start at today's next half hour (tomorrow at 10 AM after the evening cutoff you set in Settings).

These are the starting keys. Change any of them in **Settings → Keyboard shortcuts**.

| Key | Action |
|---|---|
| `↑` / `↓` | Move up or down the list |
| `N` | Next lead you haven't worked yet |
| `S` | Skip this lead for today |
| `/` | Search by name, county, phone or area code |
| `C` | Dial: copy the number, show a QR code, or send it to your phone |
| `→` `>` / `←` `<` | One more / one less dial |
| `Z` | Undo the call you just saved (10 seconds) |
| `A` | Write a note |
| `E` | Edit the lead |
| `P` | Show or hide your script |
| `1`–`9`, `0`, `H`, `D` | Pick an outcome |
| `Enter` | Save the outcome and go to the next lead |
| `Esc` | Cancel |

**KDE Connect** (optional): `sudo dnf install kdeconnectd`, install KDE Connect on your phone, pair them, then pick your phone in Settings → Calling. The phone opens its dialer with the number filled in. If the phone asks which app to use, pick Sideline.

Callbacks ask for a time. Appointment set does not. A do-not-call request asks you to confirm before the lead moves to the dead pile.

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
- Appointment times and outcomes like "sat", "no-show" or "sale" stay in Unitrust, which remains the official record.

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
