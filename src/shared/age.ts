// Small helpers the server and the UI both need.

/** Whole years between a date of birth (YYYY-MM-DD) and `at`. */
export function ageOn(dob: string, at: Date = new Date()): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  let age = at.getFullYear() - y;
  if (at.getMonth() + 1 < m || (at.getMonth() + 1 === m && at.getDate() < d)) age--;
  return age;
}
