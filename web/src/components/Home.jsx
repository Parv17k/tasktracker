import { useEffect, useMemo, useRef, useState } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  GripHorizontal,
  CircleDot,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useBoard } from '../store';
import { navigate, projectPath } from '../router';
import { COLUMN_COLORS } from '../themes';
import { DueChip } from './Due';
import { Logo, ThemePicker } from './TopBar';
import { InstallButton, RemindersButton } from './Reminders';
import { ChatButton } from './Chat';
import { Button, cx, Dialog, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip } from './ui';

const ICONS = ['📋', '✅', '🚀', '💼', '🏠', '🎯', '💡', '📚', '🛠️', '🎨', '💰', '🌱', '✈️', '🏋️', '🧪', '📈', '🛒', '❤️', '🎓', '🧘', '📝', '🔒', '🌍', '🎵'];

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function openTask(projectId, taskId) {
  useBoard.setState({ pendingSelect: taskId });
  navigate(projectPath(projectId));
}

export default function Home() {
  const projects = useBoard((s) => s.projects);
  const dueSoon = useBoard((s) => s.dueSoon);
  const loaded = useBoard((s) => s.homeLoaded);
  const newProjectOpen = useBoard((s) => s.newProjectOpen);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const active = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const archived = useMemo(() => projects.filter((p) => p.archived), [projects]);
  const totals = useMemo(
    () =>
      active.reduce(
        (t, p) => ({
          open: t.open + p.stats.open,
          dueToday: t.dueToday + p.stats.dueToday,
          overdue: t.overdue + p.stats.overdue,
          completed: t.completed + p.stats.completedThisWeek,
        }),
        { open: 0, dueToday: 0, overdue: 0, completed: 0 }
      ),
    [active]
  );

  const setNewOpen = (v) => useBoard.setState({ newProjectOpen: v });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  // the click that ends a drag must not open the project
  const draggedAt = useRef(0);
  const onDragEnd = ({ active, over }) => {
    draggedAt.current = Date.now();
    if (over && active.id !== over.id) useBoard.getState().reorderProject(active.id, over.id);
  };

  useEffect(() => {
    document.title = 'Task Tracker';
  }, []);

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1240px] px-6 pb-16 sm:px-10">
        {/* top bar */}
        <header className="flex items-center gap-3 py-5">
          <Logo />
          <span className="font-display text-[20px] text-fg">Task Tracker</span>
          <div className="ml-auto flex items-center gap-2">
            <ChatButton />
            <RemindersButton />
            <ThemePicker />
            <InstallButton />
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Plus className="size-4" /> New project
            </Button>
          </div>
        </header>

        {/* today at a glance */}
        <section className="pb-6 pt-4">
          <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-faint">{today}</p>
          {loaded && (
            <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
              {totals.open === 0 ? (
                'Everything is clear. A good moment to plan something new.'
              ) : (
                <>
                  You have <span className="font-medium text-fg">{plural(totals.open, 'open task')}</span> across{' '}
                  <span className="font-medium text-fg">{plural(active.length, 'project')}</span>
                  {totals.overdue > 0 ? (
                    <>
                      {' '}
                      — <span className="font-medium text-danger">{totals.overdue} overdue</span>.
                    </>
                  ) : (
                    '. Nothing is overdue.'
                  )}
                </>
              )}
            </p>
          )}
        </section>

        {/* stat tiles */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile icon={CircleDot} label="Open tasks" value={totals.open} />
          <StatTile icon={CalendarClock} label="Due today" value={totals.dueToday} tone={totals.dueToday ? 'warn' : null} />
          <StatTile icon={AlertTriangle} label="Overdue" value={totals.overdue} tone={totals.overdue ? 'danger' : null} />
          <StatTile icon={CheckCircle2} label="Done this week" value={totals.completed} tone={totals.completed ? 'ok' : null} />
        </section>

        {/* due soon across projects */}
        <section className="mt-12">
          <SectionTitle title="Coming up" hint="Next 7 days, every project" />
          {loaded && dueSoon.length === 0 ? (
            <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-card/60 px-5 py-4 text-[14px] text-muted">
              <Sparkles className="size-4 text-accent" /> Nothing due in the next 7 days.
            </div>
          ) : (
            <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2 [mask-image:linear-gradient(to_right,black_calc(100%-48px),transparent)]">
              {dueSoon.map((t) => (
                <DueSoonCard key={t.id} task={t} />
              ))}
            </div>
          )}
        </section>

        {/* projects */}
        <section className="mt-12">
          <SectionTitle title="Projects" hint={loaded ? plural(active.length, 'active project') : ''} />
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => (draggedAt.current = Date.now())} onDragEnd={onDragEnd}>
            <SortableContext items={active.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
                {!loaded && [0, 1, 2].map((i) => <div key={i} className="h-[270px] animate-pulse rounded-2xl bg-card/60" />)}
                {active.map((p, i) => (
                  <SortableProjectCard
                    key={p.id}
                    project={p}
                    isFirst={i === 0}
                    isLast={i === active.length - 1}
                    onEdit={() => setEditing(p)}
                    onDelete={() => setDeleting(p)}
                    canArchive={active.length > 1}
                    justDragged={() => Date.now() - draggedAt.current < 250}
                  />
                ))}
                {loaded && <NewProjectCard onClick={() => setNewOpen(true)} />}
              </div>
            </SortableContext>
          </DndContext>
        </section>

        {archived.length > 0 && (
          <section className="mt-10">
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="flex items-center gap-1.5 text-[13px] text-faint hover:text-fg">
              <ChevronDown className={cx('size-4 transition-transform', !showArchived && '-rotate-90')} />
              Archived · {archived.length}
            </button>
            {showArchived && (
              <div className="mt-4 grid gap-4 opacity-80 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
                {archived.map((p) => (
                  <ProjectCard key={p.id} project={p} onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <ProjectDialog open={newProjectOpen} onClose={() => setNewOpen(false)} projects={active} />
      <ProjectDialog open={!!editing} project={editing} onClose={() => setEditing(null)} />
      <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} canArchive={active.length > 1} />
    </div>
  );
}

function SectionTitle({ title, hint }) {
  return (
    <div className="mb-4 flex items-baseline gap-3">
      <h2 className="font-display text-[22px] text-fg">{title}</h2>
      {hint && <span className="text-[12.5px] text-faint">{hint}</span>}
    </div>
  );
}

const TONE = {
  warn: 'bg-warn/12 text-warn',
  danger: 'bg-danger/12 text-danger',
  ok: 'bg-ok/12 text-ok',
};

/** A headline number. Text stays in text colours; status colour lives only on the icon chip. */
function StatTile({ icon: Icon, label, value, tone }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-5 py-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className={cx('flex size-7 items-center justify-center rounded-lg', tone ? TONE[tone] : 'bg-hover text-muted')}>
          <Icon className="size-4" />
        </span>
        <span className="text-[13px] text-muted">{label}</span>
      </div>
      <div className="font-display mt-3 text-[34px] leading-none tabular-nums text-fg">{value}</div>
    </div>
  );
}

function DueSoonCard({ task }) {
  return (
    <button
      type="button"
      onClick={() => openTask(task.project.id, task.id)}
      data-color={task.project.color}
      className="group flex w-[248px] shrink-0 flex-col rounded-2xl border border-line bg-card p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lift"
    >
      <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <span className="text-[13px] leading-none">{task.project.icon}</span>
        <span className="truncate">{task.project.name}</span>
        <span className="text-faint">·</span>
        <span className="truncate text-faint">{task.columnName}</span>
      </span>
      <span className="mt-2 line-clamp-2 min-h-[2.6em] text-[14px] leading-snug text-fg">{task.title}</span>
      <span className="mt-3">
        <DueChip dueAt={task.dueAt} hasTime={task.dueHasTime} />
      </span>
    </button>
  );
}

/** Active projects: the whole card can be dragged to reorder; a short press still opens it. */
function SortableProjectCard({ justDragged, ...props }) {
  const sortable = useSortable({ id: props.project.id });
  return (
    <ProjectCard
      {...props}
      sortable={sortable}
      onOpen={() => !justDragged() && navigate(projectPath(props.project.id))}
    />
  );
}

function ProjectCard({ project: p, isFirst, isLast, onEdit, onDelete, canArchive = true, sortable, onOpen }) {
  const { updateProject, shiftProject } = useBoard.getState();
  const s = p.stats;
  const columns = s.columns.filter((c) => !c.hidden || c.count > 0);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const open = onOpen || (() => navigate(projectPath(p.id)));
  const dragging = sortable?.isDragging;

  return (
    <article
      ref={sortable?.setNodeRef}
      style={sortable && { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      {...sortable?.attributes}
      {...sortable?.listeners}
      role="link"
      tabIndex={0}
      aria-roledescription={sortable ? 'sortable project' : undefined}
      aria-label={sortable ? `${p.name}, drag to reorder` : undefined}
      data-color={p.color}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') open();
        else sortable?.listeners?.onKeyDown?.(e);
      }}
      className={cx(
        'group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-line bg-card p-5 shadow-card outline-none transition-[border-color,box-shadow,translate,opacity] duration-200 hover:border-line-strong hover:shadow-lift focus-visible:ring-2 focus-visible:ring-accent',
        sortable && 'active:cursor-grabbing',
        dragging ? 'z-10 cursor-grabbing border-accent/50 shadow-lift' : 'hover:-translate-y-0.5'
      )}
    >
      {/* drag affordance */}
      {sortable && (
        <GripHorizontal aria-hidden className="pointer-events-none absolute left-1/2 top-1 size-4 -translate-x-1/2 text-faint opacity-0 transition-opacity group-hover:opacity-70" />
      )}
      {/* soft wash of the project colour in the corner */}
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-[var(--bar)] opacity-[0.07] blur-2xl transition-opacity group-hover:opacity-[0.12]" />

      <header className="relative flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl text-[22px] ring-1 ring-line [background:color-mix(in_oklab,var(--bar)_14%,var(--card))]">
          {p.icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display truncate text-[19px] leading-tight text-fg">{p.name}</h3>
          <p className="mt-1 line-clamp-1 text-[12.5px] text-muted">{p.description || `Updated ${ago(s.lastActivity)}`}</p>
        </div>
        <div onClick={(e) => e.stopPropagation()} className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          <Menu>
            <MenuTrigger asChild>
              <IconButton size="sm" aria-label="Project options">
                <MoreHorizontal className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={onEdit}>
                <Pencil /> Edit project
              </MenuItem>
              {!p.archived && (
                <>
                  <MenuItem disabled={isFirst} onSelect={() => shiftProject(p.id, -1)}>
                    <ArrowLeft /> Move earlier
                  </MenuItem>
                  <MenuItem disabled={isLast} onSelect={() => shiftProject(p.id, 1)}>
                    <ArrowRight /> Move later
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              {p.archived ? (
                <MenuItem onSelect={() => updateProject(p.id, { archived: false }).then(() => useBoard.getState().loadHome())}>
                  <ArchiveRestore /> Restore
                </MenuItem>
              ) : (
                <MenuItem disabled={!canArchive} onSelect={() => updateProject(p.id, { archived: true }).then(() => useBoard.getState().loadHome())}>
                  <Archive /> Archive
                </MenuItem>
              )}
              <MenuItem danger onSelect={onDelete}>
                <Trash2 /> Delete…
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      <div className="relative mt-5 flex items-end justify-between">
        <div>
          <div className="font-display text-[38px] leading-none tabular-nums text-fg">{s.total}</div>
          <div className="mt-1.5 text-[12.5px] text-muted">{s.total === 1 ? 'task' : 'tasks'}</div>
        </div>
        <ProgressRing pct={pct} label={`${s.done} of ${s.total} done`} />
      </div>

      <StatusBar columns={columns} total={s.total} />

      {/* legend: every status is named with its count, so colour is never the only cue */}
      <ul className="relative mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {columns.map((c, i) => (
          <li key={c.id} className="flex items-center gap-1.5 text-[12.5px]">
            <span data-color={c.color} data-seg="" style={{ '--seg': i }} className="size-2 rounded-full bg-[var(--bar)]" />
            <span className={cx('text-muted', c.hidden && 'italic')}>{c.name}</span>
            <span className="tabular-nums text-fg">{c.count}</span>
          </li>
        ))}
      </ul>

      <footer className="relative mt-5 flex min-h-6 flex-wrap items-center gap-2 border-t border-line pt-4 text-[12px]">
        {s.overdue > 0 && (
          <span className="inline-flex h-6 items-center gap-1 rounded-md bg-danger/12 px-2 font-medium text-danger">
            <AlertTriangle className="size-3.5" /> {s.overdue} overdue
          </span>
        )}
        {s.dueWeek - s.overdue > 0 && (
          <span className="inline-flex h-6 items-center gap-1 rounded-md bg-hover px-2 text-muted">
            <CalendarClock className="size-3.5" /> {s.dueWeek - s.overdue} due this week
          </span>
        )}
        {s.overdue === 0 && s.dueWeek === 0 && <span className="text-faint">No deadlines this week</span>}
        <span className="ml-auto text-faint">{ago(s.lastActivity)}</span>
      </footer>
    </article>
  );
}

/** Proportion of tasks per column. Segments carry the column colour; hover names the status. */
function StatusBar({ columns, total }) {
  const shown = columns.map((c, i) => ({ ...c, seg: i })).filter((c) => c.count > 0);
  return (
    <div className="relative mt-5 flex h-2.5 gap-[3px] overflow-hidden rounded-full bg-hover" role="img" aria-label={columns.map((c) => `${c.name} ${c.count}`).join(', ')}>
      {total > 0 &&
        shown.map((c) => (
          <Tip key={c.id} label={`${c.name}: ${c.count} (${Math.round((c.count / total) * 100)}%)`} side="top">
            <span
              data-color={c.color}
              data-seg=""
              style={{ '--seg': c.seg, flexGrow: c.count }}
              className="h-full min-w-[6px] basis-0 bg-[var(--bar)] transition-[filter] first:rounded-l-full last:rounded-r-full hover:brightness-110"
            />
          </Tip>
        ))}
    </div>
  );
}

function ProgressRing({ pct, label }) {
  const r = 21;
  const c = 2 * Math.PI * r;
  return (
    <Tip label={label} side="top">
      <div className="relative size-[54px]">
        <svg viewBox="0 0 54 54" className="size-full -rotate-90">
          <circle cx="27" cy="27" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
          <circle
            cx="27"
            cy="27"
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct / 100)}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[12px] font-semibold tabular-nums text-fg">{pct}%</span>
      </div>
    </Tip>
  );
}

function NewProjectCard({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[270px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line text-muted transition hover:border-accent hover:bg-card/50 hover:text-fg"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-hover transition group-hover:scale-110 group-hover:bg-accent group-hover:text-accent-fg">
        <Plus className="size-5" />
      </span>
      <span className="text-[14px] font-medium">New project</span>
    </button>
  );
}

/** Create (no `project`) or edit (with `project`) a project. */
function ProjectDialog({ open, project, onClose, projects = [] }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[2]);
  const [color, setColor] = useState('violet');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const editing = !!project;

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setIcon(project?.icon ?? ICONS[Math.floor(Math.random() * 12) + 2]);
    setColor(project?.color ?? COLUMN_COLORS[1 + Math.floor(Math.random() * (COLUMN_COLORS.length - 1))]);
    setDescription(project?.description ?? '');
    setCopyFrom('');
  }, [open, project]);

  const submit = async () => {
    if (!name.trim()) return;
    const { createProject, updateProject, loadHome } = useBoard.getState();
    if (editing) {
      await updateProject(project.id, { name: name.trim(), icon, color, description: description.trim() });
      loadHome();
      onClose();
    } else {
      const p = await createProject({ name: name.trim(), icon, color, description: description.trim(), copyColumnsFrom: copyFrom || undefined });
      onClose();
      navigate(projectPath(p.id));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={editing ? 'Edit project' : 'New project'} className="w-[min(92vw,480px)]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-5"
      >
        <div className="flex items-center gap-3">
          <span data-color={color} className="flex size-12 shrink-0 items-center justify-center rounded-xl text-[24px] ring-1 ring-line [background:color-mix(in_oklab,var(--bar)_16%,var(--card))]">
            {icon}
          </span>
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            className="font-display h-12 min-w-0 flex-1 rounded-xl border border-line bg-bg/50 px-3 text-[18px] outline-none focus:border-accent"
          />
        </div>

        <Field label="Icon">
          <div className="grid grid-cols-12 gap-1">
            {ICONS.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIcon(i)}
                className={cx('flex aspect-square items-center justify-center rounded-lg text-[17px] transition hover:bg-hover', icon === i && 'bg-accent-soft ring-1 ring-accent')}
              >
                {i}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Colour">
          <div className="flex gap-2">
            {COLUMN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                onClick={() => setColor(c)}
                data-color={c}
                className={cx('size-7 rounded-full bg-[var(--bar)] ring-offset-2 ring-offset-card transition hover:scale-110', color === c && 'ring-2 ring-fg')}
              />
            ))}
          </div>
        </Field>

        <Field label="Description">
          <textarea
            rows={2}
            value={description}
            maxLength={280}
            placeholder="Optional"
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-xl border border-line bg-bg/50 px-3 py-2 text-[13.5px] outline-none focus:border-accent"
          />
        </Field>

        {!editing && projects.length > 0 && (
          <Field label="Columns">
            <select
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value)}
              className="h-9 w-full rounded-xl border border-line bg-bg/50 px-2.5 text-[13.5px] outline-none focus:border-accent"
            >
              <option value="">Open · In Progress · Follow-up · Done</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  Same as {p.icon} {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!name.trim()}>
            {editing ? 'Save' : 'Create project'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{label}</div>
      {children}
    </div>
  );
}

function DeleteProjectDialog({ project, onClose, canArchive }) {
  if (!project) return null;
  const { deleteProject, updateProject, loadHome } = useBoard.getState();
  const n = project.stats.total;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete “${project.name}”?`}
      description={`This permanently deletes the project${n ? ` and its ${plural(n, 'task')}` : ''}. This can't be undone.${!project.archived && canArchive ? ' Archiving hides it instead and keeps everything.' : ''}`}
    >
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {!project.archived && canArchive && (
          <Button
            onClick={async () => {
              onClose();
              await updateProject(project.id, { archived: true });
              loadHome();
            }}
          >
            <Archive className="size-3.5" /> Archive instead
          </Button>
        )}
        <Button
          variant="danger"
          onClick={() => {
            onClose();
            deleteProject(project.id);
          }}
        >
          <Trash2 className="size-3.5" /> Delete forever
        </Button>
      </div>
    </Dialog>
  );
}
