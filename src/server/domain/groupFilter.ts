// One filter for every list of leads or calls: by the county a lead was bought for, and by area code,
// where an area code always means "every county linked to that code" (never the lead's own phone number).
// Search boxes follow the same rule: a bare 3-digit number is a county area code; longer numbers search phones.

export interface GroupFilter {
  counties?: string[];
  areaCodes?: string[];
}

export function parseList(v?: string | null): string[] {
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

/** SQL condition (with its named parameters) limiting `countyCol` to the chosen counties and area codes. */
export function groupWhere(countyCol: string, f: GroupFilter): { sql: string; params: Record<string, unknown> } {
  const counties = (f.counties ?? []).filter(Boolean);
  const codes = (f.areaCodes ?? []).filter((c) => /^\d{3}$/.test(c));
  if (!counties.length && !codes.length) return { sql: '1', params: {} };
  return {
    sql: `(${countyCol} IN (SELECT value FROM json_each(@gf_counties))
           OR ${countyCol} IN (SELECT county_key FROM county_area_code WHERE area_code IN (SELECT value FROM json_each(@gf_codes))))`,
    params: { gf_counties: JSON.stringify(counties), gf_codes: JSON.stringify(codes) },
  };
}

/**
 * Search box condition over a lead aliased `l`: name, county name, a county area code (3 digits),
 * or part of a phone number (4+ digits, any of the lead's numbers).
 */
export function searchWhere(search?: string | null): { sql: string; params: Record<string, unknown> } {
  const s = search?.trim().toLowerCase() ?? '';
  if (!s) return { sql: '1', params: {} };
  const digits = s.replace(/\D/g, '');
  if (/^\(?\d{3}\)?$/.test(s)) {
    return {
      sql: 'l.county_key IN (SELECT county_key FROM county_area_code WHERE area_code = @sw_code)',
      params: { sw_code: digits },
    };
  }
  const phone = digits.length >= 4 && digits.length >= s.replace(/\s/g, '').length - 4;
  return {
    sql: `(lower(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) LIKE @sw_like
           OR lower(coalesce(l.county,'')) LIKE @sw_like
           ${phone ? `OR l.id IN (SELECT lead_id FROM lead_number WHERE e164 LIKE @sw_dlike)` : ''})`,
    params: { sw_like: `%${s}%`, ...(phone ? { sw_dlike: `%${digits}%` } : {}) },
  };
}
