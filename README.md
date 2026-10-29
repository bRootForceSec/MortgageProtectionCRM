# Mortgage Protection CRM

A small calling CRM that runs on your own computer. It imports your lead spreadsheets, gives you a call list you work top to bottom, and records every call and outcome without overwriting history.

**Status: Phase 1 (leads and call history).** You still dial on your phone (Sideline) and log each call here with one keypress. Phase 2 adds calling from the computer through Telnyx. The original plan, written before the code, is in [docs/phase-0-plan.md](docs/phase-0-plan.md).

## What works now

- **Import lead PDFs** (one lead per page). Typed pages are read straight from the page. Scanned cards are read by AI: your Claude account through Claude Code, an Anthropic API key, or a local model (Ollama, LM Studio). Anything missing or uncertain opens in a review window next to the page image, with **OK**, **Discard** and **Cancel**. Cancel keeps the import as a draft to finish later.
- **Import** Excel (.xlsx) or CSV lead sheets. Columns are matched automatically and the match is remembered for next time. Rows with something missing open in the same review window. Rows that were blanked out to take them off the call list are discarded. A Status column becomes call history, dated "on or before" the day the file was saved, because the real time isn't known. Re-importing the same file adds nothing.
- **Bulk import**: pick many files at once, choose a whole folder (subfolders too), or drop them on the Import page. Every PDF and spreadsheet becomes its own batch, named after the file. Complete leads go straight in, leads already imported or repeated across files are skipped, and leads that need a look wait in "Imports to finish", one per file. Scanned PDFs are read two files at a time in the background and carry on after a restart. Very big spreadsheets go in 10,000 rows at a time (one batch per part) so the app stays usable. Spreadsheets whose columns the app can't match are listed at the end: import one on its own to match them once, and the rest with the same layout go in by themselves. At the end you see leads imported, repeats skipped, leads not imported, and what still needs you, file by file. Imported leads are not added to the call list unless you tick the box.
- **Lead types and prices** (FE-A to E, editable in Settings). Pick the type per order, and change it for some leads when an order is mixed. Each lead keeps its own price.
- **Counties and area codes**: every lead is grouped by the county it was bought for, taken from the lead page or else the address. Each county is linked to its usual area codes automatically (built in for Indiana, Michigan and Ohio; change them in Settings). Picking an area code means every county under that code, never the lead's own phone number. The same county and area-code choice applies on Leads, Calls and Callbacks, and typing a 3-digit area code in any search box works the same way.
- **Call list**: the Calling page is a plain list you build. You go top to bottom, and at the end you're done; nothing is added, removed or reordered on its own. Worked leads stay on it, crossed out with their outcome, until you press "Clear worked" (offered when the list is done). `S` moves a lead to the bottom; `×` takes one off. A lead that a no-show, sat no sale or prezi put back goes to the top when you add it, so the rebook call comes first (turn it off in Settings → Calling). "Recent outcomes" under the list shows the last 10 outcomes you set, so you can open one and fix it even after clearing the list.
- **Leads page**: where you choose who to call. Filter by status (never called, tried, callbacks…), batch, county or area code, "last tried 4+ hours ago" and so on; tick leads (or take every match) and add them to the bottom of the call list. Booked, bad-number and dead leads can't be added. Opening a lead shows it full screen like the Calling page, with its PDF page.
- **Imports** go straight onto the call list, in file order (untick the box on the import screen to skip that).
- **Callbacks** (`5`) are for real "call me later" requests. Type the day (`t` today, `m` tomorrow, a weekday like `fri`, or a date like `10/24`) and, if you want, a time (`2`, `2:30`, `10am`; 1 to 7 means PM). The time is the lead's own time, so "call me at 2" from a Central-time lead means 2 PM where they are; the picker shows it in your time too. Leave the time blank for any time that day.
- **Callbacks page**: callbacks you missed, today's, and the next two weeks, in your time and the lead's. They stay off the call list; Open shows the lead on the Calling page beside your list. A desktop alert and a sound when one with a time comes due.
- **Appointment set** is a call outcome with no date or time. Appointment times and results (sat, sold, no-show) are tracked in Unitrust, not here.
- **Reports**: today or any dates, for the counties or area codes you pick. Activity (dials, attempts, contacts, talks of 2+ minutes, appointments), by hour, best time to call by the lead's local time, by county, by batch (cost per lead reached, booked and sold, from each lead's own price, and close rate) and against the flier's benchmarks by lead type (booked per contact, sales, close rate and cost per sale; edit the targets on the page). Click any number to see the calls or leads behind it. Export saves the report as Excel (every section plus one row per call), as a CSV of the calls in those dates for another system, or as JSON (the whole report and every call, with notes on what each number means) for analysis. Exports never include health fields.
- **Numbers page**: calls, dials and pick-up rate for each caller ID (today, 7 and 30 days), appointments set from it, a warning before retiring a number you set appointments from, and a reputation checklist with the dates you did each check. The app never switches numbers by itself.
- **Scripts** (`P`) with the lead's name, lender and address filled in, **daily goals** in the top bar, **edit a lead** (`E`) with the old values kept, and **keyboard shortcuts you can change** in Settings.
- **Recording consent**: tick "I record my calls" in Settings → Scripts, and leads in states that need everyone's consent to record (California, Florida, Michigan, Pennsylvania and others) show a reminder, with your disclosure line above the opener. Off until you record.
- **Dead pile**: when someone asks not to be called, use "Move to dead pile" on the lead page. "Bad number" goes to the bad-numbers pile, unless the lead has another number: then it switches to that number and stays in rotation. Everything else goes back into rotation. Both piles can be restored.
- **Shared numbers**: when leads share a phone number, a bad number or a dead-pile lead rules that number out on all of them, with the reason on each lead. Restoring the lead it came from brings the others back; restoring one of the others brings back just that one.
- **Time zones** come from the lead's state, and from the county where a state has two (Indiana's and Michigan's Central-time counties).
- **Duplicates**: leads with the same phone are linked (not merged), so co-borrowers and re-bought leads stay separate. Importing a phone number that's in the dead pile is flagged in the preview.
- **Export** any table to CSV or Excel, or everything as one Excel file or a full JSON dump. Health fields are left out unless you tick the box.
- **Backups** are verified copies of the database. Restore keeps the current database aside instead of deleting it. Once a week the app restores the newest backup into a scratch copy to check it works, and shows the result on Export & backup.

