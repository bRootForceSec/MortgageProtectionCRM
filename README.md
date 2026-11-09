# Mortgage Protection CRM

A small calling CRM that runs on your own computer. It imports your lead spreadsheets, gives you a call list you work top to bottom, and records every call and outcome without overwriting history.

**Status: Phase 1 (leads and call history).** You still dial on your phone (Sideline) and log each call here with one keypress. Phase 2 adds calling from the computer through Telnyx. The original plan, written before the code, is in [docs/phase-0-plan.md](docs/phase-0-plan.md).

## What works now

- **Import lead PDFs** (one lead per page). Typed pages are read straight from the page. Scanned cards are read by AI: your Claude account through Claude Code, an Anthropic API key, or a local model (Ollama, LM Studio). Anything missing or uncertain opens in a review window next to the page image, with **OK**, **Discard** and **Cancel**. Cancel keeps the import as a draft to finish later.
- **Import** Excel (.xlsx) or CSV lead sheets. Columns are matched automatically and the match is remembered for next time. Rows with something missing open in the same review window. Rows that were blanked out to take them off the call list are discarded. A Status column becomes call history, dated "on or before" the day the file was saved, because the real time isn't known. Re-importing the same file adds nothing.
- **Bulk import**: pick many files at once, choose a whole folder (subfolders too), or drop them on the Import page. Every PDF and spreadsheet becomes its own batch, named after the file. Complete leads go straight in, leads already imported or repeated across files are skipped, and leads that need a look wait in "Imports to finish", one per file. Scanned PDFs are read two files at a time in the background and carry on after a restart. Very big spreadsheets go in 10,000 rows at a time (one batch per part) so the app stays usable. Spreadsheets whose columns the app can't match are listed at the end: import one on its own to match them once, and the rest with the same layout go in by themselves. At the end you see leads imported, repeats skipped, leads not imported, and what still needs you, file by file. Imported leads are not added to the call list unless you tick the box.
- **Lead types and prices** (FE-A to E, editable in Settings). Pick the type per order, and change it for some leads when an order is mixed. Each lead keeps its own price.
- **Counties and area codes**: every lead is grouped by the county it was bought for, taken from the lead page or else the address. Each county is linked to its usual area codes automatically (built in for Indiana, Michigan and Ohio; change them in Settings). Picking an area code means every county under that code, never the lead's own phone number. The same county and area-code choice applies on Leads, Calls and Callbacks, and typing a 3-digit area code in any search box works the same way.
- **Call list**: the Calling page is a plain list you build. You go top to bottom, and at the end you're done; nothing is added, removed or reordered on its own. Worked leads stay on it, crossed out with their outcome, until you press "Clear worked" (offered when the list is done). `S` moves a lead to the bottom; `×` takes one off. A lead that a no-show, appt picked up or presentation put back goes to the top when you add it, so the rebook call comes first (turn it off in Settings → Calling). "Recent outcomes" under the list shows the last 10 outcomes you set, so you can open one and fix it even after clearing the list. **Best time first** (above the list) shows and works the leads it's the best time to call right now first: your pickup rate at that weekday and hour in the lead's time (from Best time to call in Reports, once an hour has 10 calls; evenings first until then), with leads where it's before 8 AM or from 9 PM last. The hours and the 10 calls are yours to change in Settings → Calling, "Best time to call". **Your order** sorts the leads still to call by your own sort steps (Settings → Calling, "Call list order"), first to last: each is "best time to call now" or a formula, where a yes/no like `has("Hot")` puts its leads first and a number like `loan_amount` puts the highest first (tick "lowest first" to turn a step around). It starts as leads an appointment put back, then best time. "As set" goes back to the list as you built it; your choice is remembered.
- **Leads page**: where you choose who to call. Filter by status (never called, tried, callbacks…), batch, county or area code, lead age (days since the call-in date: 0–7, 8–30, 31–90, older; also shown on the list and the call list), "last tried 4+ hours ago" and so on; tick leads (or take every match) and add them to the bottom of the call list. Booked, bad-number and dead leads can't be added. Opening a lead shows it full screen like the Calling page, with its PDF page.
- **Imports** go straight onto the call list, in file order (untick the box on the import screen to skip that). **Tag these leads** on the import screen (and on a bulk import) puts your tags on every lead it brings in, like `Facebook, November`; to tag by what's in each lead, use a rule that runs when leads are imported.
- **Callbacks**: the Callback button is retired (old calls keep it). Follow-up plans still set callbacks. When one asks for a day, type the day (`t` today, `m` tomorrow, a weekday like `fri`, or a date like `10/24`) and, if you want, a time (`2`, `2:30`, `10am`; 1 to 7 means PM). The time is the lead's own time, so "call me at 2" from a Central-time lead means 2 PM where they are; the picker shows it in your time too. Leave the time blank for any time that day.
- **Today page**: today's appointments first, each with a prep card (time in yours and theirs, lender, loan, age, who's on the loan, tobacco and health answers, your last note), from the time typed on Appt set or the Unitrust calendar. Then callbacks you missed, today's, and the next two weeks, in your time and the lead's. Both stay off the call list; Open shows the lead on the Calling page beside your list, with the appointment buttons for a booked lead. A desktop alert and a sound when a callback with a time comes due, and before an appointment with a time (15 minutes by default; set or turn off in Settings).
- **Appointment set** can take the appointment's day and time (optional), typed like a callback. The lead shows it until the Unitrust extension sends the appointment, which then wins. Results (sat, sold, no-show) come from the appointment buttons or Unitrust. A Unitrust color tags the lead the same way pressing that result's button does (red puts on "No show", green "Sale", a yellow "Appt picked up" or "Rescheduled"), in place of the last button's tag, so smart lists and rules read Unitrust like any other tag. A result you logged here for that appointment wins, as before.
- **Who can be called** (Settings → Calling): a condition for the leads that can go on the call list, by hand or by a rule, and that the Calling screen dials by itself. It starts as `status != "appointment_set"` (every lead but booked ones, as before); change it with the same form or Python as any condition, like `not has("Client")`, or blank for every lead. Leads in the dead pile or with no good number are never called, and a never-dial tag still needs **Add anyway**.
- **Follow-ups** (Settings → Calling): a plan per result (no-show, sat no sale, prezi), such as `15m, 1d@09:00, 3d`. Each step is a callback timed from the result, then from each try nobody answered; an answer or the end of the plan goes back to the usual retry. Plans start empty, so the lead is due right away as before.
- **Tags**: your own labels on leads ("Spanish", "Spouse decides", "Friday list"). Add one with **+ Tag** under a lead's name (typing a new name makes a new tag), or put one on (or take it off) every lead matching your filters with Leads → **Tag all matching**. Filter Leads by tag (or no tags), and make a rule from that. Rename or delete tags in Automation → Tags. Tick **Never dial** on a tag (like "DNC") and leads with it are left off the call list: adding them says how many were skipped, and **See skipped** lists them, each with **Add anyway**. A never-dial lead you open on the Calling screen has a red "Do not call" banner saying when the tag went on and what put it there, it isn't dialed by itself, and dialing it asks first. Adding or dialing one anyway is noted in its log. Every tag put on or taken off a lead is kept in its log, with what did it (you or which rule); see it under Edit → Earlier values and tags.
- **Your fields** (Automation → Fields): fields you add to every lead, such as a spouse's name, the mortgage payment or who decides. Each is text, a number, money, a date, yes/no or a pick from your list of choices. Fill them in with **Edit** on a lead; they show with its details and in the change history. Filter Leads on a field (filled in, or a value) and make a rule from that. Exports include them, and tags, with each lead. A field can show only while a condition is true for the lead (like `has("Appt set")`), and be needed while another is: a needed field that's blank says so on the lead, and a button that asks for it won't save without it.
- **Formula fields** (Automation → Fields, kind *Formula*): a field worked out from the lead, like a lead score: `if(age >= 60, 20, 0) + if(has_tag("Hot"), 30, 0) - attempts * 2`. It can use the lead's age, mortgage amount, calls, days since the last call, lead age, type, status and state, its tags, and your other fields in `[ ]`. As you type, it shows what it gives your leads, or where the mistake is. It is always up to date by itself. A yes/no formula can read each lead's history: `has("No show")`, `days_since(added("No show")) <= 2`, `times("No answer", 7) >= 3`, `before("Appt set", "No show")`, `pressed("No answer")`. Sort Leads by it (highest first, and adding to the call list keeps that order), filter on a range, and use that in rules.
- **Google Calendar** (Settings → Google Calendar): each lead's upcoming appointment (from Unitrust, or a time typed on Appt set) goes on your Google Calendar as `#MP <Lead ID> <Last name>`, with the lead's phone and a link back to the lead. An event you typed already is found and left as you wrote it, never doubled. When an appointment moves, its event moves. Nothing is deleted from your calendar. It syncs every 15 minutes and soon after a call or a Unitrust read. You make your own Google key once (an OAuth client of the *Desktop app* kind; the steps are in Settings); the sign-in is kept in `secrets.json`.
- **Conditions** (Leads → **Condition…**): only the leads a condition is true for, built as a form (rows like "has tag", "times a tag was put on in the last 7 days", "days since a tag was put on", "calls saved as an outcome", a lead value or one of your fields, in groups of all, any or none) or written in Python, like `has("No show") and hours_since(added("No show")) < 72`. Switch between the two any time; it shows how many leads match as you go. Save it as a smart list with **Save as a smart list…** (then use it by name, `in_list("Name")`, anywhere a condition goes), or make a rule from it, like any other Leads filter.
- **Smart lists** (Automation → Smart lists): a name and a color for a condition, like "Needs rebook". A lead is in every smart list whose condition is true for it, so it can be in several at once, and it moves in and out by itself as its tags and calls change. Smart lists show as badges on Leads (in the Smart lists column) and on the lead, in your order; tick **Leads tab** to get a tab for one on Leads. The Leads tabs you start with (Never called, No answer, Picked up no appt, Callbacks, Appointment set, No-shows, Appt picked up, Presentations, Sold, Bad numbers, Dead pile) are smart lists too, so you can rename, recolor, change, reorder or remove them. A condition (or another smart list) can use one: `in_list("Needs rebook")`.
- **Rules** (Automation → Rules): every rule is "when X, do Y" (optionally only for leads like these), and running out of calls is just one kind of X. When: every day at a time on the days you tick (if the app is closed then, it runs when you next open it that day), when a call is saved with the outcomes you pick, when a tag is put on or taken off a lead (by anything: you, a rule, an import), when a lead comes into or leaves one of your smart lists, when a condition turns true for a lead, when leads are imported (each new lead once, so a condition on its age, lender, county or anything else can tag it), when the call list runs out (see below), or only when you press Run now. A rule on a lead's change acts on just that lead, right after the change (and changes made in the background are picked up within a minute). Which leads: any Leads filters (set the common ones in the rule, or set any filters on Leads and press **Make a rule**), including new ones for an appointment N days ago and waiting on the call list. Appointment days can be yesterday, since my last calling day (the last day you made calls through yesterday), the last 3 or 7 days, or this week before today. Do: add to or take off the call list, add or take off a tag, set one of your fields, change a counter (add a number, or set it; 0 resets it), put in the dead pile, or **make it come back**: steps like `15m, 1d@09:00, 3d`, each a callback timed from then and from each try nobody answered (an answer or any other outcome ends it, like a follow-up plan; in Python `come_back("15m", "1d@09:00", "3d")`). A rule's steps run top to bottom, and a **Wait** step (like `2h` or `1d@09:00`, in Python `wait("2h")`) holds the steps after it for each lead, then does them; each rule is drawn as a chain you read top to bottom: when, for which leads, then each step. Rules can set off other rules; a rule set off again for the same lead in one go stops there, and the log says it stopped a loop. Each rule can also be read and written as Python (the **Python** tab in the rule editor): `@when(...)` says when it runs, `@leads(...)` which leads, the docstring is its name, an `if` is its condition and each line under it is an action, like `add_tag("Hot")` or `counter("Streak", add=1)`. Switch between the form and Python any time; a mistake in the Python says which line. **Tag shortcuts** (Automation → Tags) write rules for you: a tag can come off by itself (at the end of the day it was put on, or after some hours), and a group of tags can be "only one at a time" (putting one on takes the others off). Their rules are listed in Automation → Rules, where you can preview and run them; you change them through the shortcut. A **counter** is a kind of field (Automation → Fields) that only rules change, 0 until they do, like a no-answer streak; conditions, filters and sorting read it like a number field. **Copy** starts a new rule from one you have. **Preview** shows what a rule would do now without changing anything; **Run now** runs it; the log lists what every run did. Ready-made rules (off until you switch them on) do your no-show example: yesterday's no-shows onto the list, and no-shows from 2 days ago, still waiting, off it. Three more are the follow-up plans as rules: a no-show, a sat no sale or a prezi comes back on its suggested steps (like `15m, 1d@09:00, 3d`), which you can change.
- **The order you call in** (Automation → Rules): rules for **when the call list runs out** fill it, such as today's imports, then no-shows since your last calling day, then today's no-answers not dialed in the last hour. They go in the order you put them in (the arrows on each rule), and the first one that adds leads wins; the next one waits until the list runs out again. They only add leads that aren't on the list, so the ones you just called don't come straight back. Three ready-made ones are there, off until you switch them on; routines you had before were turned into these. Leads filters for them: imported today, yesterday or this week; appointment yesterday or since your last calling day (from the last day you made calls through yesterday, so a Monday after a weekend off takes in Friday to Sunday); and not dialed in the last 15 min to 4 hours.
- **Arrange Reports your way**: Arrange cards moves, hides and shows each card, switches By hour between chart and table, and saves the arrangement as a named layout to load whenever you want.
- **Reports**: today or any dates, for the counties or area codes you pick. Activity (dials, attempts, contacts, talks of 2+ minutes, appointments), by hour, best time to call (all your calls put together by the lead's local weekday and hour: a pickup-rate chart by hour, the rate for each weekday, and a day-by-hour grid with totals, with every weekday shown even before it has calls), by county, by batch (cost per lead reached, booked and sold, from each lead's own price, and close rate), by lead age when called (pickups and appointments per pickup, all time), objections noted on calls by lead type (and their share of the talked, sat and prezi calls), and against the flier's benchmarks by lead type (booked per contact, sales, close rate and cost per sale; edit the targets on the page), and week by week: this week next to the 4 before it, with appointments set per pickup (overall and by lead type), show rate and close rate against the targets (80% sit and 50% close to start). Click any number to see the calls or leads behind it. Export saves the report as Excel (every section plus one row per call), as a CSV of the calls in those dates for another system, or as JSON (the whole report and every call, with notes on what each number means) for analysis. Exports never include health fields.
- **Numbers page**: calls, dials and pick-up rate for each caller ID (today, 7 and 30 days), appointments set from it, a warning before retiring a number you set appointments from, and a reputation checklist with the dates you did each check. The app never switches numbers by itself.
- **Leads in pages**: Leads shows every matching lead a page at a time (25, 50, 100, 250 or 500 a page, remembered), with First, Previous, Next and Last, and which leads you are looking at ("1–100 of 2,340").
- **Settings in sections**: Calling, Your day, Leads, Unitrust and Google, Imports and App, with a menu at the top that stays put and jumps to each.
- **The Calling screen's layout** (Automation → Calling screen, **Lead sheet**): the middle of the Calling screen is blocks (lead info, tags and smart lists, the outcome buttons, calls, notes): show or hide each one and move it up or down, and show or hide the dial counter and the caller ID. The "Do not call" banner always comes first, and the outcome buttons always show. Pick which facts show under Lead info and in what order (your fields too), how many calls to show, and how tall the note box is. Save the whole lead sheet under a name (like "New leads" and "Appointment call-backs") and switch between them there or from the **Lead sheet** menu at the top of the Calling screen.
- **Buttons** (Automation → Calling screen): the Calling screen's buttons. Each button puts a tag with its own name on the lead and takes the last button's tag off (untick that per button), so "the last thing that happened" is a tag that conditions, smart lists and rules can use. There are no First call and Appointment sides: a button shows for the leads its condition is true for (the old appointment buttons show for the smart list "Has an appointment"), and **Show every button** (M) shows them all. Rename any outcome's button or hide it; what it counts as stays the same, and its tag and every condition that names it (`has(...)`, `pressed(...)`) follow the new name. Renaming a tag, a smart list or a field does the same everywhere you've used it: smart lists, buttons, rules, funnel steps, who can be called, your order and your fields. Add buttons of your own that count as any outcome, like "Left voicemail" counting as No answer: it saves the call as that outcome, and the call keeps the button's name. Any button can show only for leads a condition is true for (like `attempts >= 3` or `not has("Voicemail")`), have a color, filled or outlined, a solid, dotted or dashed border, a tooltip and an "are you sure?", and add or take off tags when you press it (undoing the call undoes those too). Each button can also be read and written as Python (**More**, then the **Python** tab): `@button(counts_as="No answer", shows_when='not has("Voicemail")', color="red", border="dotted")` above `def button():`, the docstring is its name, and each line is `add_tag("...")` or `remove_tag("...")`. A button can also ask for some of your fields (like Best time): they show under the buttons when you pick it, and are saved with the call. Give a button a key under Keyboard shortcuts.
- **Your funnel** (Automation): the steps the top bar shows each day, the funnel button on the Calling screen draws and the Funnel card in Reports lists (for its dates and counties), in your order. They start as dials, leads called, pickups, appts set, sat, presentations and sales; rename, reorder or drop any, or add your own: a tag (each time it was put on in the period), a smart list (the leads in it now), or a formula over the log, like `times("Hot")` (added up over your leads) or `pressed("Appt set") > 0` (leads it's true for), counted for the period shown. Give a step a color for the funnel graphic; a smart list step takes the list's color unless you pick one.
- **Daily goals** in the top bar, **edit a lead** (`E`) with the old values kept, and **keyboard shortcuts you can change** in Settings.
- **Dead pile**: when someone asks not to be called, use "Move to dead pile" on the lead page. "Bad number" goes to the bad-numbers pile, unless the lead has another number: then it switches to that number and stays in rotation. Everything else goes back into rotation. Both piles can be restored.
- **Shared numbers**: when leads share a phone number, a bad number or a dead-pile lead rules that number out on all of them, with the reason on each lead. Restoring the lead it came from brings the others back; restoring one of the others brings back just that one.
- **Time zones** come from the lead's state, and from the county where a state has two (Indiana's and Michigan's Central-time counties).
- **Duplicates**: leads with the same phone are linked (not merged), so co-borrowers and re-bought leads stay separate. Importing a phone number that's in the dead pile is flagged in the preview.
- **Export** any table to CSV or Excel, or everything as one Excel file or a full JSON dump. Health fields are left out unless you tick the box.
- **Your setup as one file** (Settings → Backups): **Save my setup** downloads your tags, fields, smart lists, buttons, rules, tag shortcuts, funnel steps, calling settings and report layouts, with no leads, calls or keys. **Load a setup** puts one back, here or on another computer: tags and fields with the same name are matched (new ones are added, nothing is deleted) and the rest is replaced. It's all checked first, so a file with a mistake changes nothing and tells you which part is wrong.
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
3. **Calling**: the current lead's details are in the middle. Press `C` to dial (copy, QR code or KDE Connect, chosen in Settings), call on your phone, press `→` for each extra dial, then press the outcome key. `1` (No answer) and `4` (Bad number) save and move on by themselves; the others save with `Enter`. Each button shows when its condition is true for the lead: at the start, the appointment buttons show for leads in the smart list **Has an appointment** and the others for everyone else (change either in Automation). `M` shows every button. Every button also tags the lead with its name, taking off the last button's tag, so a smart list can read how the last call went. After Picked up, Appt picked up or Presentation, chips ask what held them back (Price, Spouse, Already covered…): click them or press `Shift`+`1`–`7`, or just press `Enter` to skip.

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
| `L` | Look up an incoming caller by number |
| `B` | Mark (or unmark) that this lead called you back |
| `I` | Copy "#MP Lead ID Last name" for your calendar |
| `D` | Tick (or untick) "Do not call" for this call |
| `M` | Show every button, not only the ones for this lead |
| `1`–`4` | First call outcome: `1` No answer, `2` Picked up, `3` Appt set, `4` Bad number (No answer and Bad number save straight away, unless you change it in Settings) |
| `1`–`5` | Appointment outcome: `1` No show, `2` Appt picked up, `3` Presentation, `4` Sale, `5` Rescheduled (No show saves straight away, unless you change it in Settings) |
| `Enter` | Save the outcome and go to the next lead |
| `Esc` | Cancel |
<!-- keys:end -->

**KDE Connect** (optional): `sudo dnf install kdeconnectd`, install KDE Connect on your phone, pair them, then pick your phone in Settings → Calling. The phone opens its dialer with the number filled in. If the phone asks which app to use, pick Sideline.

Callbacks ask for a day; the time is optional. Appointment set offers the appointment's day and time the same way, and you can leave it blank.

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
