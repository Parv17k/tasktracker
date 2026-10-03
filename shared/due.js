// Human-friendly deadline labels, shared by the web UI and the MCP server.
// Due values are either 'YYYY-MM-DD' (a whole day, local time) or a full ISO datetime.

const DAY = 86400000;

export function parseDueDate(dueAt) {
  if (!dueAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueAt);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dueAt);
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const calendarDays = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);

function span(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const fmtDate = (d, withYear) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * @returns {{label: string, short: string, tone: 'overdue'|'today'|'soon'|'upcoming'|'later', date: Date, days: number} | null}
 */
export function dueInfo(dueAt, hasTime = false, now = new Date()) {
  const date = parseDueDate(dueAt);
  if (!date || Number.isNaN(date.getTime())) return null;
  const days = calendarDays(now, date);
  const diff = date - now;
  const at = hasTime ? ` · ${fmtTime(date)}` : '';

  if (hasTime && diff < 0) return { label: `Overdue by ${span(-diff)}`, short: `-${span(-diff)}`, tone: 'overdue', date, days };
  if (!hasTime && days < 0) {
    const label = days === -1 ? 'Overdue · yesterday' : `Overdue by ${-days}d`;
    return { label, short: `-${-days}d`, tone: 'overdue', date, days };
  }
  if (days === 0) {
    if (hasTime && diff < 12 * 3600000) return { label: `Due in ${span(diff)}`, short: span(diff), tone: 'today', date, days };
    return { label: `Due today${at}`, short: 'Today', tone: 'today', date, days };
  }
  if (days === 1) return { label: `Due tomorrow${at}`, short: 'Tmrw', tone: 'soon', date, days };
  if (days <= 6) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return { label: `Due in ${days} days · ${weekday}${at}`, short: `${days}d`, tone: days <= 2 ? 'soon' : 'upcoming', date, days };
  }
  if (days <= 13) return { label: `Due next week · ${fmtDate(date)}`, short: fmtDate(date), tone: 'upcoming', date, days };
  if (days <= 56) return { label: `Due in ${Math.round(days / 7)} weeks · ${fmtDate(date)}`, short: fmtDate(date), tone: 'later', date, days };
  return { label: `Due ${fmtDate(date, date.getFullYear() !== now.getFullYear())}`, short: fmtDate(date), tone: 'later', date, days };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
