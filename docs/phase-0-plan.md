# Local-First Insurance Calling CRM — Phase 0 Implementation Plan

Prepared 2026-10-17 for Alistair. Status: **draft for review. No code written, no services provisioned, no money spent.**

## How to read this plan

Every factual claim about a provider carries one of these tags:

| Tag | Meaning |
|---|---|
| **[V]** | Verified on the provider's official page or docs on 2026-10-17 (source in Appendix A). |
| **[E]** | Estimate or planning assumption. Numbers may be wrong; the reasoning is shown. |
| **[T]** | Unknown until tested on a real account. Listed in the telephony spike (§11, Milestone S). |

Assumptions are numbered **A1, A2, …** and collected in §2.3 so none are buried in prose.

---

## 1. Executive recommendation

**Build a small single-user web app that runs on your Fedora machine, places calls from the browser through Telnyx WebRTC, and stores everything in one SQLite file.**

| Layer | Recommendation |
|---|---|
| UI | Browser app (React + Vite) served by the local backend at `http://127.0.0.1:<port>`. Keyboard-first calling screen. |
| Backend | One Node.js (TypeScript) process. It handles leads, imports, queue, call records, reporting, and talks to Telnyx. |
| Database | SQLite in WAL mode, one file, with versioned migrations. Written in portable SQL so it can move to Postgres later. |
| Telephony | Telnyx Voice SDK (WebRTC) in the browser, a Telnyx credential connection with a webhook URL, and a provider adapter that keeps Telnyx code in one module. |
| Webhooks | A **separate, webhook-only listener** exposed to the internet through a tunnel (Cloudflare Tunnel or Tailscale Funnel). The main UI port is never exposed. A reconciliation job pulls Telnyx call records to fill any gaps. |
| Data rules | Raw provider events are append-only. Call records, outcomes, and lead state are separate tables. Lead state and reports are derived and can be rebuilt. |

**Expected monthly cost: about $62** (low ≈ $23, high ≈ $136) including an allowance for taxes and regulatory fees [E]. The high case passes the $99 ceiling mainly because of the 30-numbers-per-month allowance and conservative billing assumptions (§10).

**Three changes to the brief's phase order**, explained in §11:

1. Add a **one-day telephony spike** before Phase 2 (about $10–20 of Telnyx credit, needs your approval). It answers the questions that docs cannot: Fedora audio with Discord running, how browser calls map to webhook events, and whether unanswered attempts are billed.
2. Move **opt-out (DNC) handling and calling-hours guards into Phase 2**. They cannot wait for later phases once real calls are placed.
3. Move **basic callbacks** (a due date on a "callback" outcome) into Phase 2, because the outcome taxonomy is incomplete without it. Full follow-up tooling stays in Phase 4.

Inbound calls: per your answer (Q1), the app does not route inbound calls. The app is assumed to be open whenever you work.

---

## 2. Requirements matrix

Priority: **P0** = first release cannot ship without it. **P1** = first release should have it. **P2** = later phase.

### 2.1 Functional requirements

| ID | Requirement | Pri | Phase | Acceptance criteria |
|---|---|---|---|---|
| R1 | Import leads from .xlsx/.csv with column mapping | P0 | 1 | Test T1: a sample file imports with each mapped field in the right column; mapping is saved per batch and reusable. |
| R2 | Row-level validation and import preview | P0 | 1 | T2: malformed rows appear in the preview with row number and reason; nothing is written until you confirm; rejected rows are kept in `import_row` with the error. |
| R3 | Safe re-import and duplicate handling | P0 | 1 | T3: importing the same file twice creates zero new leads (file hash + row fingerprint match); a same-phone lead from a different batch is created and linked as a "possible duplicate" for you to resolve. |
| R4 | Batch and cost tracking | P1 | 1 | Batch has name, date, count purchased, total or per-lead cost (nullable), type/age label, file reference. |
| R5 | Lead queue with clear "never attempted" vs "attempted" | P0 | 1 | Queue shows attempt count and last outcome; filter for never-attempted; order survives restart. |
| R6 | Lead detail with full history | P0 | 1 | Shows source data, batch, state, every call (one row per call), notes, outcomes, appointments, caller ID per call. |
| R7 | Click-to-call from current lead | P0 | 2 | One deliberate action places one call; double-click or repeated Enter cannot place a second call (T-dbl). |
| R8 | Explicit caller-ID selector | P0 | 2 | T10: selected number is shown on the Call button and stored on the call; it never changes without a visible notice. |
| R9 | Live call state | P0 | 2 | UI shows Dialing / Ringing / Connected / Ended, and labels states as "provider-confirmed" only after the webhook arrives. |
| R10 | Automatic call lifecycle capture | P0 | 2 | T4–T9: start, answer, end, duration, hangup cause, destination and caller ID recorded from provider events without manual entry. |
| R11 | Fast outcome entry | P0 | 2 | After hangup the outcome panel is focused; one keypress records an outcome; changes create a new superseding record (T12). |
| R12 | Callback scheduling (basic) | P0 | 2 | "Callback" outcome requires a due time; due callbacks rise to the top of the queue in the lead's local time. |
| R13 | Dead-lead pile | P0 | 1 | A "DNC request" or "dead" outcome moves the lead to the dead pile and out of the queue; leads not marked dead recirculate. If a new import contains a phone number already in the dead pile, the preview flags it (warning only). |
| R14 | Calling-hours guard | P0 | 2 | Call button is disabled outside the configured window for the lead's local time zone, with the reason shown; override is not offered. |
| R15 | Inbound calls | — | — | Out of scope by decision (Q1). If Telnyx sends an inbound event it is stored, but no routing is built. |
| R16 | Number inventory (1–3 active) | P1 | 2 (basic) / 3 (full) | List, add, retire numbers; acquisition date; status; per-call usage history. |
| R17 | Appointment ↔ number continuity | P1 | 3 | T11: on a lead with an appointment, the selector pre-selects the appointment's number and says why. |
| R18 | Manual reputation workflow | P1 | 3 | Per-number checklist with links to Hiya, First Orion, Free Caller Registry; dated check results; manual status unchecked/clear/flagged/investigating. |
| R19 | Daily reports | P1 | 3 | T13: every report number links to the list of underlying calls and the counts match. |
| R20 | Export | P0 | 1 | CSV/XLSX export of leads, calls, outcomes, events; full JSON/SQLite dump. |
| R21 | Backup and restore | P0 | 1 (backup) / 3 (verified restore) | T14: nightly backup; documented restore reproduces identical row counts and checksums. |
| R22 | Appointments (own records, not official) | P1 | 2 (minimal: date + number) / 4 (full) | Never writes to the IMO site; official status is a manual field with date and "source: IMO site". |
| R23 | Recording | P2 | 5 | Disabled by default; cannot be enabled until the consent workflow (§9.6) exists. |
| R24 | Transcription with speaker separation | P2 | 5 | Evaluated on real calls before adoption; no health data sent to third parties without review. |

### 2.2 Non-functional requirements

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| N1 | No lost call records on crash/restart | P0 | T9: kill the backend mid-call; after restart the call exists and is completed by late webhooks or reconciliation. |
| N2 | Idempotent event ingestion | P0 | T7: replaying every webhook 3× yields identical tables. |
| N3 | Out-of-order tolerance | P0 | T6: shuffled event order yields the same derived call. |
| N4 | Secrets never in browser, repo, logs, exports | P0 | T16: automated grep of built JS bundle, logs, and exports for key patterns returns nothing. |
| N5 | UI reachable only from this machine | P0 | UI binds 127.0.0.1; Host/Origin checks; webhook listener exposes only one path. |
| N6 | Speed | P1 | Next lead loads in < 200 ms; outcome save < 100 ms locally [E target]. |
| N7 | Provider replaceable | P1 | All Telnyx code lives in `telephony/telnyx/`; core code imports only the `TelephonyProvider` interface; a fake provider passes the same test suite. |
| N8 | Portable to cloud later | P2 | No machine-specific paths in code; config via env/config file; SQL kept Postgres-compatible. |
| N9 | No automatic number rotation | P0 | T18: there is no code path that picks a caller ID without user action; a test asserts the number on each call equals the user's explicit selection. |
| N10 | No fabricated sales | P0 | T17: no derived metric counts a sale unless a `sale_record` exists with a named source. |

### 2.3 Explicit assumptions

