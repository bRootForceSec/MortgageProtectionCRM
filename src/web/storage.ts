// Preferences kept in this browser. Storage can be blocked or full (private windows, cleared site data),
// so every read falls back and every write is best-effort: losing a preference must never break the page.

/** The saved value, or null when there is none or storage is unavailable. */
export function getStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Saves a value; null removes it. */
export function setStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference just isn't kept */
  }
}

/** The saved JSON value, or null when there is none, it doesn't parse, or storage is unavailable. */
export function getStoredJson<T>(key: string): T | null {
  try {
    return JSON.parse(getStored(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

export function setStoredJson(key: string, value: unknown): void {
  setStored(key, JSON.stringify(value));
}
