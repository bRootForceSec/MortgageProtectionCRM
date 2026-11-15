import * as z from 'zod/v4';

// Text templates: messages you send a lead from your phone, with [[field]] filled in from the lead. The Calling
// screen shows the filled-in text as a QR code (your phone's camera offers to copy it) and a Copy button, so you paste
// it into whatever app you text from. Each one you send is a line in the lead's log (kind `texted`).

export const TextTemplate = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'give the text a name').max(60),
  body: z.string().max(1000),
});
export type TextTemplate = z.infer<typeof TextTemplate>;

export const TextTemplates = z
  .array(TextTemplate)
  .max(30)
  .refine((ts) => new Set(ts.map((t) => t.name.toLowerCase())).size === ts.length, 'two texts have the same name')
  .refine((ts) => new Set(ts.map((t) => t.id)).size === ts.length, 'two texts have the same id');

/** The lead's own fields a text can fill in. Your fields work too, by name (`[[Spouse]]`), and so do the sheet's other columns. */
export const TEXT_FIELDS = [
  { id: 'first_name', label: 'First name' },
  { id: 'last_name', label: 'Last name' },
  { id: 'full_name', label: 'Full name' },
  { id: 'lender', label: 'Lender' },
  { id: 'loan_amount', label: 'Loan amount, like $245,000' },
  { id: 'address', label: 'Street address' },
  { id: 'city', label: 'City' },
  { id: 'state', label: 'State' },
  { id: 'zip', label: 'ZIP' },
  { id: 'county', label: 'County' },
  { id: 'age', label: 'Age' },
  { id: 'email', label: 'Email' },
  { id: 'lead_id', label: 'Lead ID from the sheet' },
  { id: 'appointment', label: 'Their appointment, like Tuesday, Nov 18 at 3:00 PM' },
  { id: 'my_name', label: 'Your name (Settings → Calling)' },
] as const;

export const STARTER_TEXTS: TextTemplate[] = [
  {
    id: 'first_touch',
    name: 'First touch',
    body: "Hi [[first_name]], it's [[my_name]]. I'm reaching out about the mortgage protection info you requested on your home loan with [[lender]]. When's a good time for a quick call?",
  },
  {
    id: 'missed_you',
    name: 'Missed you',
    body: "Hi [[first_name]], [[my_name]] here. Just tried calling about your mortgage protection request. I'll only need a few minutes. Is today or tomorrow better?",
  },
  {
    id: 'old_lead',
    name: 'Old lead',
    body: "Hi [[first_name]], it's [[my_name]]. A while back you asked about protecting your mortgage in [[city]]. Is that still something you'd like to look at?",
  },
  {
    id: 'no_show',
    name: 'No-show',
    body: "Hi [[first_name]], it's [[my_name]]. Sorry we missed each other for our appointment. When works to reschedule?",
  },
];

const PLACEHOLDER = /\[\[\s*([^[\]]+?)\s*\]\]/g;

/** The [[...]] names in a text, once each, as written. */
export function placeholdersIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) if (!out.some((x) => x.toLowerCase() === m[1]!.toLowerCase())) out.push(m[1]!);
  return out;
}

/** The text with each [[name]] filled in from `values` (any case). `missing` lists the ones this lead has nothing for; they're left blank. */
export function fillText(body: string, values: Record<string, string | null | undefined>): { text: string; missing: string[] } {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v?.trim() ?? '']));
  const missing: string[] = [];
  const text = body.replace(PLACEHOLDER, (_, name: string) => {
    const v = lower.get(name.toLowerCase()) ?? '';
    if (!v && !missing.includes(name)) missing.push(name);
    return v;
  });
  // A blank left "Hi , it's" or a double space: tidy it up.
  return { text: text.replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(), missing };
}

/** "JOHN" or "john" reads "John"; a name already in mixed case stays as typed (McDonald, DeShawn). */
export function niceName(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  if (!t || (t !== t.toUpperCase() && t !== t.toLowerCase())) return t;
  return t.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}