| ID | Assumption | Why it matters |
|---|---|---|
| A1 | Single user, single computer (Fedora, PipeWire). | Drives SQLite, no auth beyond local access. |
| A2 | You place every call yourself, one at a time. No autodialer, no prerecorded messages. | Keeps the system out of autodialer and abandonment rules; affects TCPA analysis (§9). |
| A3 | Calls are to US numbers only. | Telnyx outbound voice profile can whitelist only US. |
| A4 | 20–24 working days/month, 200–250 attempts/day, 60–120 connected minutes/day. | Cost model §10. |
| A5 | 30–40% of attempts are "answered" by a person or voicemail. | 60-second billing rounding cost. [E] |
| A6 | The Claude-to-Excel extraction keeps producing one row per lead with a header row. | Import mapper design. |
| A7 | The IMO site stays the system of record for appointment outcomes and sales. No API access. | No integration; manual fields only. |
| A8 | The app only needs to receive webhooks while you are working. | Justifies a tunnel instead of a hosted relay (§3.4). |
| A9 | Your computer uses full-disk encryption (Fedora LUKS). | Chosen protection for the database at rest (§9.1). If false, we add SQLCipher. |
| A10 | All leads opted in to be contacted; your existing dead-lead practice covers do-not-call requests (your answer to Q2). | No DNC-registry or inquiry-age logic is built. |

---

## 3. System architecture

### 3.1 Components

```
                    ┌──────────────── your Fedora computer ────────────────┐
                    │                                                       │
 ┌──────────┐ HTTPS │  Browser tab (127.0.0.1:5170)                         │
 │  Telnyx  │◄──────┼── Telnyx Voice SDK (WebRTC audio + signalling)        │
 │  cloud   │       │      ▲ JWT login token (24 h)                         │
 │          │       │      │                                                │
 │          │       │  ┌───┴─────────────── Backend (Node, one process) ──┐ │
 │          │ REST  │  │ UI/API server   127.0.0.1:5170                   │ │
 │          │◄──────┼──┤  • leads, queue, imports, outcomes, reports      │ │
 │          │       │  │  • calls service + guards (DNC, hours, lock)     │ │
 │          │       │  │  • telephony adapter (Telnyx module)             │ │
 │          │       │  │  • reconciliation job (pull call records)        │ │
 │          │ webhk │  │ Webhook listener 127.0.0.1:5171 (one path only)  │ │
 │          ├──────►┼──┤  • verify Ed25519 signature → append raw event   │ │
 └──────────┘ via   │  └───────────────┬──────────────────────────────────┘ │
       tunnel       │                  │                                    │
 (cloudflared or    │           SQLite file (WAL) ── nightly encrypted ───► backup drive /
  tailscale funnel) │           ~/.local/share/crm/                          optional cloud bucket
                    └───────────────────────────────────────────────────────┘
```

### 3.2 Responsibilities and interfaces

| Component | Responsibility | Interface |
|---|---|---|
| UI (browser) | Rendering, keyboard handling, the WebRTC call itself, audio device selection. Holds no secrets except a short-lived Telnyx JWT. | Calls `/api/*` JSON endpoints; WebSocket/SSE `/api/stream` for live call state. |
| API layer | Validation, CSRF/Origin checks, maps HTTP to services. | OpenAPI-documented JSON. |
| Services (domain logic) | `ImportService`, `QueueService`, `CallService`, `OutcomeService`, `NumberService`, `ReportService`. All business rules and state transitions live here, as plain functions with tests. | TypeScript interfaces; no HTTP or SQL inside. |
| Repository layer | All SQL. One module per table group. | Kysely query builder over SQLite (swappable driver for Postgres). |
| Telephony adapter | Everything provider-specific: token minting, webhook verification, event normalization, record lookup, number search/purchase. | `TelephonyProvider` interface (§3.3). |
| Webhook listener | Separate HTTP server on its own port. Accepts `POST /hooks/telnyx` only. Verifies signature, writes raw event, returns 200 fast. Processing happens after the write. | Provider HTTP → `call_event` table. |
| Reconciliation job | Every few minutes during working hours and on startup: finds calls without a terminal provider event older than N minutes and asks the provider for their records. | Uses adapter `fetchCallRecord()`. |
| Backup job | Nightly `sqlite3 .backup` (online, consistent) → compressed → encrypted (age/restic) → external drive and optional bucket. | CLI + scheduled systemd user timer. |

### 3.3 Telephony provider interface (sketch, not code to ship)

```
interface TelephonyProvider {
  name: 'telnyx' | 'fake' | ...
  mintClientToken(userDeviceId): { token, expiresAt }          // server side only
  verifyWebhook(rawBody, headers): VerifiedEnvelope | Rejected
  normalizeEvent(envelope): NormalizedCallEvent[]               // our own event vocabulary
  fetchCallRecord(providerRefs): ProviderCallRecord | NotFound  // for reconciliation and billing
  listOwnedNumbers(): ProviderNumber[]
  searchAvailableNumbers(criteria): AvailableNumber[]           // used only on explicit user action
  purchaseNumber(id, confirmToken): ProviderNumber              // requires a confirmation step in UI
  releaseNumber(id, confirmToken): void
}
```

The browser side has a matching small `SoftphoneClient` interface (`connect`, `dial`, `hangup`, `mute`, `setDevices`, `onStateChange`) with a Telnyx implementation and a fake for tests.

