import { SectionedPage, type Section } from '../components/Sections';
import { ButtonsCard } from './ButtonsCard';
import { CustomFieldsCard } from './CustomFieldsCard';
import { FunnelStepsCard } from './FunnelStepsCard';
import { RoutinesCard } from './RoutinesCard';
import { RulesCard } from './RulesCard';
import { StatusesCard } from './StatusesCard';
import { TagsCard } from './TagsCard';

// Automation: everything that shapes how you work, apart from Settings. Tags go on leads; smart lists read tags (and
// each other); rules do things when something happens; the Calling screen's buttons; your fields; the funnel.

const SECTIONS: Section[] = [
  { id: 'automation-tags', title: 'Tags', help: 'Your labels on leads: what puts them on, never dial, and tags that come off by themselves.', cards: () => <TagsCard /> },
  { id: 'automation-lists', title: 'Smart lists', help: 'Named groups of leads, built from tags and other smart lists.', cards: () => <StatusesCard /> },
  { id: 'automation-rules', title: 'Rules', help: 'When this happens, for leads like these, do that.', cards: () => <><RulesCard /><RoutinesCard /></> },
  { id: 'automation-calling', title: 'Calling screen', help: 'The buttons on the Calling screen: names, keys, what they tag and when they show.', cards: () => <ButtonsCard /> },
  { id: 'automation-fields', title: 'Fields', help: 'Your own fields and formulas on leads, and when they show.', cards: () => <CustomFieldsCard /> },
  { id: 'automation-funnel', title: 'Funnel', help: 'Your funnel steps, for the top bar, the funnel graphic and Reports.', cards: () => <FunnelStepsCard /> },
];

export function AutomationPage() {
  return <SectionedPage label="Automation" sections={SECTIONS} />;
}
