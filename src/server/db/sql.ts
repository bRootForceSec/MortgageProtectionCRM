/** An SQL list of fixed strings, e.g. `('new', 'retry')`. Only for values written in the code, never input. */
export function sqlList(values: readonly string[]): string {
  return values.length ? `(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})` : '(NULL)';
}

/** The lead's full name, in a query over `lead l`. */
export const LEAD_NAME = "trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,''))";

/** In a query over `call_outcome o`: `o` is its call's current outcome, since outcomes are never changed, only superseded. */
export const CURRENT_OUTCOME = 'NOT EXISTS (SELECT 1 FROM call_outcome sup WHERE sup.supersedes_id = o.id)';
