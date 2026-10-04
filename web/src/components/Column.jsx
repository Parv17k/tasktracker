import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowDownToLine, ArrowLeft, ArrowRight, CalendarClock, CheckCircle2, EyeOff, MoreHorizontal, Palette, Pencil, Plus, Trash2 } from 'lucide-react';
import { useBoard } from '../store';
import { COLUMN_COLORS } from '../themes';
import { parseQuickAdd } from '../dates';
import { dueInfo } from '../../../shared/due.js';
import { TaskCard, PRIORITY, PriorityIcon } from './TaskCard';
import { toneClass } from './Due';
import { ColorDot, cx, IconButton, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from './ui';

export function Column({ column, taskIds, tasksById, totalCount, filtered, isFirst, isLast, onRemove }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${column.id}`, data: { type: 'column' } });
  const [renaming, setRenaming] = useState(false);
  const quickAddOpen = useBoard((s) => s.quickAddColumn === column.id);
  const setQuickAdd = useBoard((s) => s.setQuickAdd);
  const dragging = useBoard((s) => s.dragging);
  const empty = taskIds.length === 0;

  return (
    <section
      className={cx(
        'flex max-h-full w-[300px] shrink-0 flex-col rounded-[calc(var(--radius)+6px)] bg-surface/70 ring-1 transition-shadow',
        dragging && isOver ? 'ring-2 ring-accent/50' : 'ring-line/60'
      )}
    >
      <header className="group/col flex items-center gap-2 px-3 pb-2 pt-3">
        <ColorDot color={column.color} />
        {renaming ? (
          <RenameInput column={column} onDone={() => setRenaming(false)} />
        ) : (
          <h2 onDoubleClick={() => setRenaming(true)} className="font-display min-w-0 truncate text-[15px] text-fg" title="Double-click to rename">
            {column.name}
          </h2>
        )}
        <span className="rounded-full bg-hover px-1.5 text-[11px] font-medium tabular-nums text-muted">{filtered ? `${taskIds.length}/${totalCount}` : totalCount}</span>
        {column.isDone && <CheckCircle2 className="size-3.5 text-ok" aria-label="Done column" />}
        <div className="ml-auto flex items-center">
          <IconButton size="sm" label="Add task" onClick={() => setQuickAdd(column.id)}>
            <Plus className="size-4" />
          </IconButton>
          <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/col:opacity-100 has-[[data-state=open]]:opacity-100">
            <ColumnMenu column={column} isFirst={isFirst} isLast={isLast} onRename={() => setRenaming(true)} onRemove={onRemove} />
          </div>
        </div>
      </header>

      {quickAddOpen && (
        <div className="px-2 pb-2">
          <QuickAdd column={column} onClose={() => setQuickAdd(null)} />
        </div>
      )}

      <div ref={setNodeRef} className={cx('flex min-h-6 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 transition-colors', isOver && !empty && 'rounded-lg bg-accent-soft/40')}>
        <SortableContext id={`col-${column.id}`} items={taskIds} strategy={verticalListSortingStrategy}>
          {taskIds.map((id) => (
            <TaskCard key={id} task={tasksById.get(id)} isDone={column.isDone} />
          ))}
        </SortableContext>
        {/* empty columns: a quiet, text-free drop slot that wakes up while dragging */}
        {empty && !quickAddOpen && (
          <div
            aria-hidden
            className={cx(
              'flex h-16 items-center justify-center rounded-[var(--radius)] border-2 border-dashed transition-colors duration-150',
              isOver ? 'border-accent bg-accent-soft/50 text-accent' : dragging ? 'border-line-strong text-muted' : 'border-line/70 text-faint/70'
            )}
          >
            <ArrowDownToLine className="size-4" />
          </div>
        )}
      </div>
    </section>
  );
}

function RenameInput({ column, onDone }) {
  const updateColumn = useBoard((s) => s.updateColumn);
  const [name, setName] = useState(column.name);
  const commit = () => {
    if (name.trim() && name.trim() !== column.name) updateColumn(column.id, { name: name.trim() });
    onDone();
  };
  return (
    <input
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
      maxLength={60}
      className="font-display min-w-0 flex-1 rounded-md border border-accent bg-card px-1.5 py-0.5 text-[15px] outline-none"
    />
  );
}

function ColumnMenu({ column, isFirst, isLast, onRename, onRemove }) {
  const { updateColumn, shiftColumn } = useBoard.getState();
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton size="sm" label="Column options">
          <MoreHorizontal className="size-4" />
        </IconButton>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onRename}>
          <Pencil /> Rename
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>
            <Palette /> Color
          </MenuSubTrigger>
          <MenuSubContent className="grid grid-cols-4 gap-1 p-2">
            {COLUMN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                onClick={() => updateColumn(column.id, { color: c })}
                className={cx('flex size-8 items-center justify-center rounded-lg hover:bg-hover', column.color === c && 'bg-hover ring-1 ring-line-strong')}
              >
                <ColorDot color={c} className="size-4" />
              </button>
            ))}
          </MenuSubContent>
        </MenuSub>
        <MenuItem onSelect={() => updateColumn(column.id, { isDone: !column.isDone })}>
          <CheckCircle2 /> {column.isDone ? 'Unmark as done column' : 'Mark as done column'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={isFirst} onSelect={() => shiftColumn(column.id, -1)}>
          <ArrowLeft /> Move left
        </MenuItem>
        <MenuItem disabled={isLast} onSelect={() => shiftColumn(column.id, 1)}>
          <ArrowRight /> Move right
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => updateColumn(column.id, { hidden: true })}>
          <EyeOff /> Hide column
        </MenuItem>
        <MenuItem danger onSelect={onRemove}>
          <Trash2 /> Remove column…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function QuickAdd({ column, onClose }) {
  const createTask = useBoard((s) => s.createTask);
  const [value, setValue] = useState('');
  const ref = useRef(null);
  const parsed = parseQuickAdd(value);
  const due = dueInfo(parsed.dueAt, false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  const submit = () => {
    if (!parsed.title) return;
    createTask({ title: parsed.title, columnId: column.id, dueAt: parsed.dueAt ?? undefined, priority: parsed.priority ?? undefined, placement: 'top' });
    setValue('');
  };

  return (
    <div className="rounded-[var(--radius)] border border-accent/60 bg-card p-2 shadow-card">
      <textarea
        ref={ref}
        rows={2}
        value={value}
        placeholder="What needs doing?"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') onClose();
        }}
        onBlur={() => !value.trim() && onClose()}
        className="w-full bg-transparent text-[13.5px] leading-snug outline-none placeholder:text-faint"
      />
      <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-[11px]">
        {due && (
          <span className={cx('inline-flex h-5 items-center gap-1 rounded-md px-1.5 font-medium', toneClass[due.tone])}>
            <CalendarClock className="size-3" /> {due.label}
          </span>
        )}
        {parsed.priority && (
          <span className="inline-flex h-5 items-center gap-1 rounded-md bg-hover px-1.5 font-medium text-muted">
            <PriorityIcon priority={parsed.priority} /> {PRIORITY[parsed.priority].label}
          </span>
        )}
        {!due && !parsed.priority && (
          <span className="text-faint">
            Try <span className="font-mono">@tomorrow</span> <span className="font-mono">@fri</span> <span className="font-mono">!high</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-faint">
          <Kbd>↵</Kbd> add
        </span>
      </div>
    </div>
  );
}

export function AddColumn() {
  const createColumn = useBoard((s) => s.createColumn);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const submit = () => {
    if (name.trim()) createColumn({ name: name.trim(), color: COLUMN_COLORS[Math.floor(Math.random() * COLUMN_COLORS.length)] });
    setName('');
    setOpen(false);
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-11 w-[260px] shrink-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius)+6px)] border border-dashed border-line-strong text-[13px] text-muted transition-colors hover:border-accent hover:bg-surface/60 hover:text-fg"
      >
        <Plus className="size-4" /> Add column
      </button>
    );
  return (
    <div className="w-[260px] shrink-0 rounded-[calc(var(--radius)+6px)] bg-surface/70 p-2 ring-1 ring-line/60">
      <input
        autoFocus
        value={name}
        placeholder="Column name"
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') {
            setName('');
            setOpen(false);
          }
        }}
        className="h-9 w-full rounded-lg border border-accent bg-card px-2.5 text-[13.5px] outline-none"
      />
    </div>
  );
}