## Install (Windows, Mac, Linux)

Download the app for your computer from the [Releases page](https://github.com/bRootForceSec/MortgageProtectionCRM/releases/latest):

- **Windows**: the `…-win-x64.exe`. The first time, Windows says "Windows protected your PC": click **More info**, then **Run anyway**.
- **Mac**: the `…-mac-arm64.dmg` for Apple-chip Macs (M1 and newer), or `…-mac-x64.dmg` for older Intel Macs. Drag the app to Applications. The first time you open it the Mac blocks it: open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.
- **Linux**: the `…-linux-x86_64.AppImage`. Make it executable (`chmod +x`) and run it.

The app isn't signed (it's for our team, not sold), which is why each system warns once. After that:

- It opens in its own window, keeps running in the tray when you close the window (so callback alerts still fire), and starts when you log in.
- It backs up every night at 11:30 PM, or soon after start-up if a night was missed.
- It checks the Releases page every hour. When a new version is ready, a bar offers **Restart now** (or it installs itself at 3 AM if the computer is idle). Every update takes a backup first; if the new version can't open your data, the data is put back as it was and the app points you to the previous version.
- Your data is in **Mortgage CRM** in your home folder on Windows and Mac, and `~/.local/share/mpcrm` on Linux. Logs are in its `logs` folder.
- Only one copy can use a data folder at a time. On Linux, stop the background service first (`systemctl --user stop mpcrm`) or point the app at a copy of your data with `MPCRM_DATA_DIR`.

