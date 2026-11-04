-- Profitability. Policies read off the Unitrust Business Management Report by the Firefox extension, the products
-- they're for (carrier + product, with your comp rules for each), and your Unitrust comp level over time.

-- One row per carrier + product. Created by the extension with only the carrier and name; you fill in the rules.
-- Commission = AP × (comp level − comp_hit_points) % × advance_pct %. A product with a rule left blank counts for nothing.
CREATE TABLE product (
  id              TEXT PRIMARY KEY,
  carrier         TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT CHECK (kind IN ('term','final_expense','other')),
  comp_hit_points REAL,   -- points off your comp level: 0 for level comp, 10 for Americo Term 100
  advance_pct     REAL,   -- share of the commission advanced, e.g. 75
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX product_carrier_name ON product(upper(carrier), upper(name));

-- Your Unitrust comp level from a day on. A policy uses the level in effect on its application day.
CREATE TABLE comp_level (
  id             TEXT PRIMARY KEY,
  level          REAL NOT NULL,
  effective_from TEXT NOT NULL,   -- YYYY-MM-DD
  source         TEXT NOT NULL CHECK (source IN ('unitrust','manual')),
  created_at     TEXT NOT NULL
);
CREATE INDEX comp_level_from ON comp_level(effective_from);

-- One row per Unitrust app (e.g. Uni-100001), updated each time the report is read. Changes are in audit_log.
CREATE TABLE policy (
  id                 TEXT PRIMARY KEY,
  unitrust_app_id    TEXT NOT NULL UNIQUE,
  policy_number      TEXT,
  product_id         TEXT NOT NULL REFERENCES product(id),
  lead_id            TEXT REFERENCES lead(id),
  lead_linked_by     TEXT CHECK (lead_linked_by IN ('auto','manual')),  -- manual links are never changed by a sync
  client_name        TEXT,
  client_phone_e164  TEXT,
  premium_cents      INTEGER,   -- monthly premium
  apv_cents          INTEGER,
  capped_apv_cents   INTEGER,
  status             TEXT,      -- as Unitrust shows it, e.g. "Issue-Paid"
  applied_on         TEXT,      -- YYYY-MM-DD: Application date (card view), else Submitted
  submitted_on       TEXT,
  paid_on            TEXT,      -- Paid date from the card view, else the day it was first seen paid
  lapsed_on          TEXT,
  first_seen_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX policy_lead ON policy(lead_id);
CREATE INDEX policy_product ON policy(product_id);
