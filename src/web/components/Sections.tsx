import type { ReactNode } from 'react';

// A page in sections with a menu at the top to jump between them: Settings and Automation.

export interface Section { id: string; title: string; help: string; cards: () => ReactNode }

export function SectionedPage({ label, sections }: { label: string; sections: readonly Section[] }) {
  return (
    <>
      <nav className="settings-nav" aria-label={`${label} sections`}>
        {sections.map((s) => (
          <button key={s.id} className="btn small" title={s.help} aria-label={`${s.title} ${label.toLowerCase()}`} onClick={() => document.getElementById(s.id)?.scrollIntoView({ block: 'start' })}>{s.title}</button>
        ))}
      </nav>
      {sections.map((s) => (
        <section key={s.id} id={s.id} className="settings-section" aria-labelledby={`${s.id}-title`}>
          <h1 id={`${s.id}-title`}>{s.title}</h1>
          <p className="help">{s.help}</p>
          {s.cards()}
        </section>
      ))}
    </>
  );
}
