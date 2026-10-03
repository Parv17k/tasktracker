import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Archive, Check, ListChecks, StickyNote, Timer, AlignLeft } from 'lucide-react';
import { useBoard } from '../store';
import { DueChip } from './Due';
import { cx, Tip } from './ui';

export const PRIORITY = {
  none: { label: 'No priority', cls: '' },
  low: { label: 'Low', cls: 'text-faint', bars: 1 },
  medium: { label: 'Medium', cls: 'text-accent', bars: 2 },
  high: { label: 'High', cls: 'text-warn', bars: 3 },
  urgent: { label: 'Urgent', cls: 'text-danger', bars: 3 },
};

export function PriorityIcon({ priority, className }) {
  const p = PRIORITY[priority];
  if (!p?.bars) return null;
  if (priority === 'urgent')
    return (
      <span className={cx('inline-flex size-3.5 items-center justify-center rounded-[3px] bg-danger text-[10px] font-bold leading-none text-white', className)}>!</span>
    );
  return (
    <svg viewBox="0 0 14 14" className={cx('size-3.5', p.cls, className)} aria-label={p.label}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4.2} y={9 - i * 3} width="3" height={3.5 + i * 3} rx="1" fill="currentColor" opacity={i < p.bars ? 1 : 0.22} />
      ))}
    </svg>
  );
}

function CardBody({ task, isDone, overlay }) {
  const archiveTask = useBoard((s) => s.archiveTask);
  const completeTask = useBoard((s) => s.completeTask);
  const total = task.subtasks.length;
  const done = task.subtasks.filter((s) => s.done).length;

  return (
    <div
      className={cx(
        'group/card relative rounded-[var(--radius)] border border-line bg-card px-3 py-2.5 shadow-card transition-[border-color,box-shadow,transform] duration-150',
        'hover:border-line-strong',
        overlay && 'rotate-[1.5deg] cursor-grabbing border-line-strong shadow-lift'
      )}
    >
      <div className="flex items-start gap-2">
        <Tip label={isDone ? 'Completed' : 'Mark complete'}>
          <button
            type="button"
            aria-label="Mark complete"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!isDone) completeTask(task.id);
            }}
            className={cx(
              'mt-[1px] flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
              isDone ? 'border-ok bg-ok text-white' : 'border-line-strong text-transparent hover:border-ok hover:text-ok'
            )}
          >
            <Check className="size-2.5" strokeWidth={3.5} />
          </button>
        </Tip>
        <p className={cx('min-w-0 flex-1 text-[13.5px] leading-snug [overflow-wrap:anywhere]', isDone ? 'text-muted line-through decoration-faint' : 'text-fg')}>{task.title}</p>
        <button
          type="button"
          aria-label="Archive task"
          title="Archive"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            archiveTask(task.id);
          }}
          className="-mr-1 -mt-0.5 rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/card:opacity-100"
        >
          <Archive className="size-3.5" />
        </button>
      </div>

      {(task.dueAt || total > 0 || task.priority !== 'none' || task.note || task.description || task.timerStartedAt) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted">
          <PriorityIcon priority={task.priority} />
          <DueChip dueAt={task.dueAt} hasTime={task.dueHasTime} done={isDone} />
          {total > 0 && (
            <span className={cx('inline-flex items-center gap-1 tabular-nums', done === total && 'text-ok')}>
              <ListChecks className="size-3.5" />
              {done}/{total}
            </span>
          )}
          {task.description && <AlignLeft className="size-3.5 text-faint" aria-label="Has description" />}
          {task.note && <StickyNote className="size-3.5 text-faint" aria-label="Has note" />}
          {task.timerStartedAt && (
            <span className="inline-flex items-center gap-1 text-accent">
              <Timer className="pulse size-3.5" /> tracking
            </span>
          )}
        </div>
      )}

      {total > 0 && (
        <div className="mt-2 ml-6 h-[3px] overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export const TaskCard = memo(function TaskCard({ task, isDone }) {
  const select = useBoard((s) => s.select);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { type: 'task' } });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => select(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') select(task.id);
        else listeners?.onKeyDown?.(e);
      }}
      className={cx('anim-card cursor-pointer rounded-[var(--radius)] outline-none focus-visible:ring-2 focus-visible:ring-accent', isDragging && 'opacity-35')}
    >
      <CardBody task={task} isDone={isDone} />
    </div>
  );
});

export function TaskCardOverlay({ task, isDone }) {
  return (
    <div className="w-[284px] cursor-grabbing">
      <CardBody task={task} isDone={isDone} overlay />
    </div>
  );
}
