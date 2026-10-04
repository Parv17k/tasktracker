import { useState } from 'react';
import { CalendarClock, Clock, X } from 'lucide-react';
import { dueInfo } from '../../../shared/due.js';
import { DUE_PRESETS, dueToInputs, inputsToDue, toDateStr } from '../dates';
import { cx, useNow } from './ui';

export const toneClass = {
  overdue: 'bg-danger/12 text-danger',
  today: 'bg-warn/15 text-warn',
  soon: 'bg-warn/10 text-warn',
  upcoming: 'bg-hover text-muted',
  later: 'text-faint',
};

export function DueChip({ dueAt, hasTime, done, compact }) {
  const now = useNow(30000, !!dueAt);
  const info = dueInfo(dueAt, hasTime, now);
  if (!info) return null;
  return (
    <span
      title={info.date.toLocaleString(undefined, { dateStyle: 'full', ...(hasTime ? { timeStyle: 'short' } : {}) })}
      className={cx(
        'inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums',
        done ? 'text-faint line-through decoration-1' : toneClass[info.tone]
      )}
    >
      <CalendarClock className="size-3" />
      {compact ? info.short : info.label}
    </span>
  );
}

/** Deadline editor: presets for speed, date + optional time for precision. */
export function DuePicker({ dueAt, hasTime, onChange }) {
  const { date, time } = dueToInputs(dueAt, hasTime);
  const [showTime, setShowTime] = useState(!!time);
  const now = useNow(30000, !!dueAt);
  const info = dueInfo(dueAt, hasTime, now);

  const set = (d, t) => onChange(inputsToDue(d, t));

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {DUE_PRESETS.map((p) => {
          const v = p.value();
          const active = date === v && !time;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => set(v, showTime ? time : '')}
              className={cx(
                'h-7 rounded-full border px-3 text-[12px] transition-colors',
                active ? 'border-accent bg-accent text-accent-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg'
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => set(e.target.value, showTime ? time : '')}
          className="h-8 rounded-lg border border-line bg-bg/60 px-2 text-[13px] outline-none focus:border-accent"
        />
        {showTime ? (
          <span className="flex items-center gap-1">
            <input
              type="time"
              value={time}
              onChange={(e) => set(date || DUE_PRESETS[0].value(), e.target.value)}
              className="h-8 rounded-lg border border-line bg-bg/60 px-2 text-[13px] outline-none focus:border-accent"
            />
            <button
              type="button"
              aria-label="Remove time"
              onClick={() => {
                setShowTime(false);
                if (date) set(date, '');
              }}
              className="rounded p-1 text-faint hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setShowTime(true)} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12px] text-muted hover:bg-hover hover:text-fg">
            <Clock className="size-3.5" /> Add time
          </button>
        )}
        {dueAt && (
          <button type="button" onClick={() => onChange(null)} className="ml-auto h-8 rounded-lg px-2 text-[12px] text-faint hover:bg-hover hover:text-danger">
            Clear
          </button>
        )}
      </div>
      {info && <div className={cx('inline-flex rounded-md px-2 py-1 text-[12px] font-medium', toneClass[info.tone])}>{info.label}</div>}
    </div>
  );
}

/** The local day ('YYYY-MM-DD') of a deadline, whether it's a whole day or has a time. */
export function dueDay(dueAt) {
  if (!dueAt) return null;
  return dueAt.length === 10 ? dueAt : toDateStr(new Date(dueAt));
}

/** Optional start date: turns the task into a span on the timeline. Can't be after the deadline. */
export function StartPicker({ startAt, dueAt, onChange }) {
  const max = dueDay(dueAt) || undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        aria-label="Start date"
        value={startAt || ''}
        max={max}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 rounded-lg border border-line bg-bg/60 px-2 text-[13px] outline-none focus:border-accent"
      />
      {!startAt && (
        <button type="button" onClick={() => onChange(max && toDateStr(new Date()) > max ? max : toDateStr(new Date()))} className="inline-flex h-8 items-center rounded-lg px-2 text-[12px] text-muted hover:bg-hover hover:text-fg">
          Today
        </button>
      )}
      {startAt ? (
        <button type="button" onClick={() => onChange(null)} className="ml-auto h-8 rounded-lg px-2 text-[12px] text-faint hover:bg-hover hover:text-danger">
          Clear
        </button>
      ) : (
        <span className="text-[11.5px] text-faint">Optional · shows the task as a span on the timeline</span>
      )}
    </div>
  );
}
