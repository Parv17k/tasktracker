import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { navigate, projectPath } from '../router';
import { tasksForColumn, useBoard } from '../store';
import { dueMatches, matches, tagMatches } from './Board';
import { span, Timeline, Undated, useZoom, ZoomToggle } from './Timeline';

const byStart = (a, b) => {
  const x = span(a);
  const y = span(b);
  return (x.start ?? x.end) - (y.start ?? y.end) || x.end - y.end;
};

function Toolbar({ zoom, setZoom, children }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-6 pb-3">
      {children}
      <span className="ml-auto hidden text-[11.5px] text-faint md:inline">Drag a bar to reschedule · drag its ends to change dates · ◆ has only a deadline</span>
      <ZoomToggle zoom={zoom} onChange={setZoom} />
    </div>
  );
}

/** The open project's tasks on a timeline, grouped by column, honouring the board's filters. */
export function BoardTimeline() {
  const columns = useBoard((s) => s.columns);
  const tasks = useBoard((s) => s.tasks);
  const query = useBoard((s) => s.query);
  const dueFilter = useBoard((s) => s.dueFilter);
  const tagFilter = useBoard((s) => s.tagFilter);
  const { select, updateTask } = useBoard.getState();
  const [zoom, setZoom] = useZoom();

  const { sections, undated } = useMemo(() => {
    const sections = [];
    const undated = [];
    for (const c of columns.filter((c) => !c.hidden)) {
      const shown = tasksForColumn(tasks, c.id).filter((t) => matches(t, c, query) && dueMatches(t, dueFilter, c.isDone) && tagMatches(t, tagFilter));
      const dated = shown.filter((t) => t.dueAt).sort(byStart);
      if (!c.isDone) undated.push(...shown.filter((t) => !t.dueAt));
      if (dated.length)
        sections.push({
          id: c.id,
          label: c.name,
          color: c.color,
          hint: dated.length,
          rows: dated.map((t) => ({
            task: t,
            barColor: c.color,
            done: c.isDone,
          })),
        });
    }
    return { sections, undated };
  }, [columns, tasks, query, dueFilter, tagFilter]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar zoom={zoom} setZoom={setZoom} />
      <div className="min-h-0 flex-1 flex flex-col">
        <Timeline
          sections={sections}
          zoom={zoom}
          onOpen={(t) => select(t.id)}
          onReschedule={(t, patch) => updateTask(t.id, patch).catch(() => {})}
          footer={<Undated tasks={undated} onOpen={(t) => select(t.id)} />}
          empty={undated.length ? 'None of these tasks has a deadline yet. Open one to give it a deadline, and optionally a start date.' : undefined}
        />
      </div>
    </div>
  );
}

/** Every active project on one timeline: a summary row each, expandable to its tasks. */
export function HomeTimeline({ projectIds }) {
  const projects = useBoard((s) => s.projects); // refreshed on every change, so we reload with it
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [zoom, setZoom] = useZoom();

  const load = useCallback(() => {
    api
      .timeline()
      .then(setData)
      .catch((e) => toast.error(e.message));
  }, []);
  useEffect(load, [load, projects]);

  const openTask = (t) => {
    const pid = data.projects.find((p) => p.columns.some((c) => c.id === t.columnId))?.id;
    useBoard.setState({ pendingSelect: t.id });
    navigate(projectPath(pid));
  };

  const reschedule = async (t, patch) => {
    // show the new dates immediately, then confirm with the server
    setData((d) => ({
      ...d,
      tasks: d.tasks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)),
    }));
    try {
      await api.updateTask(t.id, patch);
    } catch (err) {
      toast.error(err.message);
    }
    load();
  };

  const sections = useMemo(() => {
    if (!data) return [];
    return data.projects
      .filter((p) => projectIds.includes(p.id))
      .map((p) => {
        const colById = new Map(p.columns.map((c) => [c.id, c]));
        const mine = data.tasks.filter((t) => colById.has(t.columnId)).sort(byStart);
        const openTasks = mine.filter((t) => !colById.get(t.columnId).isDone);
        const collapsed = !open.has(p.id);
        return {
          id: p.id,
          icon: p.icon,
          label: p.name,
          color: p.color,
          hint: openTasks.length ? `${openTasks.length}` : '',
          collapsible: true,
          collapsed,
          onToggle: () => setOpen((s) => (s.has(p.id) ? new Set([...s].filter((x) => x !== p.id)) : new Set([...s, p.id]))),
          summary: openTasks,
          rows: mine.map((t) => {
            const c = colById.get(t.columnId);
            return {
              task: t,
              color: c.color,
              barColor: c.color,
              done: c.isDone,
            };
          }),
        };
      });
  }, [data, projectIds, open]);

  if (!data) return <div className="h-64 animate-pulse rounded-2xl bg-card/60" />;
  const undated = data.projects.filter((p) => projectIds.includes(p.id)).reduce((n, p) => n + p.undated, 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card pt-3 shadow-card [--tl-bg:var(--card)]">
      <Toolbar zoom={zoom} setZoom={setZoom}>
        <button type="button" onClick={() => setOpen((s) => (s.size ? new Set() : new Set(sections.map((x) => x.id))))} className="text-[12.5px] text-muted hover:text-fg">
          {open.size ? 'Collapse all' : 'Expand all'}
        </button>
      </Toolbar>
      <div className="flex max-h-[70vh] flex-col">
        <Timeline
          sections={sections}
          zoom={zoom}
          onOpen={openTask}
          onReschedule={reschedule}
          footer={
            undated > 0 && (
              <p className="border-t border-line px-6 py-2.5 text-[12.5px] text-faint">
                {undated} open task{undated === 1 ? '' : 's'} without a deadline aren’t shown.
              </p>
            )
          }
        />
      </div>
    </div>
  );
}
