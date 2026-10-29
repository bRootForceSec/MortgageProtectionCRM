// States where everyone on a call must agree before it's recorded ("all-party" or "two-party" consent). Elsewhere one
// side's consent is enough. This is the commonly cited list, kept on the cautious side: Michigan, Oregon and Connecticut
// are included although their rules are narrower or argued about. It isn't legal advice; check it before you record.

export const ALL_PARTY_CONSENT_STATES: Readonly<Record<string, string>> = {
  CA: 'California', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', IL: 'Illinois', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MT: 'Montana', NV: 'Nevada', NH: 'New Hampshire', OR: 'Oregon', PA: 'Pennsylvania', WA: 'Washington',
};

/** Whether recording a call to a lead in this state (two-letter code) needs everyone's consent. */
export function needsAllPartyConsent(state: string | null | undefined): boolean {
  return !!state && Object.hasOwn(ALL_PARTY_CONSENT_STATES, state.toUpperCase());
}
