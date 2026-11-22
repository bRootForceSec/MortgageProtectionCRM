import * as z from 'zod/v4';

// What every AI reader is asked to do with one lead page, and the shape of its answer.
// Adapted from Alistair's "AI Prompt Lead Conversion" rules: blank beats a guess, read handwriting digit
// by digit, labelled fields only. The app does the spreadsheet, duplicate and formatting work itself.

export const PROMPT_VERSION = 'lead-page-v6';

const val = z.string().nullable();

export const PageAnswer = z.object({
  is_lead: z.boolean().describe('false when the page holds no lead (blank, cover sheet, instructions)'),
  layout: z.enum(['call_in_notice', 'mailer_card', 'crm_notes', 'online_form', 'other']),
  turn: z
    .enum(['0', '90', '180', '270'])
    .describe('degrees to turn the page clockwise so its printed text reads normally, left to right; "0" when it already does'),
  fields: z.object({
    full_name: val,
    coborrower: val.describe("co-borrower's or spouse's name when printed, else Yes/No as printed"),
    coborrower_age: val.describe("co-borrower's age as printed (CB Age)"),
    coborrower_dob: val.describe("co-borrower's or spouse's date of birth exactly as printed"),
    coborrower_gender: val.describe("co-borrower's or spouse's gender or sex as printed"),
    age: val,
    dob: val.describe('date of birth exactly as printed; null when the page has none'),
    lender: val,
    loan_amount: val,
    address: val,
    city: val,
    state: val.describe('two-letter state code'),
    zip: val,
    county: val.describe('county as printed on the page; null when the page has no county'),
    source_lead_id: val.describe('the labelled Mortgage Identification Number only'),
    callin_date: val.describe('the labelled call-in date and time, exactly as printed'),
    phone: val.describe('Contact Phone Number; on other layouts the first phone number on the page'),
    email: val.describe('email address; null when blank or the word "null"'),
    passphrase: val.describe('the code word or password the lead gave (CODE WORD, or "PW ..." in call notes); never the web login password printed on letters'),
    comments: val.describe("anything the lead wrote for the agent: Comments, or a Requested Changes column, with what it corrects"),
  }),
  details: z
    .array(z.object({ label: z.string().describe('the label as printed, e.g. Beneficiary, Gender, Coverage Amount'), value: z.string() }))
    .describe('other labelled facts on the page that none of the fields above hold; leave out boilerplate, web logins, Call At and best time to call'),
  other_phones: z
    .array(
      z.object({
        number: z.string().describe('the number exactly as printed or written'),
        label: z.string().describe('what the page calls it (Alternate, Called in from, Home, Cell, Work, Other); empty when unlabelled'),
      }),
    )
    .describe('every other phone number on the page, in the order shown; leave out repeats of a number already given'),
  uncertain: z
    .array(
      z.object({
        field: z.string().describe('one of the keys in fields, or other_phones'),
        best_reading: val.describe('your best reading, or null'),
        reason: z.string(),
      }),
    )
    .describe('fields printed on the page that were hard to read or that you are not sure of; leave out fields this page does not have'),
  notes: val.describe('one short sentence when something about the page needs explaining, else null'),
});
export type PageAnswer = z.infer<typeof PageAnswer>;

export const PAGE_PROMPT = `You are doing data entry for an insurance agent. The attached PDF is ONE page from a pack of mortgage protection leads. Read it and fill in the fields.

Layouts you may see:
- "Mortgage Protection Call-in Delivery Notice": typed, two columns. Left column has labelled fields (Mortgage Identification Number, Call-in Date & Time, Last Action, Borrower Name, Co-Borrower, Borrower Age, Date of Birth (some versions), Lender, Mortgage Amount, Borrower Address, City, State, Zip Code, County). Right column has Called in From, Contact Phone Number, Alternate Phone Number. The paragraph text ("Our records indicate...", "THE REFERENCED MORTGAGE...") is boilerplate, never field data.
- Scanned mailer cards or postcards, often rotated, with handwritten phone numbers.
- CRM note pages or online lead forms.
- Forms or letters with several phone boxes (Home, Cell, Work, Other) for the borrower and spouse.
- "Telemarketing Call Center" info requests (mortgage protection or final expense), with a code word and beneficiary.
- Call-center printouts: Name, Address, Phone list, Status, Date Added, then call notes.

Rules:
1. Never invent a value. If a field is missing, ambiguous or illegible, return null for it.
2. Handwriting: read phone numbers digit by digit. Only return a value when every digit is clear. Otherwise return null and add an "uncertain" entry with your best reading and why.
3. Only use labelled values. source_lead_id is only the labelled Mortgage Identification Number or MORTGAGE ID#, never a mailer code. callin_date is the labelled Call-in Date & Time; when the page has none, use "Date Generated" (telemarketing pages) or "Date Added" (call-center printouts). Never a Record Date, a loan date or a postmark. Copy it exactly as printed.
4. Names may wrap onto two lines; join them. Keep the spelling and hyphens as printed. A couple is one lead: when the page prints both names together ("Jessica Moore & Kyle Moore"), copy that into full_name as printed; when each person has a column, the first is full_name and the second is coborrower. The co-borrower's date of birth, age and gender go in the coborrower_ fields.
5. Call-center notes follow a pattern: each person's first name with NT (no tobacco) or T and their age ("KAREN NT 67"), "PW" then the code word, the lender, the loan amount, and who the beneficiary is. Read those as lender, loan_amount, passphrase, age, coborrower and details (Beneficiary). Put the rest of the agent's typed notes in comments, but leave out the call log lines that start with "--".
6. Lender names may be cut off by the form. Copy what is printed; do not complete them.
7. county: only when the page prints a county. Do not work it out from the city.
8. Handwritten marks (X, "NO NEED", strike-throughs) do not change printed values. Mention them in notes.
9. Put a field in "uncertain" whenever it is printed or written on the page and you were not fully sure of it, even if you returned a value. Do not list fields the page simply does not have (for example a mailer card has no county, call-in date or Mortgage Identification Number): just return null for those.
10. notes: null for a straightforward page.
11. Phone numbers: put the Contact Phone Number (or, on other layouts, the first number on the page) in phone, and every other phone number on the page in other_phones with the label the page gives it: Alternate, Called in from, Home, Cell, Work, Other, or empty. Include all of them, however many there are, in the order shown, but list each number only once. A 9-digit number is a Mortgage ID, never a phone. If a call-in notice has no Contact Phone Number, put the Called in From number in phone and say so in notes. Ignore "Call At" ticks and best-time-to-call boxes.
12. turn: look at the page as it is shown. If the printed text runs sideways or upside down, give how many degrees clockwise the page must be turned so it reads normally ("90" when the text runs bottom to top, "270" when it runs top to bottom, "180" when it is upside down). Otherwise "0".`;

/** JSON Schema of the answer, for readers that take one directly (Claude Code CLI, OpenAI-compatible servers). */
export function answerJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(PageAnswer, { target: 'draft-7' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
