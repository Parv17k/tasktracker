import { forwardRef, useMemo } from 'react';
import { Archive, Check, Eye, EyeOff, Paintbrush, Plus, Search, X } from 'lucide-react';
import { dueInfo } from '../../../shared/due.js';
import { useBoard } from '../store';
import { THEMES } from '../themes';
import { Button, ColorDot, cx, IconButton, Kbd, Popover, PopoverContent, PopoverTrigger, Tip } from './ui';

export const TopBar = forwardRef(function TopBar({ onOpenArchive }, searchRef) {
  const query = useBoard((s) => s.query);
  const dueFilter = useBoard((s) => s.dueFilter);
  const { setQuery, setDueFilter, setQuickAdd } = useBoard.getState();
  const columns = useBoard((s) => s.columns);
  const tasks = useBoard((s) => s.tasks);

  const stats = useMemo(() => {
    const doneCols = new Set(columns.filter((c) => c.isDone).map((c) => c.id));
    const hiddenCols = new Set(columns.filter((c) => c.hidden).map((c) => c.id));
    let open = 0;
    let overdue = 0;
    let week = 0;
    for (const t of tasks) {
      if (doneCols.has(t.columnId) || hiddenCols.has(t.columnId)) continue;
      open++;
      const info = dueInfo(t.dueAt, t.dueHasTime);
      if (info?.tone === 'overdue') overdue++;
      if (info && info.days <= 7) week++;
    }
    return { open, overdue, week };
  }, [columns, tasks]);

  const firstColumn = columns.find((c) => !c.hidden && !c.isDone) || columns.find((c) => !c.hidden);

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 pb-4 pt-5">
      <div className="flex items-center gap-3">
        <Logo />
        <div className="leading-tight">
          <h1 className="font-display text-[22px] text-fg">Task Tracker</h1>
          <p className="text-[12px] text-muted">
            {stats.open} open
            {stats.overdue > 0 && <span className="text-danger"> · {stats.overdue} overdue</span>}
            {stats.week > 0 && <span> · {stats.week} due this week</span>}
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        <label className="group relative flex h-8 w-full max-w-[260px] items-center rounded-lg border border-line bg-card/70 pl-8 pr-2 transition-colors focus-within:border-accent">
          <Search className="absolute left-2.5 size-3.5 text-faint" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())}
            placeholder="Search tasks"
            className="h-full w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-faint hover:text-fg">
              <X className="size-3.5" />
            </button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </label>

        <div className="inline-flex h-8 items-center rounded-lg border border-line bg-card/70 p-0.5 text-[12px]">
          {[
            ['all', 'All'],
            ['week', 'Due this week'],
            ['overdue', 'Overdue'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDueFilter(key)}
              className={cx('h-full rounded-md px-2.5 transition-colors', dueFilter === key ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:text-fg')}
            >
              {label}
              {key === 'overdue' && stats.overdue > 0 && <span className="ml-1 rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">{stats.overdue}</span>}
            </button>
          ))}
        </div>

        <HiddenColumns />

        <Tip label="Archived tasks">
          <Button variant="ghost" onClick={onOpenArchive} aria-label="Archived tasks">
            <Archive className="size-4" />
          </Button>
        </Tip>

        <ThemePicker />

        <Button variant="primary" onClick={() => firstColumn && setQuickAdd(firstColumn.id)}>
          <Plus className="size-4" /> New task <span className="ml-0.5 rounded bg-accent-fg/15 px-1 font-mono text-[10px]">N</span>
        </Button>
      </div>
    </header>
  );
});

/** Brand mark (see docs/brand), tinted with the active theme's accent. */
function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="size-9 shrink-0 drop-shadow-sm" role="img" aria-label="TaskTracker">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <rect x="13" y="15" width="9" height="34" rx="3" fill="var(--accent-fg)" />
      <rect x="27" y="15" width="9" height="22" rx="3" fill="var(--accent-fg)" fillOpacity=".55" />
      <path d="M40.5 33.5 L45.5 39 L53 26" fill="none" stroke="var(--accent-fg)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HiddenColumns() {
  const columns = useBoard((s) => s.columns);
  const hidden = useMemo(() => columns.filter((c) => c.hidden), [columns]);
  const tasks = useBoard((s) => s.tasks);
  const updateColumn = useBoard((s) => s.updateColumn);
  if (!hidden.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost">
          <EyeOff className="size-4" /> Hidden <span className="rounded-full bg-hover px-1.5 text-[11px] tabular-nums">{hidden.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5">
        <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-faint">Hidden columns</p>
        {hidden.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
            <ColorDot color={c.color} />
            <span className="flex-1 truncate text-[13px]">{c.name}</span>
            <span className="text-[11px] text-faint">{tasks.filter((t) => t.columnId === c.id).length} tasks</span>
            <Button size="sm" variant="outline" onClick={() => updateColumn(c.id, { hidden: false })}>
              <Eye className="size-3.5" /> Show
            </Button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ThemePicker() {
  const theme = useBoard((s) => s.theme);
  const setTheme = useBoard((s) => s.setTheme);
  return (
    <Popover>
      <Tip label="Theme">
        <PopoverTrigger asChild>
          <IconButton aria-label="Theme">
            <Paintbrush className="size-4" />
          </IconButton>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="max-h-[min(85vh,640px)] w-[min(94vw,600px)] overflow-y-auto p-3">
        <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-faint">Theme</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {THEMES.map((t) => {
            const [bg, card, ink, accent] = t.swatch;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                className={cx('group overflow-hidden rounded-xl border text-left transition-all hover:-translate-y-0.5', theme === t.id ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong')}
              >
                <div className="flex h-14 gap-1 p-2" style={{ background: bg }}>
                  {[0.9, 0.6, 0.35].map((h, i) => (
                    <div key={i} className="flex flex-1 flex-col gap-1 rounded-md p-1" style={{ background: `color-mix(in oklab, ${ink} 6%, ${bg})` }}>
                      <div className="h-1.5 rounded-sm" style={{ background: card, width: `${h * 100}%`, boxShadow: `0 0 0 1px color-mix(in oklab, ${ink} 10%, transparent)` }} />
                      {i === 0 && <div className="h-1.5 w-2/3 rounded-sm" style={{ background: accent }} />}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-fg">{t.name}</div>
                    <div className="truncate text-[11px] text-faint">{t.tagline}</div>
                  </div>
                  {theme === t.id && <Check className="size-4 shrink-0 text-accent" />}
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