Normalized event vocabulary (ours, not Telnyx's): `call.requested`, `call.initiated`, `call.ringing`, `call.answered`, `call.hangup`, `call.failed`, `call.record_reconciled`, `client.state_changed`, `client.error`. Telnyx raw event names are kept verbatim alongside.

### 3.4 Key architecture decisions

| Decision | Recommend | Why it fits this workflow | Main alternative | Cost / complexity tradeoff | Change later? |
|---|---|---|---|---|---|
| App shape | Local web app (backend + browser UI) | WebRTC calling already lives in the browser; no desktop packaging; same code can be hosted later. | Electron/Tauri desktop app | Electron adds packaging and update work for no calling benefit. | Easy: wrap the same UI in Tauri later. |
| Language | TypeScript on both sides | The Telnyx Voice SDK is JavaScript, so the browser must be JS anyway; one language means shared types for events and the provider interface; Telnyx Node SDK has webhook verification [V]. | Python (FastAPI) backend | Python is better for spreadsheets/analytics; adds a second language. | Medium: backend rewrite, schema unchanged. |
| Database | SQLite (WAL), portable SQL, migrations | One user, one machine, zero admin, file-level backups, very fast. | PostgreSQL locally | Postgres needs a service, upgrades and backups for no single-user gain. | Easy-to-medium: Kysely + plain SQL migrations; avoid SQLite-only features. Required when 2+ concurrent writers or hosting. |
| Webhook ingress | Tunnel to a webhook-only port + reconciliation | Free or near-free; calls only happen while the app runs anyway (A8); reconciliation covers anything missed. | Small hosted relay (e.g. Cloudflare Worker + queue) storing events until the laptop pulls them | Relay is more robust for inbound calls while offline, but adds a cloud component, secrets, and a second deployment. | Easy: the adapter just reads from a different inbox. Revisit if Q1 needs inbound handling while the app is closed. |
| Call model | Browser dials directly via credential connection; server observes via webhooks | Fewest moving parts; one PSTN leg; no server bridging logic. | Server dials PSTN with `POST /v2/calls`, browser leg parked and bridged [V pattern in Telnyx "outbound dialer" docs] | Bridging gives stronger server control and correlation but adds a second leg, bridge commands and more failure states. | Medium. Spike decides (S2). |
| Event store | Append-only `call_event` + derived `call` | Brief principle B; enables rebuilds and audits. | Update a single call row | Simpler but loses history and breaks idempotency. | Hard to retrofit, so do it now. |
| Auth | None beyond localhost binding + per-launch session token | Single user (A1). | Full login | Unneeded locally. | Medium: required before any hosting (§9.9). |
| UI framework | React + Vite, plain CSS | Stateful calling screen with live updates and shortcuts. | Server-rendered + htmx | htmx is lighter but awkward for WebRTC state. | Medium. |

### 3.5 Data flow summary

1. **Import:** file → parse → map columns → normalize → preview → user confirms → `import_batch`, `import_row` (every row, good or bad), `lead` (accepted rows) → `lead_state` derived.
2. **Call:** UI click → `POST /api/calls` (guards) → `call` row (`requested`) → browser dials via SDK → Telnyx webhooks → `call_event` rows → derived `call` fields → UI stream.
3. **Outcome:** keypress → `call_outcome` row → `lead_state` recomputed → queue reordered.
4. **Report:** SQL views over `call`, `call_outcome`, `lead`, `import_batch` — never over hand-maintained totals.

---

## 4. Data model

### 4.1 Authoritative vs derived

| Kind | Tables | Rule |
|---|---|---|
| **Authoritative facts (append-only)** | `import_row`, `call_event`, `call_outcome`, `note`, `reputation_check`, `dnc_entry`, `audit_log` | Never updated in place except processing-status columns. Corrections are new rows that supersede old ones. |
| **Authoritative records (editable, audited)** | `import_batch`, `lead`, `caller_number`, `appointment`, `follow_up`, `sale_record` (later) | Edits write an `audit_log` row with old/new values. |
| **Derived (rebuildable)** | `call` lifecycle columns, `lead_state`, report views | Recomputed from facts. A `rebuild` command drops and recomputes them; a test asserts the rebuild equals the live values. |

### 4.2 Entities and key fields

All IDs are UUIDv7 text (sortable, safe to merge across machines later). All timestamps are UTC ISO-8601 with milliseconds; the lead's IANA time zone is stored separately for display and calling hours. Money is integer cents (lead costs) or integer micro-dollars (telephony cost).

**import_batch** — `id, name, source ('opt_lead_manager' | other), file_name, file_sha256, imported_at, purchased_count?, cost_total_cents?, cost_per_lead_cents?, lead_type?, lead_age_label?, column_mapping_json, notes`.
Constraint: `UNIQUE(file_sha256)` warns (not blocks) on re-import of an identical file.

**import_row** — `id, batch_id, row_number, raw_json (original cells as text), row_fingerprint, status ('accepted'|'duplicate_in_file'|'already_imported'|'rejected'|'needs_review'), errors_json, lead_id?`.
Every row of every file is kept, so nothing is silently discarded.

**lead** — one per accepted source row.
`id, batch_id, import_row_id, first_name, last_name, full_name_raw, phone_e164?, phone_raw, phone_valid (bool), lender?, loan_amount_cents?, age_at_import?, coborrower_raw, coborrower_signal ('yes'|'unknown'), address_line, city, state, zip, time_zone (derived from ZIP/state, fallback area code), tobacco_raw, health_heart_raw, health_stroke_raw, health_cancer_raw, health_diabetes_raw, created_at`.
- Co-borrower: a "no" in the source becomes `unknown`, never `no`, per the brief's caveat. The raw value is kept.
- Health fields are stored as the raw source strings, only shown on the lead detail and calling card, never logged, never exported unless you tick "include health fields".

**lead_link** — `id, lead_a, lead_b, reason ('same_phone'|'same_name_address'|...), status ('suggested'|'same_person'|'different_person'), resolved_at`. Duplicates are linked, not merged or deleted.

**phone_number_registry** (one row per E.164 destination) — `phone_e164, first_seen_at, dnc_status ('none'|'internal_dnc'), dnc_since`. Opt-outs attach to the **number**, so they apply across every lead with that number.

**dnc_entry** — `id, phone_e164, source ('call_outcome'|'manual'|'import'), source_call_id?, requested_at, applied_at, note`. Append-only. Removal (rare) is a new row with `action='remove'` and a required reason.

**caller_number** — `id, e164, provider, provider_number_id, label, area_code, status ('pending'|'active'|'standby'|'retired'), acquired_at, retired_at?, retire_reason?, monthly_cost_micros?, registration_json (Hiya/First Orion/FCR submission dates), reputation_status ('unchecked'|'clear'|'flagged'|'investigating'), reputation_updated_at, notes`.
Constraint: at most one row per e164; retired numbers are kept forever.

**reputation_check** — `id, caller_number_id, checked_at, source ('hiya'|'first_orion_watchlist'|'telnyx_reputation'|'test_call_tmobile'|'test_call_verizon'|'test_call_att'|'other'), result ('clear'|'spam_likely'|'scam_likely'|'unknown'|...), evidence_note, evidence_url?`.

**call** — one per attempt, never merged.
Authoritative columns (set once at creation): `id, lead_id?, direction ('outbound'|'inbound'), from_number_id?, from_e164, to_e164, requested_at, requested_by_ui_session, idempotency_key UNIQUE, provider, initiation_result ('accepted'|'blocked_dnc'|'blocked_hours'|'blocked_active_call'|'client_error')`.
Provider correlation: `provider_session_id?, provider_leg_ids_json, client_call_id?` (from the SDK).
Derived lifecycle columns (rebuildable from events): `state ('requested'|'dialing'|'ringing'|'answered'|'ended'|'failed'|'canceled'|'unknown'), state_confirmed_by ('client'|'provider'|'reconciliation'), initiated_at?, answered_at?, ended_at?, ring_seconds?, talk_seconds?, hangup_cause?, hangup_source?, sip_code?, billed_seconds?, cost_micros?, derived_at, derived_version`.

**call_event** — append-only raw history.
`id, call_id? (null until matched), source ('provider_webhook'|'client_sdk'|'server'|'reconciliation'), provider, provider_event_id?, dedup_key UNIQUE, event_type_raw, event_type (normalized), occurred_at (provider timestamp), received_at (our clock), signature_ok (bool), payload_json (redacted, §4.4), processing_status ('pending'|'applied'|'unmatched'|'error'), processing_error?`.
- `dedup_key` = `provider:provider_event_id` for webhooks (Telnyx sends a unique event `id` per webhook; retries reuse it [T: confirm in spike]); `client:<call_id>:<sdk_state>:<seq>` for SDK events; `recon:<provider_record_id>` for reconciliation.
- Insert is `INSERT … ON CONFLICT(dedup_key) DO NOTHING` inside the same transaction as `received_at`; a duplicate returns 200 to the provider and changes nothing.

**call_outcome** — append-only interpretation by you.
`id, call_id, outcome_code, entered_at, supersedes_id?, callback_due_at?, note?`. Current outcome = latest row not superseded. Changing an outcome never touches `call_event`.

**outcome_code** — taxonomy table so it can evolve: `code, label, group ('no_contact'|'contact'|'invalid'|'compliance'), counts_as_human_contact (bool), requires_callback_time (bool), blocks_number (bool), active, introduced_at, retired_at?`.

**follow_up** — `id, lead_id, due_at, reason, preferred_number_id?, created_from_call_id?, status ('open'|'done'|'canceled'), completed_by_call_id?`.

**appointment** — `id, lead_id, scheduled_for, time_zone, set_on_call_id?, set_from_number_id (required when set on a call), recorded_via ('in_app_on_call'|'manual'|'import'), internal_status ('scheduled'|'rescheduled'|'canceled'), official_status? (free text from IMO site), official_status_entered_at?, official_status_source ('manual_from_imo_site'), notes`.

**sale_record** (Phase 4+) — exists only when you enter or import it with a named source. Analytics never infers one.

**note** — `id, lead_id, call_id?, body, created_at` (append-only; edits create a new note referencing the old).

**lead_state** (derived projection, one row per lead) — `lead_id, status ('new'|'in_progress'|'callback_due'|'appointment_set'|'not_interested'|'invalid'|'dnc'|'closed'), attempts_total, attempts_today, last_call_at, last_outcome_code, next_due_at, preferred_number_id (from latest appointment, else last connected call), derived_at`.
Rebuilt from `call`, `call_outcome`, `follow_up`, `appointment`, `dnc_entry`. You can also set `status='closed'` manually; that is stored as an outcome-like `lead_override` fact, not as a direct edit.

**audit_log** — `id, at, table_name, row_id, action, old_json, new_json`.

Later phases add `recording` (call_id, provider_recording_id, storage_path, channels, duration, consent_basis, delete_after) and `transcript` (recording_id, engine, segments_json with channel/speaker, corrected_by_user).

### 4.3 Relationships

```
import_batch 1──* import_row 1──0..1 lead *──1 import_batch
lead 1──* call 1──* call_event        call 1──* call_outcome
lead *──* lead (via lead_link)        lead 1──* follow_up, appointment, note
caller_number 1──* call (from_number) caller_number 1──* appointment (set_from)
caller_number 1──* reputation_check   phone_number_registry 1──* dnc_entry
lead ──1 phone_number_registry (by phone_e164)
```

### 4.4 Event retention and redaction

- Keep: event id, type, timestamps, call/leg/session ids, from/to, direction, state, hangup cause/source, SIP code, custom headers we set, client_state.
- Strip before storage: any auth headers, signatures (store only `signature_ok`), and any field not on the allowlist (unknown fields go to a `extra_json` column for 30 days, then are dropped, so a provider schema change is visible but not hoarded).
- Retention: call events kept for the life of the call record (needed for rebuilds). Health-history fields kept until the lead is deleted. Export/delete workflow in §9.5.

### 4.5 How derived call state is computed

Each time an event for a call is stored, the service reloads **all** events for that call and folds them in a fixed precedence order, ignoring arrival order:

1. Terminal provider events (`call.hangup`, reconciliation record) win over everything.
2. Provider events win over client SDK events for the same fact.
3. Within the same source, the earliest `occurred_at` sets `initiated_at`/`answered_at`; the latest sets `ended_at`.
4. A late `call.answered` after a `call.hangup` still sets `answered_at` (it was answered), but cannot reopen the call.
5. If client says "ended" and no provider terminal event arrives within 10 minutes, state becomes `ended` with `state_confirmed_by='client'` and the call is queued for reconciliation; reports flag it as unconfirmed until reconciled.

Because the fold is a pure function of the event list, tests can shuffle and duplicate events freely (T6, T7).

### 4.6 Durations

| Field | Definition | Source |
|---|---|---|
| `ring_seconds` | `answered_at − initiated_at` (or `ended_at − initiated_at` if never answered) | Provider webhooks |
| `talk_seconds` | `ended_at − answered_at` | Provider webhook timestamps (`start_time`/`end_time` on hangup when present) |
| `billed_seconds` | What the provider charged, per leg | Provider call/detail record. Telnyx uses **60/60 increments** [V]: an 11-second answered call bills 60 s. |
| `cost_micros` | Sum of billed leg costs | Provider record [T: confirm the record exposes per-leg cost] |

Talk time and billed time are different numbers and both are shown. Reports use talk time for activity and billed cost for spend.

---

## 5. Calling lifecycle

Precise sequence for one outbound call (recommended "browser dials directly" model):

| # | Who | What happens | Stored |
|---|---|---|---|
| 0 | App start | Backend mints a Telnyx JWT for the single telephony credential; browser connects SDK; status "Phone ready" only after the SDK's ready event. Token is refreshed on `TOKEN_EXPIRING_SOON` [V: tokens last 24 h, refresh via `updateToken`]. | `client.state_changed` events |
| 1 | You | Press **Call** (or `Ctrl+Enter`). Button disables immediately. Browser generates an `idempotency_key`. | — |
| 2 | Backend | `POST /api/calls {lead_id, from_number_id, idempotency_key}`. Guards in order: number active · destination valid E.164 · not on internal DNC · inside calling hours for lead's time zone · no other call in `requested/dialing/ringing/answered` · same key not already used. Failure → `call` row with `initiation_result='blocked_*'` and a visible reason. | `call` (requested) + `call.requested` event |
| 3 | Browser | `client.newCall({destinationNumber, callerNumber, callerName?, customHeaders:[{name:'X-CRM-Call-Id', value: call.id}], audio:true})` with the chosen mic/speaker [V: these options exist in ICallOptions]. | SDK ids posted back: `client_call_id`, Telnyx session id |
| 4 | Telnyx → webhook | `call.initiated` (direction outgoing). Webhook listener verifies Ed25519 signature [V], inserts raw event, returns 200, then matches to our `call` by custom header or SDK ids [T: which field carries the match — spike S2]. | `call_event` |
| 5 | Telnyx | Ringing state (client SDK ringing; provider may not send a separate webhook) → `call.answered` when the prospect or voicemail picks up. | `call_event`s; derived `answered_at` |
| 6 | You | Talk. Calling card stays on screen. Mute/hang-up shortcuts active. | — |
| 7 | Either side | Hangup. SDK reports ended; Telnyx sends `call.hangup` with `hangup_cause`, `hangup_source`, `sip_hangup_cause` [V]. | Terminal event; derived `ended_at`, durations |
| 8 | UI | Outcome panel focuses the moment the SDK reports "ended" (does not wait for webhook). One key = one outcome. Callback requires a time; DNC asks for a one-key confirm. | `call_outcome` |
| 9 | Backend | Recompute `lead_state`; if DNC, write `dnc_entry` and block the number now. | derived |
| 10 | Reconciliation | Within ~15 min (and at next startup), any call lacking a terminal provider event, or lacking billed cost, is looked up via provider records. | `call.record_reconciled` event |
| 11 | You | Press **N** (next) to load the next lead. Nothing dials automatically. | — |

**Failure paths**

| Situation | Behavior |
|---|---|
| SDK not ready / no mic | Call button disabled with reason; no `call` row. |
| Guard blocks call | `call` row with `blocked_*`; shown in history as "not placed". |
| Browser dial throws after step 2 | Call marked `failed` (`client_error`), error stored; no retry without a new click. |
| Prospect busy / unreachable / invalid | `call.hangup` with cause (e.g. `user_busy`, `unallocated_number`); derived `failed` or `ended` without `answered_at`; never counted as answered (T8). Suggested outcome pre-selected (e.g. "Invalid number") but you confirm. |
| Network drop mid-call | SDK attempts recovery (SDK has call recovery fields `telnyxCallId`, `isRecovered` [V]); UI shows "reconnecting"; provider hangup event settles the truth. |
| Backend crash mid-call | Audio continues (it's browser ↔ Telnyx). Webhooks fail → Telnyx retries/failover [V]; on restart reconciliation fills gaps (T9). |
| Browser tab closed mid-call | Call drops; provider hangup arrives; outcome panel offered for "calls without outcome" next time. |
| Webhook arrives for unknown call | Stored as `unmatched`; re-matched on next run; listed on a diagnostics page. Never dropped. |

**Answering machine detection** is not used: it costs per call [V], adds delay, and you decide voicemail yourself.

---

## 6. Telephony analysis

### 6.1 Recommendation

**Telnyx, using the Voice SDK (WebRTC) in the browser and a credential connection with a webhook URL.** It is about 35–40% cheaper than Twilio for this traffic (§10), offers the browser SDK, signed webhooks, dual-channel recording for later, and a number reputation product. Twilio stays the fallback if the spike shows Telnyx WebRTC is unreliable on your setup.

### 6.2 Verified Telnyx facts (2026-10-17)

| Item | Price / fact | Tag |
|---|---|---|
| Outbound local, US (SIP trunking layer) | "Starting at $0.005/min" | [V] |
| Inbound local, US | "Starting at $0.0032/min" | [V] |
| Voice API (programmable) platform fee | $0.002/min, "plus the SIP Trunking fee" | [V] |
| A credential connection with a webhook URL is treated as programmable, not plain SIP trunking | per Telnyx support article | [V] → so the $0.002 Voice API fee applies |
| WebRTC interface | $0.002/min, "in addition to any cost associated with PSTN call legs" | [V] |
| Billing increments | 60/60 (11 s answered call bills 60 s) | [V] |
| Local number | From $1.00/month; no setup fee listed | [V] |
| E911 | $1.50/month per number (optional for us) | [V] |
| Recording | $0.002/min; storage $0 | [V] |
| Telnyx transcription | $0.025/min (Google engine $0.05) | [V] |
| AMD | $0.002 standard, $0.0065 premium per call (not used) | [V] |
| Number Reputation | $100/month per enterprise + $0.10 per live check; requires enterprise registration + LOA | [V] (too expensive for now) |
| Taxes and fees | Sales/telecom taxes, USF and TRS on the interconnected VoIP portion; amounts not published, shown on invoice | [V] existence, [E] amount |
| Webhook security | Ed25519 signature in `telnyx-signature-ed25519` + `telnyx-timestamp`; verify against raw body | [V] |
| Webhook delivery | No ordering guarantee; duplicates possible; failover URL on non-200; retries on timeout | [V] |
| WebRTC auth | Backend mints JWT from a telephony credential; 24 h expiry; API key must stay on server | [V] |
| Account levels | Level 1 allows US numbers and US-only voice; Level 2 needs company name, phone, payment method | [V] |
| Per-minute rates for some US destinations | "Starting at" implies some cost more | [T] |
| Whether unanswered attempts bill the WebRTC/Voice API legs | Not documented | [T] — worth about $16/month in the expected case (§10) |
| STIR/SHAKEN attestation on Telnyx-owned numbers | Expected "A" for numbers you own on the account | [E] — verify on test calls |
| CNAM (caller name) listing price | Not listed | [T] |

### 6.3 Twilio comparison (verified 2026-10-17)

| Item | Twilio | Telnyx |
|---|---|---|
| Outbound local US | $0.0140/min [V] | $0.005 + $0.002 Voice API = $0.007 [V] |
| Browser leg | Voice SDK $0.0040/min [V] | WebRTC $0.002/min [V] |
| Effective outbound browser call | ≈ $0.018/min | ≈ $0.009/min |
| Inbound local | $0.0085/min [V] | $0.0032 + $0.002 [V] |
| Local number | $1.15/month [V] | $1.00/month [V] |
| Recording | $0.0025/min + $0.0005/min/month storage [V] | $0.002/min, storage $0 [V] |
| Transcription | $0.05/min [V] | $0.025/min [V] |
| Rounding | Partial minutes round up [V] | 60/60 [V] |
| Unanswered ringing | Not charged on API-placed calls (independent test) [E] | Unknown [T] |
| Strengths | Most mature docs and SDK, Voice Insights, large community | Lower price, own network, dual-channel recording, signed webhooks |

**Other options considered, not priced in detail:** SignalWire, Plivo, Vonage (similar API style; would only matter if both Telnyx and Twilio fail the spike). **Commercial dialers/CRMs** (Close, Kixie, etc.) typically charge per seat plus usage and do not give you raw event ownership; not recommended unless the custom build stalls. **A desktop SIP softphone** (e.g. Linphone) registered to Telnyx is the fallback if browser audio fails on Fedora; the CRM would then log calls via webhooks only, with weaker click-to-call.

### 6.4 Implementation risks (telephony)

1. **Correlating browser calls with webhooks.** The doc does not state that custom SIP headers set in `newCall` appear in webhook payloads. Spike S2 tests this; fallback is matching on SDK-reported session/leg ids, then on from/to/time window.
2. **Webhook ingress reliability via tunnel.** Mitigated by failover URL + reconciliation.
3. **Audio on Linux** (see §6.5).
4. **Account verification or fraud holds** on a new account placing 200 calls/day [E]. Do Level 2 verification before Phase 2 go-live.
5. **Reputation:** new numbers with 200 short calls/day from one number can get labeled. Spread across 2–3 numbers by your explicit choice, register them, watch results (§7).

### 6.5 Fedora / PipeWire / Discord audio

Likely issues (to be tested, not assumed):

| Risk | Detail | Mitigation |
|---|---|---|
| Bluetooth headset quality drop | When any app opens a Bluetooth mic, the headset switches to the hands-free profile (narrowband, worse audio). Discord and the softphone can fight over this. | Prefer a **wired USB headset** for calls [E]. If Bluetooth, test mSBC/LC3 support. |
| Wrong device chosen | Browser default may follow the system default, which Discord or a dock can change. | App stores explicit mic/speaker `deviceId`s, passes them to the SDK, and shows the active device names on the calling screen. Warns if a device disappears. |
| Two apps using the mic | PipeWire allows multiple apps to capture the same mic, so Discord can hear you if it is unmuted. | Checklist: mute Discord or use push-to-talk while calling. App shows a reminder; it cannot control Discord. |
| Echo / double processing | Browser echo cancellation plus PipeWire echo-cancel module can conflict. | Use browser WebRTC processing only; test with and without PipeWire echo-cancel. |
| Output routing | Speaker selection needs `setSinkId` support (Chromium yes; Firefox recent versions) [E]. | Use Chromium/Chrome as the supported browser for v1. |
| Permissions | Mic permission prompt per origin; `127.0.0.1` counts as a secure context so WebRTC works without HTTPS locally [E]. | One-time permission; documented. |
| Firewall / NAT | WebRTC media uses UDP; strict networks need TURN. | SDK defaults include TURN [V option `forceRelayCandidate` exists]; test on your home network. |

**Audio test plan (run in spike and again at Phase 2 acceptance):**
1. List devices in the app; select USB headset mic + output explicitly; place a call to your own mobile; confirm both directions clear for 3 minutes.
2. Start Discord, join a voice channel, unmute; repeat the call; confirm the call still uses the headset and note whether Discord picks up your voice.
3. Switch the system default device mid-call; confirm the call does not move devices silently.
4. Unplug the headset mid-call; confirm the app shows a visible warning and lets you pick another device; replug and recover.
5. Disable Wi-Fi/ethernet for 5 s mid-call; record whether the SDK recovers or drops, and that the call record ends correctly either way.
6. Run 20 consecutive short calls to voicemail numbers you own; confirm no device or permission prompts reappear.
7. Record subjective quality (1–5) and any echo reported by the far end.

---

## 7. Number-management design

**Provisioning (explicit, never automatic)**
- "Add number" screen: search by area code via the adapter → shows monthly price → you confirm with a typed confirmation → purchase → number created as `pending` → assigned to the credential connection → status `active` after a successful test call.
- Numbers bought outside the app (in the Telnyx portal) are discovered by a "Sync numbers" button and added as `pending` for you to label.
- Every add/retire writes `audit_log`.

**Caller-ID selection**
- Calling screen shows the selected number on the Call button itself: `Call (614) 555-0101 from Line A · 614-555-0199`.
- Default selection order, shown with the reason: (1) number tied to the lead's open appointment; (2) number used on the lead's last connected call; (3) your chosen default line. If the default changes from the previous call, the button is highlighted until you confirm once.
- The app **never** picks a number based on reputation, call counts, or time. There is no rotation feature (N9, T18).

**Appointment continuity**
- Appointment rows require `set_from_number_id` when set during a call. Lead detail shows "Appointment set from Line A (614-555-0199)". Follow-up calls pre-select that number. If that number is retired, the app warns and asks you to choose.

**Retirement**
- Retire = status `retired`, reason, date. Optionally release at Telnyx (separate confirm). History stays. If a prospect later calls a released number, it will no longer reach you — the confirm dialog says so and lists leads with open appointments tied to it.

**Reputation (diagnostic, manual)**
Per-number checklist on the Numbers screen:

| Step | Resource | Verified notes |
|---|---|---|
| Register | Hiya Connect Number Registration | Free, self-serve; numbers verified by Hiya against Dun & Bradstreet records and ownership; gives access to spam-label status; does not change caller name display [V]. **Skipped for now**: you have no business entity or D&B listing (Q3). |
| Register | First Orion free Business Number Registration | Free; vetting; "decreases the likelihood" of labels, not a guarantee [V]. |
| Check | First Orion Potential Spam Watchlist | Free with registration; **T-Mobile network only** [V]. |
| Register | Free Caller Registry (freecallerregistry.com) | One-time form, US carriers, no status console [V via Hiya's description]. Commonly described as a joint Hiya/TNS/First Orion portal [E]. |
| Check | Test calls to friends/family phones on T-Mobile, Verizon, AT&T | Record exactly what displays. Ground truth no service gives you. |
| Later | Telnyx Number Reputation API | $100/month + $0.10/check [V]; returns spam risk and category; consider only if manual checks become a burden and budget allows. |

Each check is a dated `reputation_check` row. The number's manual status (unchecked / clear / flagged / investigating) is your call, shown next to the selector. A "flagged" number shows a warning but is not auto-disabled; you decide.

**On the 30-acquisitions allowance:** budgeted (§10), but frequently replacing numbers is itself a pattern carriers and analytics engines watch [E]. The plan treats replacement as a rare, deliberate step after investigation, and reports show calls per number per day so you can see load.

---

## 8. User-interface plan

Supported browser: Chromium/Chrome on Fedora. Layout targets a 1920×1080 or larger screen.

### 8.1 Calling screen (home)

```
┌ Queue (left 28%) ─────────────┬ Current lead (center) ─────────────────────────────┬ History (right 26%) ─┐
│ [Due callbacks (3)]           │ JANE DOE · 52 · Columbus, OH · 10:42 AM local ●ok  │ This lead: 2 calls   │
│  ▸ Jane Doe   cb 10:30  2 att │ (614) 555-0101   ✓ valid   Batch: Aug-Aged-30d $4  │ 10/15 2:10p  Line A  │
│    Bob Ray    cb 11:00  1 att │ Lender: Rocket   Loan $286,000   Co-borrower: yes │  No answer · 0:00    │
│ [New (184)] [Retry (40)]      │ Tobacco: no   Health: diabetes (source: export)    │ 10/16 6:05p  Line A  │
│    Ann Lee    new        —    │ Appointment: none     Last outcome: Voicemail      │  Voicemail · 0:41    │
│    Tom Fox    new        —    │────────────────────────────────────────────────────│                      │
│    …                          │ Caller ID: [Line A · 614-555-0199 ▾] (last used)   │ Notes                │
│                               │ Mic: Jabra USB ▸  Speaker: Jabra USB ▸  Phone ●ready│  "asked to call     │
│ / search   S skip   N next    │ [   CALL 614-555-0101 from Line A   ] Ctrl+Enter    │   after 6pm"         │
│                               │ State: Idle                                        │ [+ note]  (A)        │
│                               │────── after hangup ──────────────────────────────── │                      │
│                               │ Outcome: 1 No answer 2 VM left 3 VM no msg 4 Busy  │                      │
│                               │ 5 Not interested 6 Callback… 7 Appointment… 8 Bad #│                      │
│                               │ 9 Wrong person 0 Other  D DNC request…  (Z undo 5s)│                      │
└───────────────────────────────┴────────────────────────────────────────────────────┴──────────────────────┘
```

Keyboard rules:
- **Placing a call needs `Ctrl+Enter` or a mouse click**, never a single letter, so a stray key can't dial.
- Outcome digits only work while the outcome panel is open and show a toast "Saved: Voicemail left · Z to undo". Undo writes a superseding record.
- `N` next lead, `S` skip (logs a skip, no call), `/` search, `A` add note, `M` mute, `H` hang up (only during a call), `Esc` closes panels.
- After a call, `N` is blocked until an outcome is chosen or you press `Shift+N` ("decide later"), which adds the call to a "needs outcome" list.

Queue ordering (explicit, documented, shown as a tooltip): due callbacks in the lead's calling window → appointments needing confirmation → new leads (newest batch first) → retries, with a minimum gap between attempts (default 4 hours) and a per-lead daily cap (default 2) [E defaults, configurable]. Leads outside calling hours are greyed with the local time shown.

### 8.2 Lead detail

Tabs: **Overview** (all source fields, raw values on hover, batch + cost, current state, duplicate links) · **Calls** (one row per call: date, local time, caller ID, destination, result, ring/talk/billed, outcome history with superseded entries struck through, raw events expandable) · **Notes** · **Follow-ups & appointments** (with originating number) · **Compliance** (DNC status and source call, consent/inquiry date if known).

### 8.3 Call history (global)

Filterable table: date range, caller ID, outcome, answered/not, duration buckets, "unconfirmed by provider", "no outcome yet". Each row links to the lead. Export CSV.

### 8.4 Number management

Table of numbers: label, number, status, acquired, calls today/7d/30d, connect rate 7d, appointments set from it, reputation status + last check date. Row detail: registration checklist with links and dates, `reputation_check` history, retire button. "Add number" wizard with explicit price and confirm.

### 8.5 Reporting

Day view by default: attempts, unique leads attempted, answered calls, human contacts, conversations ≥ 2 min, talk minutes, appointments set, callbacks set, DNC requests, attempts by hour (bar), per caller ID breakdown. Batch view: leads, cost, attempts, contacts, appointments, cost per appointment (only when cost known; otherwise "cost unknown"). Every number is clickable → list of the exact calls behind it (T13).

### 8.6 Import

Upload → sheet picker → column mapping (auto-guessed from headers, saved per source) → preview with counts (accepted / duplicates in file / already imported / possible duplicates / rejected) and row-level reasons → batch details (name, cost, type) → confirm → summary page with downloadable rejected-rows CSV.

---

## 9. Security and compliance review

*This is an engineering review, not legal advice. Items marked ⚖ should be confirmed with your IMO's compliance team or a TCPA attorney before Phase 2 go-live.*

### 9.1 Sensitive data

| Data | Sensitivity | Handling |
|---|---|---|
| Names, phones, addresses | PII | Local only; full-disk encryption (A9); DB file mode 0600 in a 0700 directory. |
| Loan amount, lender | Financial context | Same. |
| Health indicators, tobacco | Health information | Stored as raw source values; excluded from logs, default exports, crash reports, and any AI/transcription call; shown only on lead screens. |
| Call events | PII (numbers, times) | Redacted allowlist (§4.4). |
| Recordings/transcripts (later) | Highest | Off until §9.6 is done. |

Is full-disk encryption enough? For a single-user laptop, yes [E]: it protects against theft of a powered-off machine, which is the realistic threat. SQLCipher would add protection while logged in, at the cost of a native build and key management. If your disk is not encrypted, we either enable LUKS or add SQLCipher (decision recorded at Phase 1 setup).

### 9.2 Credentials

- Telnyx API key and webhook public key live in `~/.config/crm/secrets.env` (mode 0600), loaded only by the backend. Optional: GNOME Keyring via libsecret later.
- The browser receives only a 24-hour JWT [V]. No API key in browser code, the repo, exports, or logs (T16 greps the built bundle and logs).
- `.gitignore` covers secrets and data dirs; a pre-commit secret scan (gitleaks) runs in CI.
- One telephony credential per device [V recommendation].

### 9.3 Local network exposure and unauthorized call initiation

- UI/API binds **127.0.0.1 only**. Requests with a `Host` other than `127.0.0.1:<port>`/`localhost:<port>` are rejected (defeats DNS-rebinding). State-changing requests require a per-launch session token (printed in the launch URL, stored in a cookie with `SameSite=Strict`) and a matching `Origin`.
- The webhook listener is a **separate server on a separate port** with one route. It cannot place calls or read data. The tunnel points only at that port.
- Outbound voice profile at Telnyx whitelists **US only** (A3) and sets a daily spend cap [E: confirm control exists] to limit damage from a leaked key.
- `POST /api/calls` enforces the single-active-call lock and idempotency key.

### 9.4 Webhook verification

Verify the Ed25519 signature on the raw body with the account's public key [V]; reject if the `telnyx-timestamp` is more than 5 minutes off [E policy]; store `signature_ok`; never process unsigned events except in tests.

### 9.5 Backups, export, deletion, retention

- Nightly online backup (`.backup` API), compressed, encrypted with `age`/restic, kept 30 daily + 12 monthly on an external drive; optional offsite bucket (Backblaze B2 or similar, pennies/month [E]).
- Restore drill is a test (T14) and a monthly checklist item.
- Export: CSV/XLSX per table, plus full JSON. Health columns excluded unless ticked.
- Delete a lead: removes PII fields and health data, keeps an anonymized call skeleton (times, outcome codes, caller ID) for reports; DNC entries for the phone number are kept, because deleting them would allow calling an opted-out number again ⚖.
- Retention defaults [E, configurable]: leads untouched for 24 months → prompt to purge PII.

### 9.6 Recording consent (Phase 5 gate)

- All-party consent states for phone calls include CA, FL, IL, MD, MA, MT, NH, PA, WA, with telephone-specific all-party rules in CT and NV [V secondary legal summary, ⚖]. Interstate calls: safest practice is to follow the strictest applicable law [V secondary].
- Design: recording stays disabled until (a) a recorded disclosure or spoken script is approved, (b) the app logs `consent_basis` per call, (c) the start-recording action happens only after the disclosure, (d) a "prospect declined" key stops recording and deletes the partial file.
- Dual-channel recording puts your leg and the prospect's leg on separate stereo channels [V: Telnyx `channels: dual`]. That makes "who said what" reliable without guessing diarization, which directly answers the brief's speaker-identification concern.
- Transcription: prefer **local** transcription (whisper.cpp / faster-whisper on your machine, per channel) so health details never leave the computer; benchmark accuracy on 20 real calls before relying on it. Cloud transcription only after a privacy/contract review.

### 9.7 Telemarketing and DNC ⚖

| Rule | Design response |
|---|---|
| National DNC rules [V secondary summary]. | Per your answer (Q2): leads are opted in and handled by your dead-lead practice; no registry or inquiry-age logic is built. |
| Opt-out requests: since April 11, 2025, honored within 10 business days, by any reasonable means [V secondary summary of FCC rule]. | DNC outcome blocks the number **immediately** (stricter than required). |
| Federal calling hours 8 a.m.–9 p.m. called party's local time [E — well-established TCPA rule]; several states are stricter. | Per-state calling-window table, default 8–9, editable; Call button blocked outside the window. Time zone from ZIP; ambiguous cases (split-zone states, area-code-only) use the stricter interpretation. |
| State DNC lists (about 11 states) and state "mini-TCPA" laws [V secondary]. | Track at the policy level with your IMO; app supports importing a suppression list of numbers into `dnc_entry`. |
| Caller ID must be accurate and reachable. | Only numbers you own are selectable; inbound routing is out of scope (Q1). |
| Manual, human-initiated calls without prerecorded messages (A2). | No autodialer or voicemail-drop features in scope. Changing this would require a fresh compliance review. |
| Insurance-specific: state insurance marketing rules and your IMO's policies. | Out of scope for software; the app avoids storing or sending anything beyond what the workflow needs. |

### 9.8 Logging

Structured JSON logs with a redaction layer: phone numbers masked to last 4, no names, no health fields, no tokens or signatures, no raw webhook bodies (those live in the DB). Log rotation 14 days.

### 9.9 If hosted later

Re-assess everything: real authentication (passkeys/OIDC), per-agent authorization, tenant column on every table + row-level checks or per-tenant DB, managed Postgres with encryption and PITR backups, secrets manager, TLS everywhere, audit of who viewed health data, BAAs/DPAs with vendors. None of this is built now.

---

## 10. Cost model

### 10.1 Assumptions

| | Low | Expected | High |
|---|---|---|---|
| Working days/month | 20 | 22 | 24 |
| Call attempts/day | 200 | 220 | 250 |
| Answered (human or voicemail) | 30% → 60 | 35% → 77 | 40% → 100 |
| Connected talk minutes/day | 60 | 90 | 120 |
| PSTN billed min/day = talk + 0.5 min rounding per answered call (60/60) [E] | 90 | 129 | 170 |
| WebRTC + Voice API billed min/day | 90 (unanswered **not** billed) | 272 (each unanswered attempt bills 1 min) | 320 (same rule as expected) |
| Outbound PSTN rate | $0.005 | $0.005 | $0.007 (allowance above "starting at") |
| Platform rate (WebRTC $0.002 + Voice API $0.002) | $0.004 | $0.004 | $0.004 |
| Inbound callbacks/day × 2.5 billed min | 5 → 12.5 min | 10 → 25 min | 15 → 37.5 min |
| Inbound rate ($0.0032 + $0.004) | $0.0072 | $0.0072 | $0.0072 |
| Active numbers + acquisitions in month | 2 + 0 | 3 + 3 | 3 + 30 |
| E911 | no | no | yes, 3 numbers |
| Taxes, USF, TRS, regulatory fees [E] | +15% | +25% | +30% |
| Recording / transcription | off | off | off (shown separately) |

### 10.2 Monthly totals (Telnyx, recommended architecture)

| Line | Type | Low | Expected | High |
|---|---|---|---|---|
| Outbound PSTN | usage | $9.00 | $14.19 | $28.56 |
| WebRTC + Voice API | usage | $7.20 | $23.94 | $30.72 |
| Inbound callbacks | usage | $1.80 | $3.96 | $6.48 |
| Phone numbers | fixed | $2.00 | $6.00 | $33.00 |
| E911 | fixed | — | — | $4.50 |
| **Telecom subtotal** | | **$20.00** | **$48.09** | **$103.26** |
| Taxes & fees (est.) | uncertain | $3.00 | $12.02 | $30.98 |
| Tunnel/domain | fixed | $0 | ~$1 | ~$1 |
| Offsite backup | usage | $0 | ~$0.50 | ~$1 |
| Hosting | — | $0 | $0 | $0 |
| **Total** | | **≈ $23** | **≈ $62** | **≈ $136** |

Math check (expected): PSTN 129 × $0.005 × 22 = $14.19; platform 272 × $0.004 × 22 = $23.94; inbound 25 × $0.0072 × 22 = $3.96.

**What moves the number most**
- If unanswered attempts are not billed on the platform legs (spike S4), expected drops by about $16 to **≈ $46**.
- The high case is over $99 mainly from 30 number purchases ($33 plus fees) and the growth assumptions; capping acquisitions at 5/month brings high to about $104.
- Tax/fee percentage is the largest unknown; the first invoice replaces the estimate.

### 10.3 Optional add-ons (Phase 5)

| Add-on | Expected month | High month |
|---|---|---|
| Recording, all connected minutes ($0.002/min) | $3.96 | $5.76 |
| Telnyx transcription, all connected minutes ($0.025/min) | $49.50 | $72.00 |
| Local transcription on your computer | $0 (electricity, CPU time) | $0 |
| Telnyx Number Reputation | $100 + checks | — |

Recording fits the budget; cloud transcription of every call does not. Local transcription of dual-channel recordings, or transcribing only selected calls, keeps the total under $99.

### 10.4 Twilio for comparison (expected scenario)

PSTN 129 × $0.014 × 22 = $39.73; SDK 272 × $0.004 × 22 = $23.94; inbound 25 × $0.0125 × 22 = $6.88; numbers 6 × $1.15 = $6.90 → $77.45 + 25% ≈ **$97**. Right at the ceiling.

### 10.5 One-time and development costs

- Telnyx spike credit: ~$10–20 [E] (needs your approval).
- Domain for a named Cloudflare tunnel, if used: ~$10/year [E]; Tailscale Funnel avoids this [E].
- USB headset if you don't have a wired one: $40–100 [E].
- Development: AI-assisted; maintenance mostly dependency updates and provider API changes. The biggest ongoing risk is SDK changes, mitigated by the adapter boundary.

---

## 11. Phased implementation plan

```
Phase 1 ──► Spike S (½–1 day) ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
 (no spend)   (≈$10–20, approval)   first release = end of Phase 3
```

Phase 1 can start immediately after approval, and the spike can run in parallel because it is throwaway code.

### Phase 1 — Lead and call-history foundation (no telephony, no spend)

Deliver: repo + CI (lint, type-check, tests, secret scan) · config system · SQLite + migrations · import (mapping, preview, validation, duplicates, batches, costs) · queue + lead detail · `call`/`call_event`/`call_outcome` tables with a **"log external call"** form so you can use the app with Sideline right away · notes · CSV/XLSX/JSON export · nightly backup · `rebuild` command.
Depends on: approval; a sample of your current Excel sheet (with real names/numbers replaced if you prefer).
Milestone: you can import a real batch and work through it for a day using Sideline, logging outcomes in the app.
Tests: T1, T2, T3, T4, T12, T14 (backup only), T-rebuild, import fuzz tests (random missing/odd values).

### Milestone S — Telephony spike (throwaway, needs approval to spend)

Questions to answer, each with a written result:
- **S1** Audio test plan §6.5 steps 1–7 on your machine with Discord.
- **S2** Which identifiers link a browser `newCall` to webhook events (custom header? SDK session id = `call_session_id`?).
- **S3** Exact webhook sequence and payloads for: answered, voicemail, busy, no answer, invalid number, caller hangs up first, you hang up first.
- **S4** Billing: place 10 unanswered calls and 10 short answered calls; read detail records next day; confirm which legs bill and the rounding.
- **S5** Display check: what your numbers show on T-Mobile, Verizon, AT&T phones; STIR/SHAKEN attestation if visible in records.
- **S6** Tunnel choice: Cloudflare Tunnel vs Tailscale Funnel stability over a 2-hour session.
Decision gate: if S1 fails on Telnyx, try Twilio's SDK or a desktop SIP softphone before Phase 2.

### Phase 2 — Working softphone (first real calls)

Deliver: Telnyx adapter + fake adapter · JWT minting and refresh · webhook listener (signature, dedup, raw store) · derived call fold · reconciliation job · click-to-call with guards (lock, idempotency, dead-lead check, calling hours) · caller-ID selector (basic number list) · device selection UI · live state stream · outcome panel with shortcuts and undo · basic callbacks · DNC outcome · minimal appointment record (date + number) · diagnostics page (unmatched events, unconfirmed calls).
Depends on: Phase 1, spike results, Telnyx Level 2 verification, numbers purchased (with your approval).
Milestone: one full working day of real calls on the app.
Tests: T4–T10, T15, T16, T18, T-dbl, T-dnc, T-hours, recorded-fixture replay tests using real payloads captured in the spike.

### Phase 3 — Numbers and operational reporting (= first production release)

Deliver: full number management (add/retire/sync, audit) · appointment ↔ number continuity · reputation checklist + check log · daily and batch reports with drill-down · cost-per-appointment where cost known · telephony cost import from provider records · verified restore drill.
Milestone: two consecutive weeks of daily use with reports that reconcile.
Tests: T11, T13, T14 (restore), T17, report reconciliation property tests.

### Phase 4 — Workflow improvements

Follow-up scheduling and reminders (desktop notifications) · more keyboard navigation · appointment tracking with manual official-status entry · optional Google Calendar *read-only* view, only if useful · saved import mappings for new lead sources · advanced analytics (show rate, sale rate when `sale_record` data is entered/imported).

### Phase 5 — Optional advanced

Recording (after consent review) · local transcription per channel · AI summaries with health-data redaction and your confirmation · outcome suggestions requiring confirmation · ROI by lead source · cloud deployment and multi-agent (needs §9.9) · second provider adapter.

### Test strategy summary

| Level | What | Tools |
|---|---|---|
| Unit | Normalizers (phone, names), duplicate detection, guards, event fold, outcome supersession, metric definitions | Vitest |
| Property/fuzz | Event fold with shuffled/duplicated events; import with random bad cells | fast-check |
| Integration | API + real SQLite file; webhook listener with signed fixture payloads; reconciliation with a fake provider; restart mid-call simulation | Vitest + supertest |
| End-to-end (mocked) | Browser flows with the fake SoftphoneClient: import → call → outcome → report | Playwright |
| End-to-end (real) | Spike checklist and Phase 2 acceptance on your machine with a real Telnyx account, your phones as destinations | Manual checklist with recorded results |
| Security | Bundle/log secret grep, Host/Origin rejection, webhook bad-signature rejection | Automated in CI |

What needs a real account: audio quality, Discord coexistence, real event sequences and identifiers, billing behavior, caller-ID display and labeling, reputation. Everything else runs against mocks and recorded fixtures.

### Mapping of the brief's 18 acceptance tests

| # | Test | Level | Phase |
|---|---|---|---|
| 1 | Valid sheet imports with correct mappings | Integration | 1 |
| 2 | Missing/malformed fields reported, no corruption | Unit + integration | 1 |
| 3 | Re-import doesn't duplicate | Integration | 1 |
| 4 | Multiple calls to one lead stay separate | Integration | 1 |
| 5 | Correct destination and caller ID per call | Integration + real | 2 |
| 6 | Out-of-order events don't corrupt history | Property | 2 |
| 7 | Duplicate webhooks create no duplicates | Property + integration | 2 |
| 8 | Failed calls not counted as answered | Fixture replay | 2 |
| 9 | Restart doesn't lose history | Integration (kill process) | 2 |
| 10 | Correct caller ID selectable before call | E2E mocked | 2 |
| 11 | Appointment caller ID available for follow-up | E2E mocked | 3 |
| 12 | Outcome change keeps raw history | Unit | 1 |
| 13 | Daily reports reconcile to call records | Property | 3 |
| 14 | Backups restore | Integration + drill | 1 / 3 |
| 15 | Softphone works with your Linux audio | Real | S / 2 |
| 16 | No secrets in browser or logs | Automated scan | 2 |
| 17 | No sale without explicit source | Unit | 3 |
| 18 | No automatic rotation | Unit (no code path) + review | 2 |

---

## 12. Risk register

| # | Risk | Likelihood | Severity | Prevention | Recovery |
|---|---|---|---|---|---|
| 1 | Browser audio unreliable on Fedora/Bluetooth/Discord | Medium | High | Spike S1, wired USB headset, explicit device IDs | Twilio SDK or desktop SIP softphone; keep Sideline as backup during Phase 2 |
| 2 | Webhooks can't be correlated to browser calls | Low–Med | High | Spike S2 | Server-dial + bridge model (§3.4) |
| 3 | Webhooks missed (tunnel down, app closed) | Medium | Medium | Failover URL, reconciliation, diagnostics page | Reconciliation backfills from provider records |
| 4 | Duplicate/out-of-order events corrupt data | Medium | High | Unique dedup key, pure fold, property tests | `rebuild` command |
| 5 | Accidental double dial | Medium | Medium | Disabled button, idempotency key, active-call lock | Calls are separate records; outcome "duplicate dial" |
| 6 | Calling an opted-out or DNC number | Low–Med | **Very high** (fines per call) | Number-level DNC block, hours guard, Q2 policy | Incident log; immediate block; review |
| 7 | Numbers labeled spam | High over time | High | Registration, moderate per-number volume, honest caller ID | Manual investigation, remediation requests, deliberate replacement |
| 8 | API key leak → toll fraud | Low | High | Secrets file 0600, US-only profile, spend cap, secret scan | Rotate key, review CDRs |
| 9 | Laptop loss/disk failure | Low | High | LUKS, nightly encrypted backups, restore drills | Restore to new machine |
| 10 | Health data leaks via logs/AI | Low | High | Redaction, export opt-in, no AI by default | Purge logs, review |
| 11 | Import misreads columns (sheet layout changes) | Medium | Medium | Preview, saved mappings, row-level errors, keep raw rows | Delete batch (soft), re-import |
| 12 | Cost overrun (fees, rounding, number churn) | Medium | Medium | Spike S4, cost import, monthly cost report, acquisition cap | Adjust plan; switch billing assumptions |
| 13 | Provider account hold/fraud flag | Low–Med | High | Level 2 verification first, ramp volume over first week | Support ticket; fallback provider adapter |
| 14 | Scope creep slows first release | Medium | Medium | Phases with milestones; this plan as the contract | Defer to Phase 4/5 |
| 15 | SQLite limits when going multi-user | Low now | Medium | Portable SQL, Kysely, UUIDs | Migrate to Postgres with a one-time copy script |

---

## 13. Decisions (answered 2026-10-17)

1. **Inbound calls:** not handled. The app is assumed to be open while you work.
2. **Do-not-call:** all leads opted in. A do-not-call request means the lead goes to the dead pile; everything else recirculates. No DNC-registry logic.
3. **Business identity:** none, so Hiya and First Orion registration are skipped. Reputation checks rely on test calls and manual status.
4. **Telnyx test spend:** not yet approved. Phase 1 needs no spend.
5. **Headset:** you'll use a wired headset. Bluetooth testing is dropped.

Remaining before Phase 1: plan approval, a GitHub repository, and a sample spreadsheet.

---

## 14. Definition of done (first production release = end of Phase 3)

The release is production-ready when all of these are true:

1. All 18 brief acceptance tests plus T-dbl, T-dnc, T-hours, T-rebuild pass in CI, and real-account items (5, 15) pass on your machine with recorded results.
2. You have used the app for **10 working days** with ≥ 150 calls/day and:
   - zero lost calls (every call placed appears in the app and in Telnyx records; daily automated cross-check shows 0 mismatches after reconciliation);
   - zero duplicate call records;
   - ≤ 1% of calls ending with `state_confirmed_by='client'` after 24 hours.
3. Median time from hangup to next call ready (outcome saved + next lead loaded) is **under 5 seconds** of app time, measured from event timestamps.
4. A restore from the previous night's backup onto a fresh directory reproduces identical row counts and table checksums.
5. Secret scan of bundle, logs, exports is clean; webhook bad-signature test rejects; UI unreachable from another device on your LAN (manual check).
6. DNC block works across duplicate leads with the same number; calling-hours guard verified for at least ET/CT/MT/PT/AZ/HI leads.
7. Each daily report figure drills down to calls whose count matches.
8. The month's Telnyx invoice is within ±20% of the app's own cost estimate, and total monthly spend is ≤ $99.
9. Recording is off and cannot be turned on without the Phase 5 consent workflow.
10. A one-page runbook exists: start/stop, rotate keys, restore, what to do if calls fail, how to retire a number.

---

## Metric definitions (for reports)

| Metric | Definition |
|---|---|
| Call attempts | `call` rows with `direction='outbound'` and `initiation_result='accepted'` |
| Blocked attempts | `initiation_result LIKE 'blocked_%'` (shown separately, never counted as attempts) |
| Unique leads attempted | Distinct `lead_id` among attempts in the period |
| Answered calls | Attempts with provider-confirmed `answered_at` (includes voicemail pickups) |
| Human contacts | Answered calls whose current outcome has `counts_as_human_contact=true` |
| Conversations | Human contacts with `talk_seconds ≥ 120` [E threshold, configurable] |
| Talk minutes | Sum of `talk_seconds` / 60 |
| Billed minutes / cost | From provider records, not computed from talk time |
| Appointments set | `appointment` rows created in the period with `set_on_call_id` not null (not inferred from duration) |
| Callbacks set / completed | `follow_up` rows created / completed by a call |
| Attempts per lead | Attempts ÷ unique leads attempted |
| Cost per appointment | (Known lead cost for batches involved + telephony cost) ÷ appointments set; shows "partial" when any batch cost is unknown |
| Show rate, sale rate, cost per sale | Phase 4+, only from manually entered or imported official outcomes |

## Initial outcome taxonomy

| Code | Label | Group | Human contact | Notes |
|---|---|---|---|---|
| `no_answer` | No answer | no_contact | no | |
| `vm_left` | Voicemail – message left | no_contact | no | |
| `vm_no_msg` | Voicemail – no message | no_contact | no | |
| `busy` | Busy | no_contact | no | |
| `bad_number` | Disconnected / invalid | invalid | no | Marks phone invalid; suggests closing lead |
| `wrong_person` | Wrong person | invalid | yes | |
| `hung_up` | Answered, hung up immediately | contact | yes | |
| `not_interested` | Not interested | contact | yes | |
| `callback` | Callback requested | contact | yes | Requires due time |
| `appointment` | Appointment set | contact | yes | Opens appointment form with caller ID pre-filled |
| `already_covered` | Already has coverage | contact | yes | |
| `dnc_request` | Do-not-call request | compliance | yes | Blocks number immediately |
| `other` | Other (note required) | contact | yes | |

The table is data, so codes can be added or retired without migrations, and old calls keep their original codes.

---

## Appendix A — Sources checked 2026-10-17

Telnyx
- Voice API pricing: https://telnyx.com/pricing/call-control
- Elastic SIP pricing (US default): https://telnyx.com/pricing/elastic-sip.md
- Numbers pricing: https://telnyx.com/pricing/numbers.md
- Pricing overview: https://developers.telnyx.com/pricing.md
- WebRTC billing note: https://telnyx.com/release-notes/webrtc-billing-and-reporting
- Billing increments: https://support.telnyx.com/en/articles/1130659-billing-increments
- Taxes, USF, TRS: https://support.telnyx.com/en/articles/6420959-sales-gst-telecommunication-taxes-usf-fees-trf
- SIP connection settings (webhooks make calls programmable): https://support.telnyx.com/en/articles/4351104-sip-connection-settings
- Credential connections for SDK auth: https://developers.telnyx.com/docs/voice/webrtc/auth/credential-connections/index
- JWT authentication architecture: https://developers.telnyx.com/docs/development/webrtc/js-sdk/explanation/authentication-architecture.md
- JS SDK call options: https://developers.telnyx.com/docs/voice/webrtc/js-sdk/interfaces/icalloptions.md
- Outbound dialer pattern: https://developers.telnyx.com/docs/voice/webrtc/use-cases/outbound-dialer/index
- Receiving webhooks: https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks.md
- Webhook signature verification: https://developers.telnyx.com/docs/development/sdk/node/webhooks
- Recording start (dual channel): https://developers.telnyx.com/api-reference/call-commands/recording-start.md
- Number Reputation: https://developers.telnyx.com/docs/number-reputation/overview
- Account verification: https://support.telnyx.com/en/articles/1130595-account-verification

Twilio
- Voice pricing (US): https://twilio.com/voice/pricing
- SDK call legs: https://support.twilio.com/hc/en-us/articles/223180608-Twilio-Voice-JavaScript-and-Mobile-SDK-Pricing
- Rounding: https://support.twilio.com/hc/en-us/articles/223132307-How-do-you-round-minutes-for-billing
- Unanswered-call billing test (independent): https://dev.classmethod.jp/en/articles/twilio-call-api-unanswered-ringing-billing-verification/

Reputation
- Hiya Connect Number Registration: https://connect-support.hiya.com/hc/en-us/articles/28777616966035-Introduction-to-Hiya-Connect-Number-Registration
- Hiya vs Free Caller Registry: https://blog.hiya.com/how-does-hiya-number-registration-differ-from-free-caller-registry
- First Orion registration and Watchlist: https://firstorion.com/blog/the-best-way-to-register-commercial-business-numbers-to-mitigate-spam-tags

Compliance (secondary legal summaries; confirm with counsel)
- FCC consent revocation rule timing: https://hunton.sitepilot11.firmseek.com/privacy-and-cybersecurity-law-blog/burdensome-portion-of-tcpa-rule-delayed-through-april-2026
- Recording consent by state: https://www.layer3labs.io/guides/two-party-consent-states
- National DNC overview: https://www.compliancepoint.com/regulations/dnc/
