// Task estimates, shared by the web UI, the chat assistant and the MCP server.
// Stored as minutes. Sizes are just friendly names for common amounts, so totals still add up.

export const HOURS_PER_DAY = 8;
export const MAX_ESTIMATE = 60 * HOURS_PER_DAY * 60; // 60 working days

export const SIZES = [
  { key: 'XS', label: 'Extra small', minutes: 30 },
  { key: 'S', label: 'Small', minutes: 60 },
  { key: 'M', label: 'Medium', minutes: 4 * 60 },
  { key: 'L', label: 'Large', minutes: HOURS_PER_DAY * 60 },
  { key: 'XL', label: 'Extra large', minutes: 3 * HOURS_PER_DAY * 60 },
];

/** The size whose amount matches exactly, if any. */
export const sizeOf = (minutes) => SIZES.find((s) => s.minutes === minutes) || null;

/**
 * Parse "M", "xl", "30m", "1.5h", "2h30m", "1d", "1d 4h" or a bare number of hours.
 * Returns minutes, null for an empty value (= clear), or throws on anything else.
 */
export function parseEstimate(input) {
  if (input == null) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`“${input}” isn’t an estimate`);
    return check(Math.round(input));
  }
  const raw = String(input).trim().replace(/^~/, '').toLowerCase();
  if (!raw) return null;
  const size = SIZES.find((s) => s.key.toLowerCase() === raw);
  if (size) return size.minutes;
  if (/^\d+(\.\d+)?$/.test(raw)) return check(Math.round(Number(raw) * 60));
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/g;
  let total = 0;
  let used = '';
  for (const m of raw.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2][0];
    total += unit === 'd' ? n * HOURS_PER_DAY * 60 : unit === 'h' ? n * 60 : n;
    used += m[0];
  }
  if (!total || used.replace(/\s/g, '') !== raw.replace(/\s/g, '')) throw new Error(`“${input}” isn’t an estimate. Try M, 2h, 90m or 1d.`);
  return check(Math.round(total));
}

function check(minutes) {
  if (minutes > MAX_ESTIMATE) throw new Error('That estimate is too large (the limit is 60 working days).');
  return minutes || null;
}

/** "30m", "4h", "1h 30m", "1d", "2d 4h": short and readable. */
export function formatEstimate(minutes) {
  if (!minutes) return '';
  const dayMin = HOURS_PER_DAY * 60;
  if (minutes >= dayMin && minutes % 60 === 0) {
    const d = Math.floor(minutes / dayMin);
    const h = (minutes % dayMin) / 60;
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Total hours for totals and cost ("~32h"), rounded to a sensible step. */
export function formatHours(minutes) {
  if (!minutes) return '0h';
  const h = minutes / 60;
  return h < 10 ? `${Math.round(h * 2) / 2}h` : `${Math.round(h)}h`;
}

/** Money in a project's currency, e.g. "$320" or "€1,280". */
export function formatMoney(amount, currency = 'USD') {
  try {
    // whole amounts stay whole ("$60"); small fractional amounts keep cents ("$12.50")
    const cents = amount < 100 && Math.round(amount * 100) % 100 !== 0;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}

export const costOf = (minutes, hourlyRate) => (hourlyRate && minutes ? (minutes / 60) * hourlyRate : 0);
