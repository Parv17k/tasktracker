import { useEffect, useState } from 'react';
import { ArchiveRestore, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { useBoard } from '../store';
import { Button, ColorDot, IconButton, Sheet } from './ui';

export function ArchiveSheet({ open, onOpenChange }) {
  const columns = useBoard((s) => s.columns);
  const projectId = useBoard((s) => s.projectId);
  const { restoreTask } = useBoard.getState();
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setItems(null);
    api
      .archived(projectId)
      .then(setItems)
      .catch((e) => toast.error(e.message));
  }, [open, projectId]);

  const shown = (items || []).filter((t) => !query || t.title.toLowerCase().includes(query.toLowerCase()));

  const remove = async (id) => {
    setItems((list) => list.filter((t) => t.id !== id));
    await api.deleteTask(id).catch((e) => toast.error(e.message));
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Archive" width={480}>
      <div className="p-5">
        <label className="relative flex h-9 items-center rounded-lg border border-line bg-bg/50 pl-8 pr-2 focus-within:border-accent">
          <Search className="absolute left-2.5 size-3.5 text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search archive" className="h-full w-full bg-transparent text-[13px] outline-none" />
        </label>

        {items === null ? (
          <p className="py-10 text-center text-[13px] text-faint">Loading…</p>
        ) : shown.length === 0 ? (
          <div className="py-14 text-center">
            <p className="font-display text-lg text-muted">{items.length ? 'No matches' : 'Nothing archived'}</p>
            <p className="mt-1 text-[12px] text-faint">Archived tasks are kept here and can be restored anytime.</p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {shown.map((t) => {
              const col = columns.find((c) => c.id === t.columnId);
              return (
                <li key={t.id} className="group flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] text-fg">{t.title}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                      {col && <ColorDot color={col.color} className="size-2" />}
                      {col?.name} · archived {new Date(t.archivedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={async () => {
                      setItems((list) => list.filter((x) => x.id !== t.id));
                      await restoreTask(t.id);
                      toast.success(`Restored “${t.title}”`);
                    }}
                  >
                    <ArchiveRestore className="size-3.5" /> Restore
                  </Button>
                  <IconButton size="sm" label="Delete forever" onClick={() => remove(t.id)} className="hover:!text-danger">
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
