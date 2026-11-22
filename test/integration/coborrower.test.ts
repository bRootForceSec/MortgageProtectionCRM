import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tempConfig, tempDb, sampleCsv } from '../helpers.js';
import { migrate } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport, mapFields } from '../../src/server/domain/importer.js';
import { editLeadDetails } from '../../src/server/domain/leadEdit.js';
import { splitCouple, normalizeGender } from '../../src/server/domain/normalize.js';
import { ageOn } from '../../src/shared/age.js';
import { uuidv7 } from '../../src/server/ids.js';

describe('a couple is one lead', () => {
  it.each([
    ['Jessica Moore & Kyle Moore', 'Jessica Moore', 'Kyle Moore'],
    ['Faye A Brownlee & Donald Brownlee', 'Faye A Brownlee', 'Donald Brownlee'],
    ['Jason & Jane Smith', 'Jason Smith', 'Jane Smith'],
    ['Eliomar Barban Canada', 'Eliomar Barban Canada', null],
  ])('%s', (raw, borrower, coborrower) => expect(splitCouple(raw)).toEqual({ borrower, coborrower }));

  it('reads gender the usual ways', () => {
    expect(['M', 'f', 'Female', 'male', 'X', ''].map((g) => normalizeGender(g))).toEqual(['Male', 'Female', 'Female', 'Male', 'X', null]);
  });

  it('keeps the second person as the co-borrower, with their age from a date of birth', () => {
    const { lead, errors } = mapFields({
      full_name: 'Jessica Moore & Kyle Moore', phone: '(269) 719-0098', coborrower_dob: '03/25/1997', coborrower_gender: 'M',
    });
    expect(errors).toEqual([]);
    expect(lead).toMatchObject({
      first_name: 'Jessica', last_name: 'Moore', full_name_raw: 'Jessica Moore & Kyle Moore',
      coborrower_name: 'Kyle Moore', coborrower_signal: 'yes', coborrower_dob: '1997-03-25', coborrower_gender: 'Male',
      coborrower_age: ageOn('1997-03-25'),
    });
  });

  it('a co-borrower column holding a name is the name; Yes and No are not', () => {
    expect(mapFields({ full_name: 'Steven Brown', phone: '614-813-0975', coborrower: 'Denise Brown', coborrower_age: '53' }).lead)
      .toMatchObject({ coborrower_name: 'Denise Brown', coborrower_age: 53, coborrower_signal: 'yes' });
    expect(mapFields({ full_name: 'A B', phone: '614-813-0975', coborrower: 'Yes' }).lead).toMatchObject({ coborrower_name: null, coborrower_signal: 'yes' });
    expect(mapFields({ full_name: 'A B', phone: '614-813-0975', coborrower: 'No' }).lead).toMatchObject({ coborrower_name: null, coborrower_signal: 'unknown' });
  });

  it('a sheet with spouse columns and a note fills the co-borrower and adds the note to the lead', async () => {
    const { db } = tempDb();
    const headers = ['Lead Name', 'Phone', 'Address', 'City', 'State', 'Zip', 'Spouse Name', 'Spouse DOB'];
    const parsed = await parseSpreadsheet(sampleCsv([['Pat Lee', '317-555-0120', '1 Elm St', 'Carmel', 'IN', '46032', 'Sam Lee', '4/5/1980']], headers), 'spouse.csv');
    const sheet = parsed.sheets[0]!;
    const mapping = { ...suggestMapping(sheet.headers), note: 'Address' };
    expect(suggestMapping(sheet.headers)).toMatchObject({ coborrower_name: 'Spouse Name', coborrower_dob: 'Spouse DOB' });
    commitImport(db, parsed, sheet, mapping, { name: 'b' });
    const l = db.prepare("SELECT * FROM lead WHERE first_name = 'Pat'").get() as any;
    expect(l).toMatchObject({ coborrower_name: 'Sam Lee', coborrower_dob: '1980-04-05', coborrower_signal: 'yes' });
    expect(db.prepare('SELECT body FROM note WHERE lead_id = ?').all(l.id)).toEqual([{ body: '1 Elm St' }]);
  });

  it('editing the name says there is a co-borrower; clearing it goes back to what the sheet said', () => {
    const { db } = tempDb();
    const b = uuidv7(), r = uuidv7(), id = uuidv7(), now = new Date().toISOString();
    db.prepare("INSERT INTO import_batch (id, name, source, file_name, file_sha256, imported_at, column_mapping_json) VALUES (?, 'b', 'x', 'f', 's', ?, '{}')").run(b, now);
    db.prepare("INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status) VALUES (?, ?, 1, '{}', ?, 'accepted')").run(r, b, r);
    db.prepare("INSERT INTO lead (id, batch_id, import_row_id, first_name, coborrower_raw, coborrower_signal, created_at) VALUES (?, ?, ?, 'Pat', 'No', 'unknown', ?)").run(id, b, r, now);
    editLeadDetails(db, id, { coborrower_name: 'Sam Lee', coborrower_dob: '1/2/1970' });
    expect(db.prepare('SELECT coborrower_name, coborrower_signal, coborrower_age FROM lead WHERE id = ?').get(id))
      .toEqual({ coborrower_name: 'Sam Lee', coborrower_signal: 'yes', coborrower_age: ageOn('1970-01-02') });
    editLeadDetails(db, id, { coborrower_name: '' });
    expect(db.prepare('SELECT coborrower_signal FROM lead WHERE id = ?').get(id)).toEqual({ coborrower_signal: 'unknown' });
  });
});

describe('migration 039', () => {
  it('a name already in the co-borrower column becomes the co-borrower name', () => {
    const c = tempConfig();
    const old = path.join(c.dataDir, 'old-migrations');
    fs.mkdirSync(old);
    const src = path.resolve('src/server/db/migrations');
    for (const f of fs.readdirSync(src).filter((f) => f < '039')) fs.copyFileSync(path.join(src, f), path.join(old, f));
    const d = new Database(c.dbFile);
    d.pragma('foreign_keys = ON');
    migrate(d, old);
    const now = new Date().toISOString();
    const b = uuidv7();
    d.prepare("INSERT INTO import_batch (id, name, source, file_name, file_sha256, imported_at, column_mapping_json) VALUES (?, 'b', 'x', 'f', 's', ?, '{}')").run(b, now);
    const lead = (co: string | null, signal: string) => {
      const r = uuidv7(), l = uuidv7();
      d.prepare("INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status) VALUES (?, ?, 1, '{}', ?, 'accepted')").run(r, b, r);
      d.prepare('INSERT INTO lead (id, batch_id, import_row_id, first_name, coborrower_raw, coborrower_signal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(l, b, r, String(co), co, signal, now);
      return l;
    };
    const named = lead(' Denise Brown ', 'unknown');
    const yes = lead('Yes', 'yes');
    const no = lead('No', 'unknown');
    const blank = lead(null, 'unknown');
    migrate(d, src);
    const got = (id: string) => d.prepare('SELECT coborrower_name, coborrower_signal FROM lead WHERE id = ?').get(id);
    expect(got(named)).toEqual({ coborrower_name: 'Denise Brown', coborrower_signal: 'yes' });
    expect(got(yes)).toEqual({ coborrower_name: null, coborrower_signal: 'yes' });
    expect(got(no)).toEqual({ coborrower_name: null, coborrower_signal: 'unknown' });
    expect(got(blank)).toEqual({ coborrower_name: null, coborrower_signal: 'unknown' });
    d.close();
  }, 90_000);
});
