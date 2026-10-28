# Unitrust appointments (Firefox extension)

Reads your Unitrust calendar while you have it open and sends each appointment's color to the CRM on this computer:

| Color | Means | In the CRM |
|---|---|---|
| Blue | Booked, not sat yet | Appointment set |
| Green | Sold | Appointment set, marked Sold |
| Red | No-show | Back to be called: Leads → **No-shows & no sales** |
| Yellow, on its own day | Sat with no sale | Back to be called: Leads → **No-shows & no sales** |
| Yellow, moved to a later day | Rescheduled | Appointment set, badge "Rescheduled" |

Unitrust moves a rescheduled appointment to its new day and keeps it yellow. So a yellow event on a later day than today,
or one whose earlier appointment disappeared from a day the calendar shows, counts as a reschedule; the one it replaced
counts as "Rescheduled" on its old day. A rescheduled appointment still yellow after its new day counts as sat with no sale.

Each appointment is matched to a lead by the phone number in its title (then by name). Your own events, like
"DONT BOOK! CHURCH", are left alone. A note in the corner of the Unitrust page says what was sent; click it to hide it.

It only reads the page. It never clicks, types or changes anything in Unitrust, and it never sees your Unitrust password.

## Set up

1. In the CRM: **Settings → Unitrust extension → Make a key**, then **Copy**.
2. Install the extension in Firefox (below).
3. Click the extension's toolbar button, paste the key, **Save**.
4. Open your Unitrust calendar in **week** or **day** view. The note in the corner should say how many appointments were sent.

## Install

Firefox only keeps add-ons that Mozilla has signed. Signing your own copy is free and automatic:

1. Zip this folder's files (not the folder itself): `cd extension/unitrust && zip -r ../unitrust.zip .`
2. Sign in at https://addons.mozilla.org/developers/ → **Submit a New Add-on** → **On your own** → upload the zip.
   It's checked automatically, usually within minutes, and stays private (not listed on the store).
3. Download the signed `.xpi` and drag it into Firefox.

To try it before signing: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick `manifest.json`.
That copy is removed when Firefox restarts.

When this folder changes, raise `version` in `manifest.json` and sign again.

## How it reads the page

`calendar.js` finds the day headers ("Mon 10/26") and hour labels ("7am") on the page, then every appointment title,
the colored box around it, which day column it sits under, and its start time. `content.js` sends the result
whenever the calendar changes and every few minutes; `background.js` posts it to `http://127.0.0.1:5170/api/unitrust/events`
with the key. If Unitrust changes its colors or layout, `calendar.js` is the file to fix.
