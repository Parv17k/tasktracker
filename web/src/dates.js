// Date helpers for the UI: presets, input conversions and quick-add parsing.

export const toDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n, from = new Date()) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + n);

function nextMonday() {
  const d = new Date();
  const delta = ((8 - d.getDay()) % 7) || 7;
  return addDays(delta);
}

export const DUE_PRESETS = [
  { label: 'Today', value: () => toDateStr(new Date()) },
  { label: 'Tomorrow', value: () => toDateStr(addDays(1)) },
  { label: 'In 2 days', value: () => toDateStr(addDays(2)) },
  { label: 'Next week', value: () => toDateStr(nextMonday()) },
  { label: 'In 2 weeks', value: () => toDateStr(addDays(14)) },
];

/** Split a stored due value into the strings that <input type=date|time> expect. */
export function dueToInputs(dueAt, hasTime) {
  if (!dueAt) return { date: '', time: '' };
  if (!hasTime) return { date: dueAt.slice(0, 10), time: '' };
  const d = new Date(dueAt);
  return { date: toDateStr(d), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
}

/** Combine date/time inputs (local time) into the API format. */
export function inputsToDue(date, time) {
  if (!date) return null;
  if (!time) return date;
  return new Date(`${date}T${time}`).toISOString();
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const PRIORITY_ALIASES = { low: 'low', l: 'low', med: 'medium', medium: 'medium', m: 'medium', high: 'high', h: 'high', urgent: 'urgent', u: 'urgent', '!': 'urgent' };

function parseDueToken(tok) {
  const t = tok.toLowerCase().replace(/[-_]/g, '');
  if (t === 'today' || t === 'tod') return toDateStr(new Date());
  if (t === 'tomorrow' || t === 'tmrw' || t === 'tom') return toDateStr(addDays(1));
  if (t === 'nextweek' || t === 'nw') return toDateStr(nextMonday());
  let m = /^(\d+)([dw])$/.exec(t);
  if (m) return toDateStr(addDays(Number(m[1]) * (m[2] === 'w' ? 7 : 1)));
  const wd = WEEKDAYS.findIndex((w) => t.startsWith(w) && w.length >= 3);
  if (wd >= 0 && /^[a-z]+$/.test(t)) {
    const delta = ((wd - new Date().getDay() + 7) % 7) || 7;
    return toDateStr(addDays(delta));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok) && !Number.isNaN(Date.parse(tok))) return tok;
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(tok); // M/D
  if (m) {
    const now = new Date();
    let d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d < addDays(0)) d = new Date(now.getFullYear() + 1, Number(m[1]) - 1, Number(m[2]));
    return toDateStr(d);
  }
  return null;
}

/**
 * Quick-add syntax: "Write report @fri !high"
 *   @today @tomorrow @mon..@sun @nextweek @3d @2w @2026-10-12 @10/12   → deadline
 *   !low !med !high !urgent                                             → priority
 */
export function parseQuickAdd(input) {
  let dueAt = null;
  let priority = null;
  const title = input
    .replace(/(^|\s)@(\S+)/g, (whole, sp, tok) => {
      const d = parseDueToken(tok);
      if (!d) return whole;
      dueAt = d;
      return sp;
    })
    .replace(/(^|\s)!(\S+)/g, (whole, sp, tok) => {
      const p = PRIORITY_ALIASES[tok.toLowerCase()];
      if (!p) return whole;
      priority = p;
      return sp;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { title, dueAt, priority };
}
