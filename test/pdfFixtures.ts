import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

// Synthetic lead PDFs in the "Call-in Delivery Notice" layout, with made-up people.
// Positions follow the real notices (612x792 pt page; y measured from the top).

export interface FakeLead {
  id?: string;
  callin?: string;
  lastAction?: string[];
  name?: string[];
  coborrower?: string;
  age?: string;
  lender?: string;
  amount?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string;
  tobacco?: string;
  health?: string;
  calledFrom?: string;
  phone?: string;
  alt?: string;
  /** Turn the page sideways, as on some scans. */
  rotate?: boolean;
}

const LEFT = 54;
const SUB = 198;
const RIGHT = 324;

export async function makeLeadPdf(pages: (FakeLead | 'scan')[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([612, 792]);
    if (p === 'scan') {
      // No text layer at all, like a scanned mailer card.
      page.drawRectangle({ x: 50, y: 300, width: 300, height: 150, borderWidth: 2 });
      continue;
    }
    const t = (s: string | undefined, x: number, top: number, size = 10) => {
      if (s) page.drawText(s, { x, y: 792 - top, size, font });
    };
    t('Mortgage Identification Number:', LEFT, 136);
    t('Call-in Date & Time:', LEFT, 180);
    t('Last Action:', LEFT, 224);
    t('Borrower Name:', LEFT, 273);
    t('Co-Borrower:', LEFT, 331);
    t('Borrower Age:', SUB, 331);
    t('Lender:', LEFT, 375);
    t('Mortgage Amount:', LEFT, 419);
    t('Borrower Address:', LEFT, 463);
    t('City:', LEFT, 507);
    t('State:', LEFT, 551);
    t('Zip Code:', SUB, 551);
    t('County:', LEFT, 595);
    t('Borrower Tobacco last 12 mos:', LEFT, 639);
    t('Borrower: Any History of the following:', LEFT, 683);
    t('Heart Attack, Stroke, Cancer, or Diabetes?', LEFT, 698);
    t('MORTGAGE PROTECTION', RIGHT, 53, 14);
    t('Our records indicate that when you closed on', RIGHT, 177);
    t('THE REFERENCED MORTGAGE', RIGHT, 355);
    t('BORROWER CONTACT INFORMATION:', RIGHT, 504);
    t('Called in From:', RIGHT, 536);
    t('Contact Phone Number:', RIGHT, 580);
    t('Alternate Phone Number:', RIGHT, 624);
    t('******* THIS IS NOT AN APPLICATION FOR', RIGHT, 685);
    t('INSURANCE COVERAGE.', RIGHT, 699);

    t(p.id, LEFT, 160);
    t(p.callin, LEFT, 202);
    (p.lastAction ?? []).forEach((v, i) => t(v, LEFT, 240 + i * 9));
    (p.name ?? []).forEach((v, i) => t(v, LEFT, 289 + i * 16));
    t(p.coborrower, LEFT + 2, 349);
    t(p.age, SUB + 2, 346);
    t(p.lender, LEFT, 396);
    t(p.amount, LEFT, 443);
    t(p.address, LEFT, 485);
    t(p.city, LEFT, 527);
    t(p.state, LEFT, 575);
    t(p.zip, SUB - 4, 576);
    t(p.county, LEFT, 618);
    t(p.tobacco, LEFT, 660);
    t(p.health, LEFT, 715);
    t(p.calledFrom, RIGHT, 559);
    t(p.phone, RIGHT, 605);
    t(p.alt, RIGHT, 648);
    if (p.rotate) page.setRotation(degrees(90));
  }
  return doc.save();
}

export const FAKE: FakeLead[] = [
  {
    id: '900000001', callin: '7/15/2026 11:31 AM EDT', lastAction: ['INCOMPLETE'], name: ['ALEX', 'SAMPLEPERSON'],
    coborrower: 'No', age: '61', lender: 'EXAMPLE FEDERAL C', amount: '$100,000.00', address: '100 W TEST ST',
    city: 'SOUTH BEND', state: 'IN', zip: '46619', county: 'ST JOSEPH', calledFrom: '(574) 555-0100', phone: '(574) 555-0100',
  },
  {
    id: '900000002', callin: '04/01/26 9:21 am', lastAction: ['CALL COMPLETED', 'INCOMPLETE'], name: ['JORDAN TESTER'],
    coborrower: 'Yes', age: '54', lender: 'DEMO EQUITY PARTNERS', amount: '$76,987', address: '200 MOCK CT',
    city: 'ELKHART', state: 'IN', zip: '46514', county: 'ELKHART COUNTY', calledFrom: '(574) 555-0111', phone: '(574) 555-0112',
    alt: '(574) 555-0113', tobacco: 'No', health: 'No', rotate: true,
  },
];