Every push to `main` publishes a new release (numbered like 0.2.57) once the tests pass on all three systems. Build it yourself with `npm run dist` (installers in `release/`), or `npm run desktop` to run it from the source folder.

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
- **Settings → Version and updates** shows the version you're running and lets you check for updates now.

To remove the app (your data is kept): `bash ~/.local/share/mpcrm-app/repo/scripts/install.sh --uninstall`.

### Settings

Put these in `~/.config/mpcrm/env` (one `NAME=value` per line, mode 600), then run `systemctl --user restart mpcrm`:

| Variable | Default | Meaning |
|---|---|---|
| `MPCRM_DATA_DIR` | `~/.local/share/mpcrm` on Linux; `Mortgage CRM` in your home folder on Windows and Mac | Where the database and files live |
| `MPCRM_PORT` | `5170` | Local port (the app only listens on 127.0.0.1) |
| `MPCRM_BACKUP_DIR` | `<data dir>/backups` | Put this on an external drive if you can |
| `MPCRM_BACKUP_KEEP` | `30` | How many backups to keep (at least 1; a value that is not a whole number falls back to 30) |
| `MPCRM_BACKUP_AGE_RECIPIENT` | none | An [age](https://github.com/FiloSottile/age) public key; backups are then encrypted |

### AI for scanned pages

Choose it in **Settings**. The default is **Claude with your Claude account**: install [Claude Code](https://claude.com/claude-code) and sign in once (`claude`), and the app uses it to read each scanned page, which costs a fraction of a cent of your usage per page. Haiku is the default model. API keys for the other options are kept in `<data dir>/secrets.json` (mode 600). They are never shown in the app and never included in exports or backups. The local-model option needs `pdftoppm` (`sudo dnf install poppler-utils`).

### Running by hand (development)

`npm ci && npm run build && npm start` prints a link like `http://127.0.0.1:5170/?t=…`. The link contains your access key, so don't share it. To make a new key, run `npm run cli -- rotate-token` and restart. A copy started this way doesn't update itself.

## Daily use

1. **Import** a batch: Import → pick the lead type → choose the PDF or spreadsheet → (spreadsheet: check the column matches → Continue) → check any leads that need a look → set types for mixed orders → Import.
2. **Numbers**: add your Sideline number once, so each call records which caller ID you used.
3. **Calling**: the current lead's details are in the middle. Press `C` to dial (copy, QR code or KDE Connect, chosen in Settings), call on your phone, press `→` for each extra dial, then press the outcome key. `1` (No answer) and `4` (Bad number) save and move on by themselves; the others save with `Enter`. `M` switches to the Appointment side, for the outcome of an appointment you went to. A callback suggests tomorrow; type `t` for today or any other day. After Talked no appt, Sat no sale or Prezi, chips ask what held them back (Price, Spouse, Already covered…): click them or press `Shift`+`1`–`7`, or just press `Enter` to skip.

These are the starting keys. Change any of them in **Settings → Keyboard shortcuts**.

<!-- keys:start (written by test/unit/readmeKeys.test.ts) -->
| Key | Action |
|---|---|
| `C` | Dial / copy the number and start the timer |
| `X` | Dial the lead's other number |
| `→` `>` `.` | One more dial |
| `←` `<` `,` | One less dial |
| `↓` | Move down the list |
| `↑` | Move up the list |
| `N` | Next lead you haven't worked yet |
| `S` | Skip this lead |
| `Z` | Undo the last saved call (10 seconds) |
| `A` | Write a note |
| `/` | Search |
| `E` | Edit the lead |
| `P` | Show or hide the script |
| `L` | Look up an incoming caller by number |
| `B` | Mark (or unmark) that this lead called you back |
| `D` | Tick (or untick) "Do not call" for this call |
| `M` | Switch between First call and Appointment |
| `1`–`5` | First call outcome: `1` No answer, `2` Talked, no appt, `3` Appt set, `4` Bad number, `5` Callback (No answer and Bad number save straight away, unless you change it in Settings) |
| `1`–`5` | Appointment outcome: `1` No show, `2` Sat, no sale, `3` Prezi, `4` Sale, `5` Rescheduled (No show saves straight away, unless you change it in Settings) |
| `Enter` | Save the outcome and go to the next lead |
| `Esc` | Cancel |
<!-- keys:end -->

**KDE Connect** (optional): `sudo dnf install kdeconnectd`, install KDE Connect on your phone, pair them, then pick your phone in Settings → Calling. The phone opens its dialer with the number filled in. If the phone asks which app to use, pick Sideline.

Callbacks ask for a day; the time is optional. Appointment set has no date or time.

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
- Lead status (new, retry, callback, appointment set, bad number, dead) is calculated from that history and can be rebuilt at any time.
- Appointment times and outcomes like "sat", "no-show" or "sale" stay in Unitrust, which remains the official record.

**What is and isn't encrypted.** The database, the copies of imported files and exports are ordinary files, protected by your user account's folder permissions (private to you on Linux and Mac) but not encrypted. Anyone who can read your disk can read them, so keep disk encryption on (BitLocker on Windows, FileVault on Mac, LUKS on Linux). Backups are encrypted only if you set `MPCRM_BACKUP_AGE_RECIPIENT`. AI keys are kept in `secrets.json` in the data folder, readable only by you, and never go into exports or backups.

## Development

Needs Node 22 or newer.

```bash
npm ci
npm run dev          # API on 5170 with reload, UI on http://127.0.0.1:5173 (open the API's start link once first)
npm run build        # server, desktop and UI into dist/
npm start            # run the built app; prints the private link
npm run desktop      # build and open the desktop app from the source folder
```

Checks (CI runs all of them on Windows, Mac and Linux):

```bash
npm run typecheck    # TypeScript for server, desktop and UI
npm run lint         # oxlint, plus scripts/check-structure.mjs (see CLAUDE.md)
npm test             # unit and integration tests (vitest)
npm run test:e2e     # builds, then drives the real app in Chromium (Playwright)
node scripts/secret-scan.mjs
```

Configuration is environment variables only. The ones you'd set are in the Settings table above; [`env.example`](env.example) lists every variable, including the ones the updater and tests use.

Code layout:

| Path | What |
|---|---|
| `src/server/http/` | API routes, one file per feature (`importRoutes`, `leadRoutes`, `callingRoutes`, `numberRoutes`, `reportRoutes`, `dataRoutes`), and local-access security. `app.ts` wires them together. Routes validate input and call the domain; they hold no SQL |
| `src/server/domain/` | Business logic and queries: import, normalization, call list, call logging, lead status, reports, export. No HTTP in here |
| `src/server/core/` | Shared server pieces: `DomainError`, settings, audit log |
| `src/server/db/` | Database connection and the numbered SQL migrations, applied in order on start |
| `src/server/ai/` | Reading scanned pages with Claude Code, the Anthropic API or a local model |
| `src/server/config.ts` | Reads and checks every environment variable |
| `src/server/backup.ts`, `cli.ts` | Backup, restore, verify and rebuild |
| `src/shared/` | Types and helpers used by both the server and the UI (no Node-only code) |
| `src/web/` | React UI: `pages/`, `components/`, `api.ts` (the only fetch client), `storage.ts` (browser preferences), `when.ts` (dates) |
| `src/desktop/` | The Electron app: window, tray, autostart, desktop updates |
| `scripts/install.sh`, `scripts/mpcrm-update.mjs` | Linux install, background service, self-update and rollback |
| `test/` | `unit/`, `integration/` and `e2e/` tests |

Conventions are in [CLAUDE.md](CLAUDE.md): where new code goes, which shared pieces to reuse, and the data rules (lead status is derived, outcomes are never overwritten, calls are voided rather than deleted). Every PR fills in the checklist in `.github/pull_request_template.md`. The stabilization work is recorded in `AUDIT.md`, `PLAN.md` and `REFACTOR_NOTES.md`.
