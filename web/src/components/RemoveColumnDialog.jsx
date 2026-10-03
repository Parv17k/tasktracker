import { useEffect, useState } from 'react';
import { ArrowRightLeft, EyeOff } from 'lucide-react';
import { useBoard } from '../store';
import { Button, ColorDot, cx, Dialog } from './ui';

/**
 * Removing a column that still has tasks asks where they should go —
 * or offers to hide the column instead so it can be brought back later.
 */
export function RemoveColumnDialog({ column, onClose }) {
  const columns = useBoard((s) => s.columns);
  const count = useBoard((s) => (column ? s.tasks.filter((t) => t.columnId === column.id).length : 0));
  const others = columns.filter((c) => column && c.id !== column.id && !c.hidden);
  const [choice, setChoice] = useState('move');
  const [target, setTarget] = useState(null);

  useEffect(() => {
    if (column) {
      setChoice('move');
      setTarget(others[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column?.id]);

  if (!column) return null;
  const { updateColumn, deleteColumn } = useBoard.getState();
  const lastVisible = others.length === 0;

  const confirm = async () => {
    onClose();
    if (choice === 'hide') await updateColumn(column.id, { hidden: true });
    else await deleteColumn(column.id, count ? target : others[0]?.id);
  };

  return (
    <Dialog
      open={!!column}
      onOpenChange={(o) => !o && onClose()}
      title={`Remove “${column.name}”?`}
      description={
        lastVisible
          ? 'This is your only visible column. Add or show another column first.'
          : count
            ? `It has ${count} task${count === 1 ? '' : 's'}. Choose what happens to ${count === 1 ? 'it' : 'them'}.`
            : 'The column is empty. You can delete it, or just hide it in case you need it again.'
      }
    >
      {!lastVisible && (
        <div className="space-y-2">
          <Option active={choice === 'move'} onClick={() => setChoice('move')} icon={<ArrowRightLeft className="size-4" />} title={count ? 'Move tasks & delete column' : 'Delete column'}>
            {count > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {others.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setChoice('move');
                      setTarget(c.id);
                    }}
                    className={cx(
                      'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors',
                      target === c.id ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:text-fg'
                    )}
                  >
                    <ColorDot color={c.color} className="size-2" /> {c.name}
                  </button>
                ))}
              </div>
            )}
          </Option>
          <Option active={choice === 'hide'} onClick={() => setChoice('hide')} icon={<EyeOff className="size-4" />} title="Hide column for now">
            <p className="mt-0.5 text-[12px] text-muted">Tasks stay inside it. Bring it back anytime from “Hidden” in the top bar.</p>
          </Option>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {!lastVisible && (
          <Button variant={choice === 'hide' ? 'primary' : 'danger'} onClick={confirm} disabled={choice === 'move' && count > 0 && !target}>
            {choice === 'hide' ? 'Hide column' : count ? 'Move & delete' : 'Delete column'}
          </Button>
        )}
      </div>
    </Dialog>
  );
}

function Option({ active, onClick, icon, title, children }) {
  return (
    <div
      role="radio"
      aria-checked={active}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      className={cx('cursor-pointer rounded-xl border p-3 transition-colors', active ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-line-strong')}
    >
      <div className="flex items-center gap-2 text-[13.5px] font-medium">
        <span className={cx('flex size-4 items-center justify-center rounded-full border', active ? 'border-accent' : 'border-line-strong')}>
          {active && <span className="size-2 rounded-full bg-accent" />}
        </span>
        {icon}
        {title}
      </div>
      <div className="pl-6">{children}</div>
    </div>
  );
}
