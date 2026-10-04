import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, Check, ChevronDown, GripVertical, MoreHorizontal, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { formatDuration } from '../../../shared/due.js';
import { useBoard } from '../store';
import { DuePicker } from './Due';
import { TagEditor } from './Tags';
import { PRIORITY, PriorityIcon } from './TaskCard';
import { Button, ColorDot, cx, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Sheet, useNow } from './ui';

/** Textarea that grows with its content and autosaves (debounced + on blur). */
function AutoField({ value, onSave, className, placeholder, singleLine, autoFocus, minRows = 1 }) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const timer = useRef();
  const ref = useRef(null);

  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [local]);

  const flush = (v = local) => {
    clearTimeout(timer.current);
    if (v !== value && !(singleLine && !v.trim())) onSave(v);
  };

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={local}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        flush();
        if (singleLine && !local.trim()) setLocal(value);
      }}
      onChange={(e) => {
        const v = singleLine ? e.target.value.replace(/\n/g, ' ') : e.target.value;
        setLocal(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(v), 600);
      }}
      onKeyDown={(e) => {
        if (singleLine && e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={cx('block w-full overflow-hidden bg-transparent outline-none placeholder:text-faint', className)}
    />
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-3 py-1.5">
      <div className="pt-1.5 text-[12px] text-faint">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Section({ title, aside, children }) {
  return (
    <section className="px-6 py-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StatusPicker({ task }) {
  const columns = useBoard((s) => s.columns);
  const moveTask = useBoard((s) => s.moveTask);
  const current = columns.find((c) => c.id === task.columnId);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5 text-[13px] hover:bg-hover">
          <ColorDot color={current?.color} />
          {current?.name}
          {current?.hidden && <span className="text-faint">(hidden)</span>}
          <ChevronDown className="size-3.5 text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        {columns
          .filter((c) => !c.hidden)
          .map((c) => (
            <MenuItem key={c.id} onSelect={() => c.id !== task.columnId && moveTask(task.id, c.id, 0)}>
              <ColorDot color={c.color} /> <span className="flex-1">{c.name}</span>
              {c.id === task.columnId && <Check className="!text-accent" />}
            </MenuItem>
          ))}
      </MenuContent>
    </Menu>
  );
}

function PriorityPicker({ task }) {
  const updateTask = useBoard((s) => s.updateTask);
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5">
      {Object.entries(PRIORITY).map(([key, p]) => (
        <button
          key={key}
          type="button"
          title={p.label}
          onClick={() => updateTask(task.id, { priority: key })}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors',
            task.priority === key ? 'bg-accent-soft text-fg shadow-sm' : 'text-muted hover:text-fg'
          )}
        >
          {key === 'none' ? 'None' : <PriorityIcon priority={key} />}
          {key !== 'none' && <span className="hidden sm:inline">{p.label}</span>}
        </button>
      ))}
    </div>
  );
}

function TimeTracker({ task }) {
  const { startTimer, stopTimer } = useBoard.getState();
  const running = !!task.timerStartedAt;
  const now = useNow(1000, running);
  const total = task.timeSpent + (running ? Math.max(0, (now - Date.parse(task.timerStartedAt)) / 1000) : 0);
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant={running ? 'primary' : 'outline'} onClick={() => (running ? stopTimer(task.id) : startTimer(task.id))}>
        {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        {running ? 'Pause' : total ? 'Resume' : 'Start timer'}
      </Button>
      <span className={cx('font-mono text-[13px] tabular-nums', running ? 'text-accent' : 'text-muted')}>{total ? formatDuration(total) : '—'}</span>
      {running && <span className="pulse size-1.5 rounded-full bg-accent" />}
    </div>
  );
}

