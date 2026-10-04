// A calm Gantt: one row per task, a bar from start to deadline (or ◆ when there's only a
// deadline), today marked, and drag to reschedule. Used per project and on the home page.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { dueInfo } from '../../../shared/due.js';
import { toDateStr } from '../dates';
import { dueDay } from './Due';
import { cx, Tip } from './ui';

const LABEL_W = 240;
const ROW_H = 34;
export const ZOOMS = {
  weeks: { dayW: 34, label: 'Weeks' },
  months: { dayW: 11, label: 'Months' },
};

// whole days as integers (UTC-based, so daylight saving never shifts a bar)
const toDay = (str) => {
  const [y, m, d] = str.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const dayDate = (n) => {
  const [y, m, d] = fromDay(n).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const weekday = (n) => (n + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
const fmt = (n, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => dayDate(n).toLocaleDateString(undefined, opts);

/** Start and end day of a task on the timeline, or null when it has no deadline. */
export function span(task) {
  if (!task.dueAt) return null;
  const end = toDay(dueDay(task.dueAt));
  const start = task.startAt ? Math.min(toDay(task.startAt), end) : null;
  return { start, end };
}

/** New API values after moving a task's start/end by whole days (keeps the deadline's time of day). */
export function reschedule(task, { start, end }) {
  const out = {};
  const old = span(task);
  if (end !== old.end) {
    if (task.dueHasTime) {
      const d = new Date(task.dueAt);
      d.setDate(d.getDate() + (end - old.end));
      out.dueAt = d.toISOString();
    } else out.dueAt = fromDay(end);
  }
  if (start !== old.start) out.startAt = start == null ? null : fromDay(start);
  return out;
}

export function useZoom() {
  const [zoom, setZoom] = useState(() => localStorage.getItem('tt-timeline-zoom') || 'weeks');
  return [zoom, (z) => (localStorage.setItem('tt-timeline-zoom', z), setZoom(z))];
}

export function ZoomToggle({ zoom, onChange }) {
  return (
    <div className="inline-flex h-8 items-center rounded-lg border border-line bg-card/70 p-0.5 text-[12px]" role="radiogroup" aria-label="Timeline zoom">
      {Object.entries(ZOOMS).map(([key, z]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={zoom === key}
          onClick={() => onChange(key)}
          className={cx('h-full rounded-md px-2.5 transition-colors', zoom === key ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:text-fg')}
        >
          {z.label}
        </button>
      ))}
    </div>
  );
}

/**
 * sections: [{ id, label, color, rows: [{ task, label?, color }], collapsible?, collapsed?, onToggle?, summary? }]
 * Each section is a header row; its rows are tasks. `summary` (home page) draws the section's
 * deadlines on its header row when collapsed.
 */
export function Timeline({ sections, zoom = 'weeks', onOpen, onReschedule, footer, empty }) {
  const dayW = ZOOMS[zoom].dayW;
  const today = toDay(toDateStr(new Date()));
  const scroller = useRef(null);
  // the chart always fills the visible width, even when there's little to show
  const [viewW, setViewW] = useState(1200);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const allTasks = sections.flatMap((s) => [...s.rows.map((r) => r.task), ...(s.summary || [])]);
  const { from, to } = useMemo(() => {
    let lo = today - 14;
    let hi = today + 42;
    for (const t of allTasks) {
      const sp = span(t);
      if (!sp) continue;
      lo = Math.min(lo, (sp.start ?? sp.end) - 7);
      hi = Math.max(hi, sp.end + 14);
    }
    lo -= (weekday(lo) + 6) % 7; // start on a Monday
    lo = Math.max(lo, today - 730);
    hi = Math.max(Math.min(hi, today + 730), lo + Math.ceil((viewW - LABEL_W) / dayW));
    return { from: lo, to: hi };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, viewW, dayW, allTasks.map((t) => `${t.startAt}|${t.dueAt}`).join()]);
  const days = to - from + 1;
  const width = days * dayW;
  const x = (day) => (day - from) * dayW;

  // open with today about a week in from the left edge
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - 7 * dayW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // live drag state: { id, start, end }
  const [preview, setPreview] = useState(null);

  if (!allTasks.some(span)) {
    return (
      <div className="mx-6 rounded-2xl border border-dashed border-line px-6 py-14 text-center">
        <p className="font-display text-[18px] text-fg">Nothing on the timeline yet</p>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">{empty || 'Give tasks a deadline, and optionally a start date, to see them here.'}</p>
        {footer && <div className="mt-4">{footer}</div>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto overscroll-x-contain">
        <div className="relative" style={{ width: LABEL_W + width }}>
          <Scale from={from} days={days} dayW={dayW} zoom={zoom} today={today} />
          {/* weekends, month lines and today, behind the rows */}
          <Backdrop from={from} days={days} dayW={dayW} zoom={zoom} today={today} />
          {sections.map((s) => (
            <Fragment key={s.id}>
              <SectionRow section={s} x={x} dayW={dayW} today={today} onOpen={onOpen} />
              {!s.collapsed &&
                s.rows.map((r) => (
                  <TaskRow
                    key={r.task.id}
                    row={r}
                    x={x}
                    dayW={dayW}
                    today={today}
                    preview={preview?.id === r.task.id ? preview : null}
                    setPreview={setPreview}
                    onOpen={onOpen}
                    onReschedule={onReschedule}
                  />
                ))}
            </Fragment>
          ))}
          {/* breathing room under the last row; the label column stays covered */}
          <div className="relative z-[1] flex h-6">
            <div className="sticky left-0 shrink-0 bg-[var(--tl-bg,var(--bg))]" style={{ width: LABEL_W }} />
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}

function Scale({ from, days, dayW, zoom, today }) {
  const months = [];
  const ticks = [];
  for (let i = 0; i < days; i++) {
    const n = from + i;
    const d = dayDate(n);
    if (d.getDate() === 1 || i === 0)
      months.push({
        n,
        label: d.toLocaleDateString(undefined, {
          month: 'long',
          year: d.getMonth() === 0 || i === 0 ? 'numeric' : undefined,
        }),
      });
    if (zoom === 'weeks' || weekday(n) === 1) ticks.push({ n, d });
  }
  return (
    <div className="sticky top-0 z-20 flex border-b border-line bg-[var(--tl-bg,var(--bg))]">
      <div className="sticky left-0 z-10 shrink-0 bg-[var(--tl-bg,var(--bg))]" style={{ width: LABEL_W }} />
      <div className="relative h-12" style={{ width: days * dayW }}>
        {months.map((m) => (
          <div key={m.n} className="absolute top-1.5 whitespace-nowrap pl-1.5 text-[12px] font-medium text-fg" style={{ left: (m.n - from) * dayW }}>
            {m.label}
          </div>
        ))}
        {ticks.map(({ n, d }) => {
          const isToday = n === today;
          return (
            <div
              key={n}
              className={cx('absolute bottom-1 text-center text-[10.5px] tabular-nums', isToday ? 'font-semibold text-accent' : weekday(n) % 6 === 0 ? 'text-faint/70' : 'text-faint')}
              style={{
                left: (n - from) * dayW,
                width: zoom === 'weeks' ? dayW : 7 * dayW,
              }}
            >
              {zoom === 'weeks'
                ? d.getDate()
                : d.toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Backdrop({ from, days, dayW, zoom, today }) {
  const sat = (6 - weekday(from) + 7) % 7; // first Saturday's offset
  const monthStarts = [];
  for (let i = 1; i < days; i++) if (dayDate(from + i).getDate() === 1) monthStarts.push(i);
  return (
    <div aria-hidden className="pointer-events-none absolute bottom-0 top-12 z-0" style={{ left: LABEL_W, width: days * dayW }}>
      {zoom === 'weeks' && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(to right, color-mix(in oklab, var(--text) 4%, transparent) 0 ${2 * dayW}px, transparent ${2 * dayW}px)`,
            backgroundSize: `${7 * dayW}px 100%`,
            backgroundPosition: `${sat * dayW}px 0`,
          }}
        />
      )}
      {monthStarts.map((i) => (
        <div key={i} className="absolute inset-y-0 w-px bg-line" style={{ left: i * dayW }} />
      ))}
      <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-accent/70" style={{ left: (today - from) * dayW + dayW / 2 }}>
        <span className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full bg-accent" />
      </div>
    </div>
  );
}

function SectionRow({ section: s, x, dayW, today, onOpen }) {
  const Chevron = s.collapsed ? ChevronRight : ChevronDown;
  const head = (
    <>
      {s.collapsible && <Chevron className="size-3.5 shrink-0 text-faint" />}
      {s.icon ? <span className="text-[14px] leading-none">{s.icon}</span> : <span data-color={s.color} className="size-2 shrink-0 rounded-full bg-[var(--col)]" />}
      <span className="truncate font-medium text-fg">{s.label}</span>
      {s.hint && <span className="shrink-0 text-faint">{s.hint}</span>}
    </>
  );
  return (
    <div className="relative z-[1] flex border-b border-line/60" style={{ height: s.summary ? ROW_H + 6 : 30 }}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center bg-[var(--tl-bg,var(--bg))] px-3 text-[12.5px]" style={{ width: LABEL_W }}>
        {s.collapsible ? (
          <button type="button" onClick={s.onToggle} aria-expanded={!s.collapsed} className="-mx-1.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-hover">
            {head}
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">{head}</div>
        )}
      </div>
      {s.summary && s.collapsed && <Summary tasks={s.summary} color={s.color} x={x} dayW={dayW} today={today} onOpen={onOpen} />}
    </div>
  );
}

/** A project at a glance: a thin line across its dated work, ◆ at each open deadline. */
function Summary({ tasks, color, x, dayW, today, onOpen }) {
  const spans = tasks.map((t) => ({ t, sp: span(t) })).filter((s) => s.sp);
  if (!spans.length) return null;
  const lo = Math.min(...spans.map(({ sp }) => sp.start ?? sp.end));
  const hi = Math.max(...spans.map(({ sp }) => sp.end));
  return (
    <div className="relative flex-1" data-color={color}>
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--bar)] opacity-35" style={{ left: x(lo) + dayW / 2, width: Math.max(4, x(hi) - x(lo)) }} />
      {spans.map(({ t, sp }) => {
        const info = dueInfo(t.dueAt, t.dueHasTime);
        const overdue = info?.tone === 'overdue';
        return (
          <Tip key={t.id} label={`${t.title} · ${info?.label ?? ''}`}>
            <button
              type="button"
              aria-label={`${t.title}, ${info?.label ?? ''}`}
              onClick={() => onOpen(t)}
              className={cx(
                'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-2 ring-bg transition-transform hover:scale-125',
                overdue ? 'bg-danger' : 'bg-[var(--bar)]'
              )}
              style={{ left: x(sp.end) + dayW / 2 }}
            />
          </Tip>
        );
      })}
    </div>
  );
}

function TaskRow({ row, x, dayW, today, preview, setPreview, onOpen, onReschedule }) {
  const { task } = row;
  const base = span(task);
  const sp = preview || base;
  const info = dueInfo(task.dueAt, task.dueHasTime);
  const overdue = !row.done && info?.tone === 'overdue';
  const drag = useRef(null);
  const track = useRef(null); // stays mounted while a ◆ turns into a bar mid-drag, so it owns the pointer

  const begin = (e, mode) => {
    if (e.button !== 0 || !onReschedule) return;
    e.preventDefault();
    e.stopPropagation();
    track.current.setPointerCapture(e.pointerId);
    drag.current = { mode, x0: e.clientX, moved: false, base };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (!d.moved) return;
    const delta = Math.round((e.clientX - d.x0) / dayW);
    const { start, end } = d.base;
    let next;
    if (d.mode === 'move') next = { start: start == null ? null : start + delta, end: end + delta };
    else if (d.mode === 'end') next = { start, end: Math.max(end + delta, start ?? -Infinity) };
    else next = { start: Math.min((start ?? end) + delta, end), end };
    setPreview({ id: task.id, ...next });
  };
  const finish = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) return onOpen(task);
    const next = preview ? { start: preview.start, end: preview.end } : d.base;
    setPreview(null);
    if (next.start !== d.base.start || next.end !== d.base.end) onReschedule(task, reschedule(task, next));
  };
  const cancel = () => {
    drag.current = null;
    setPreview(null);
  };

  // keyboard: ←/→ moves a day, Shift+←/→ changes the deadline, Alt+←/→ the start
  const onKey = (e) => {
    if (e.key === 'Enter') return onOpen(task);
    if (!onReschedule || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !base) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const { start, end } = base;
    let next;
    if (e.shiftKey) next = { start, end: Math.max(end + dir, start ?? -Infinity) };
    else if (e.altKey) next = { start: Math.min((start ?? end) + dir, end), end };
    else next = { start: start == null ? null : start + dir, end: end + dir };
    onReschedule(task, reschedule(task, next));
  };

  const dates = sp && (sp.start != null && sp.start !== sp.end ? `${fmt(sp.start)} → ${fmt(sp.end)}` : fmt(sp.end));
  const tip = `${task.title}\n${dates}${info ? ` · ${info.label}` : ''}`;
  const handlers = {
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: cancel,
    onLostPointerCapture: () => drag.current && finish(),
  };

  return (
    <div className="group/row relative z-[1] flex hover:bg-hover/40" style={{ height: ROW_H }}>
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="sticky left-0 z-10 flex shrink-0 items-center gap-2 bg-[var(--tl-bg,var(--bg))] pl-7 pr-3 text-left text-[13px] group-hover/row:bg-[color-mix(in_oklab,var(--hover)_40%,var(--tl-bg,var(--bg)))]"
        style={{ width: LABEL_W }}
      >
        {row.color && <span data-color={row.color} className="size-1.5 shrink-0 rounded-full bg-[var(--col)]" />}
        <span className={cx('truncate', row.done ? 'text-faint line-through decoration-faint' : 'text-fg')}>{row.label ?? task.title}</span>
      </button>
      <div ref={track} className="relative flex-1" data-color={row.barColor} {...handlers}>
        {sp &&
          (sp.start == null ? (
            // deadline only: a diamond, with a handle on its left to pull out a start date
            <div className="absolute inset-y-0" style={{ left: x(sp.end) - 14, width: dayW + 28 }}>
              {onReschedule && (
                <span
                  title="Drag left to add a start date"
                  onPointerDown={(e) => begin(e, 'start')}

                  className="absolute left-[calc(50%-20px)] top-1/2 h-4 w-3 -translate-y-1/2 cursor-ew-resize rounded-sm opacity-0 transition-opacity group-hover/row:bg-line-strong group-hover/row:opacity-100"
                />
              )}
              <Tip label={tip}>
                <button
                  type="button"
                  aria-label={`${task.title}: ${dates}. Drag or use arrow keys to reschedule.`}
                  onPointerDown={(e) => begin(e, 'move')}
                  onKeyDown={onKey}

                  className={cx(
                    'absolute left-1/2 top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 touch-none rounded-[3px] ring-2 ring-bg outline-none transition-transform focus-visible:ring-accent',
                    onReschedule ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                    overdue ? 'bg-danger' : 'bg-[var(--bar)]',
                    row.done && 'opacity-35',
                    preview && 'scale-125'
                  )}
                />
              </Tip>
            </div>
          ) : (
            <div
              className="absolute top-1/2 h-5 -translate-y-1/2"
              style={{
                left: x(sp.start) + 2,
                width: x(sp.end) - x(sp.start) + dayW - 4,
              }}
            >
              <Tip label={tip}>
                <button
                  type="button"
                  aria-label={`${task.title}: ${dates}. Drag or use arrow keys to reschedule.`}
                  onPointerDown={(e) => begin(e, 'move')}
                  onKeyDown={onKey}

                  className={cx(
                    'absolute inset-0 touch-none rounded-[5px] bg-[var(--bar)] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
                    onReschedule ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                    overdue && 'ring-2 ring-danger ring-offset-1 ring-offset-bg',
                    row.done && 'opacity-35',
                    preview && 'shadow-lift'
                  )}
                />
              </Tip>
              {onReschedule && (
                <>
                  <span
                    title="Drag to change the start"
                    onPointerDown={(e) => begin(e, 'start')}

                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-[5px] hover:bg-black/15"
                  />
                  <span
                    title="Drag to change the deadline"
                    onPointerDown={(e) => begin(e, 'end')}

                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-[5px] hover:bg-black/15"
                  />
                </>
              )}
            </div>
          ))}
        {/* while dragging: the dates it will land on; otherwise only overdue gets a word */}
        {sp && (preview || overdue) && (
          <span
            className={cx('pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-2 text-[11px] font-medium', preview ? 'text-fg' : 'text-danger')}
            style={{ left: x(sp.end) + dayW + (sp.start == null ? 4 : 0) }}
          >
            {preview ? dates : info.label}
          </span>
        )}
      </div>
    </div>
  );
}

/** Collapsible list of tasks that have no deadline, so they stay reachable but out of the way. */
export function Undated({ tasks, onOpen, label = 'without a deadline' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!tasks.length) setOpen(false);
  }, [tasks.length]);
  if (!tasks.length) return null;
  return (
    <div className="border-t border-line px-6 py-2.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {tasks.length} task{tasks.length === 1 ? '' : 's'} {label}
      </button>
      {open && (
        <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pb-1">
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpen(t)}
              className="max-w-64 truncate rounded-lg border border-line bg-card px-2.5 py-1 text-[12.5px] text-fg shadow-card hover:border-line-strong"
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
