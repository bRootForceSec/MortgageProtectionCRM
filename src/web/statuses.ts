import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useApp } from './App';
import type { StatusInfo } from '../shared/statuses';

/** Your statuses (named conditions), loaded once per screen, with how many leads are in each. */
export function useStatuses() {
  const { toast } = useApp();
  const [statuses, setStatuses] = useState<StatusInfo[]>([]);
  const reload = useCallback(
    () => api.get<StatusInfo[]>('/statuses').then(setStatuses).catch((e: Error) => toast(`Couldn't load statuses: ${e.message}`, 'error')),
    [toast],
  );
  useEffect(() => void reload(), [reload]);
  const statusName = useCallback((id: string) => statuses.find((s) => s.id === id)?.name, [statuses]);
  return { statuses, setStatuses, reload, statusName };
}
