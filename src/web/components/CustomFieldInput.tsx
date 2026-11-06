import type { CustomFieldType } from '../../shared/customFields';

/** The input for one custom field's value, fit to its kind. `value` is what you typed (or the kept value). */
export function CustomFieldInput(props: {
  field: { label: string; type: CustomFieldType; options: string[] };
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  /** Text shown for "no value" in the lists. */
  blank?: string;
}) {
  const { field: f, value, onChange } = props;
  const aria = props.ariaLabel ?? f.label;
  if (f.type === 'yes_no' || f.type === 'choice') {
    const opts = f.type === 'yes_no' ? [['yes', 'Yes'], ['no', 'No']] : f.options.map((o) => [o, o]);
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={aria}>
        <option value="">{props.blank ?? '—'}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }
  return (
    <input
      type={f.type === 'date' ? 'date' : 'text'}
      inputMode={f.type === 'number' || f.type === 'money' ? 'decimal' : undefined}
      placeholder={f.type === 'money' ? '$' : props.blank}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={aria}
      autoComplete="off"
    />
  );
}
