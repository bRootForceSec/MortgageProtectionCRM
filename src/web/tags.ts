import { useCallback, useEffect, useState } from 'react';
import { api, type Tag } from './api';
import { useApp } from './App';

/** Your tags, loaded once per screen, with a way to load them again after a change. */
export function useTags() {
  const { toast } = useApp();
  const [tags, setTags] = useState<Tag[]>([]);
  const reload = useCallback(
    () => api.get<Tag[]>('/tags').then(setTags).catch((e: Error) => toast(`Couldn't load tags: ${e.message}`, 'error')),
    [toast],
  );
  useEffect(() => void reload(), [reload]);
  const tagName = useCallback((id: string) => tags.find((t) => t.id === id)?.name, [tags]);
  return { tags, reload, tagName };
}
