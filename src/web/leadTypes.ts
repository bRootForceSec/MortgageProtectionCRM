import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useApp } from './App';
import type { LeadType } from './importTypes';

/** The lead types (D, B, FE-A…), loaded once per screen, with a way to load them again after a change. */
export function useLeadTypes() {
  const { toast } = useApp();
  const [types, setTypes] = useState<LeadType[]>([]);
  const reload = useCallback(
    () => api.get<LeadType[]>('/lead-types').then(setTypes).catch((e: Error) => toast(`Couldn't load lead types: ${e.message}`, 'error')),
    [toast],
  );
  useEffect(() => void reload(), [reload]);
  return { types, reload };
}
