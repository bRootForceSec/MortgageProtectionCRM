/** An SQL list of fixed strings, e.g. `('new', 'retry')`. Only for values written in the code, never input. */
export function sqlList(values: readonly string[]): string {
  return values.length ? `(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})` : '(NULL)';
}
