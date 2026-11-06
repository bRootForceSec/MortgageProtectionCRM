import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useApp } from './App';
import type { CustomField } from '../shared/customFields';

/** Your custom fields, in order, loaded once per screen, with a way to load them again after a change. */
export function useCustomFields() {
  const { toast } = useApp();
  const [fields, setFields] = useState<CustomField[]>([]);
  const reload = useCallback(
    () => api.get<CustomField[]>('/custom-fields').then(setFields).catch((e: Error) => toast(`Couldn't load your fields: ${e.message}`, 'error')),
    [toast],
  );
  useEffect(() => void reload(), [reload]);
  const fieldName = useCallback((id: string) => fields.find((f) => f.id === id)?.label, [fields]);
  return { fields, setFields, reload, fieldName };
}