function Subtasks({ task }) {
  const { addSubtask, updateSubtask, deleteSubtask } = useBoard.getState();
  const [draft, setDraft] = useState('');
  const done = task.subtasks.filter((s) => s.done).length;
  const total = task.subtasks.length;

  return (
    <Section
      title="Subtasks"
      aside={
        total > 0 && (
          <span className="flex flex-1 items-center gap-2 text-[11px] tabular-nums text-faint">
            {done}/{total}
            <span className="h-1 max-w-[120px] flex-1 overflow-hidden rounded-full bg-hover">
              <span className="block h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${(done / total) * 100}%` }} />
            </span>
          </span>
        )
      }
    >
      <ul className="-mx-2">
        {task.subtasks.map((s) => (
          <li key={s.id} className="group/sub flex items-start gap-2 rounded-lg px-2 py-1 hover:bg-hover/60">
            <GripVertical className="mt-1 size-3.5 shrink-0 text-transparent" />
            <button
              type="button"
              aria-label={s.done ? 'Mark not done' : 'Mark done'}
              onClick={() => updateSubtask(task.id, s.id, { done: !s.done })}
              className={cx(
                'mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                s.done ? 'border-ok bg-ok text-card' : 'border-line-strong hover:border-ok'
              )}
            >
              {s.done && <Check className="size-3" strokeWidth={3.5} />}
            </button>
            <AutoField
              singleLine
              value={s.title}
              onSave={(title) => updateSubtask(task.id, s.id, { title })}
              className={cx('text-[13.5px] leading-[22px]', s.done && 'text-muted line-through decoration-faint')}
            />
            <button
              type="button"
              aria-label="Delete subtask"
              onClick={() => deleteSubtask(task.id, s.id)}
              className="mt-0.5 rounded p-0.5 text-faint opacity-0 hover:text-danger group-hover/sub:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-center gap-2 rounded-lg px-0 py-1">
        <Plus className="ml-[22px] size-4 shrink-0 text-faint" />
        <input
          value={draft}
          placeholder="Add a subtask…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              addSubtask(task.id, draft.trim());
              setDraft('');
            }
          }}
          className="h-7 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
        />
      </div>
    </Section>
  );
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function TaskSheet() {
  const selectedId = useBoard((s) => s.selectedId);
  const task = useBoard((s) => s.tasks.find((t) => t.id === s.selectedId));
  const { select, updateTask, archiveTask, deleteTask } = useBoard.getState();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // keep showing the last task while the sheet animates closed
  const last = useRef(task);
  if (task) last.current = task;
  const t = task || last.current;

  useEffect(() => setConfirmDelete(false), [selectedId]);

  // the task disappeared (archived/deleted elsewhere) — close; wait for the board to load first
  const loaded = useBoard((s) => s.loaded);
  useEffect(() => {
    if (loaded && selectedId != null && !task) select(null);
  }, [loaded, selectedId, task, select]);

  return (
    <Sheet
      open={selectedId != null && !!task}
      onOpenChange={(o) => !o && select(null)}
      title={t ? `Task #${t.id}` : ''}
      header={
        t && (
          <>
            <Button size="sm" variant="ghost" onClick={() => archiveTask(t.id)}>
              <Archive className="size-3.5" /> Archive
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent>
                <MenuItem
                  danger
                  onSelect={(e) => {
                    if (!confirmDelete) {
                      e.preventDefault();
                      setConfirmDelete(true);
                    } else deleteTask(t.id);
                  }}
                >
                  <Trash2 /> {confirmDelete ? 'Click again to delete forever' : 'Delete permanently'}
                </MenuItem>
                <MenuSeparator />
                <div className="px-2.5 py-1.5 text-[11px] leading-relaxed text-faint">
                  Created {fmt(t.createdAt)}
                  <br />
                  Updated {fmt(t.updatedAt)}
                  {t.completedAt && (
                    <>
                      <br />
                      Completed {fmt(t.completedAt)}
                    </>
                  )}
                </div>
              </MenuContent>
            </Menu>
          </>
        )
      }
    >
      {t && (
        <div key={t.id} className="pb-10">
          <div className="px-6 pb-2 pt-5">
            <AutoField singleLine value={t.title} onSave={(title) => updateTask(t.id, { title })} className="font-display text-[24px] leading-tight text-fg" placeholder="Task title" />
          </div>

          <div className="px-6 pb-2">
            <Row label="Status">
              <StatusPicker task={t} />
            </Row>
            <Row label="Priority">
              <PriorityPicker task={t} />
            </Row>
            <Row label="Deadline">
              <DuePicker dueAt={t.dueAt} hasTime={t.dueHasTime} onChange={(dueAt) => updateTask(t.id, { dueAt, dueHasTime: !!dueAt && dueAt.length > 10 })} />
            </Row>
            <Row label="Time spent">
              <TimeTracker task={t} />
            </Row>
            <Row label="Tags">
              <TagEditor value={t.tags || []} onChange={(tags) => updateTask(t.id, { tags }).then(() => useBoard.getState().refreshTags(), () => {})} />
            </Row>
          </div>

          <div className="mx-6 h-px bg-line" />

          <Section title="Description">
            <AutoField value={t.description} onSave={(description) => updateTask(t.id, { description })} minRows={3} placeholder="Add details, context, links…" className="text-[14px] leading-relaxed" />
          </Section>

          <Subtasks task={t} />

          <Section title="Note">
            <div className="note-paper rounded-lg border border-line px-3 py-1.5 shadow-card">
              <AutoField value={t.note} onSave={(note) => updateTask(t.id, { note })} minRows={3} placeholder="Scratchpad — thoughts, progress, follow-ups…" className="text-[13.5px] !leading-[24px]" />
            </div>
          </Section>
        </div>
      )}
    </Sheet>
  );
}
