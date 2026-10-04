import { create } from 'zustand';
import { toast } from 'sonner';
import { api } from './api';
import { syncThemeColor } from './pwa';

const sortByPos = (a, b) => a.position - b.position;
const replaceTask = (tasks, task) => tasks.map((t) => (t.id === task.id ? task : t));
const patchTask = (tasks, id, patch) => tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));

export const useBoard = create((set, get) => {
  /** Apply a change locally, send it, then reconcile with the server's answer (or roll back by reloading). */
  async function optimistic(apply, call, reconcile) {
    if (apply) set(apply(get()));
    try {
      const res = await call();
      if (reconcile) set(reconcile(get(), res));
      return res;
    } catch (err) {
      toast.error(err.message);
      get().load();
      throw err;
    }
  }

  const reconcileTask = (s, task) => ({
    tasks: task.archived ? s.tasks.filter((t) => t.id !== task.id) : s.tasks.some((t) => t.id === task.id) ? replaceTask(s.tasks, task) : [...s.tasks, task],
  });

  return {
    // current route: null = home page, otherwise the open project's id
    projectId: null,
    project: null,
    columns: [],
    tasks: [],
    loaded: false,
    // home page
    projects: [],
    dueSoon: [],
    homeLoaded: false,
    query: '',
    dueFilter: 'all', // all | overdue | week
    selectedId: null,
    dragging: false,
    quickAddColumn: null,
    theme: document.documentElement.dataset.theme || 'paper',

    /** Reload whatever is on screen: the home page or the open project's board. */
    async load() {
      const { projectId, dragging } = get();
      if (dragging) return;
      if (projectId == null) return get().loadHome();
      try {
        const { project, columns, tasks } = await api.board(projectId);
        if (!get().dragging && get().projectId === projectId) set({ project, columns, tasks, loaded: true });
      } catch (err) {
        if (err.status === 404) return get().openProject(null);
        toast.error(`Could not load board: ${err.message}`);
      }
    },

    async loadHome() {
      try {
        const { projects, dueSoon } = await api.home();
        set({ projects, dueSoon, homeLoaded: true });
      } catch (err) {
        toast.error(`Could not load projects: ${err.message}`);
      }
    },

    /** Switch views (called by the router). `id` null = home page. */
    openProject(id) {
      if (id === get().projectId) {
        if (get().pendingSelect != null) set({ selectedId: get().pendingSelect, pendingSelect: null });
        return get().load();
      }
      set({ projectId: id, project: null, columns: [], tasks: [], loaded: false, query: '', dueFilter: 'all', quickAddColumn: null, selectedId: get().pendingSelect ?? null, pendingSelect: null });
      return get().load();
    },
    pendingSelect: null,

    // ---------- projects ----------

    async createProject(data) {
      const project = await optimistic(null, () => api.createProject(data));
      get().loadHome();
      return project;
    },

    updateProject(id, patch) {
      return optimistic(
        (s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)), project: s.project?.id === id ? { ...s.project, ...patch } : s.project }),
        () => api.updateProject(id, patch),
        (s, p) => ({ projects: s.projects.map((x) => (x.id === id ? { ...x, ...p } : x)), project: s.project?.id === id ? p : s.project })
      );
    },

    /** dir: -1 / +1 among active projects */
    shiftProject(id, dir) {
      const active = get().projects.filter((p) => !p.archived);
      const i = active.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= active.length) return;
      const reordered = [...active];
      [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
      return optimistic(
        (s) => ({ projects: [...reordered, ...s.projects.filter((p) => p.archived)] }),
        () => api.moveProject(id, j)
      );
    },

    async deleteProject(id) {
      await optimistic((s) => ({ projects: s.projects.filter((p) => p.id !== id) }), () => api.deleteProject(id));
      get().loadHome();
    },

    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('tt-theme', theme);
      set({ theme });
      syncThemeColor();
    },
    setQuery: (query) => set({ query }),
    setDueFilter: (dueFilter) => set({ dueFilter }),
    select: (selectedId) => set({ selectedId }),
    setDragging: (dragging) => set({ dragging }),
    setQuickAdd: (quickAddColumn) => set({ quickAddColumn }),

    // ---------- tasks ----------

    async createTask(data) {
      const task = await optimistic(null, () => api.createTask(data), reconcileTask);
      return task;
    },

    updateTask(id, patch) {
      return optimistic((s) => ({ tasks: patchTask(s.tasks, id, patch) }), () => api.updateTask(id, patch), reconcileTask);
    },

    /** index = position among the column's active tasks, excluding the moved one */
    moveTask(id, columnId, index) {
      return optimistic(
        (s) => {
          const siblings = s.tasks.filter((t) => t.columnId === columnId && t.id !== id).sort(sortByPos);
          const before = siblings[index - 1]?.position;
          const after = siblings[index]?.position;
          const position = before == null && after == null ? 1024 : before == null ? after - 1024 : after == null ? before + 1024 : (before + after) / 2;
          return { tasks: patchTask(s.tasks, id, { columnId, position }) };
        },
        () => api.moveTask(id, columnId, index),
        reconcileTask
      );
    },

    async completeTask(id) {
      const s = get();
      const task = s.tasks.find((t) => t.id === id);
      const doneCol = s.columns.find((c) => c.isDone && !c.hidden) || s.columns.find((c) => c.isDone);
      if (!task) return;
      if (!doneCol) return toast('No “done” column yet', { description: 'Open a column’s ⋯ menu and choose “Mark as done column”.' });
      const from = task.columnId;
      const fromIndex = tasksForColumn(s.tasks, from).findIndex((t) => t.id === id);
      await get().moveTask(id, doneCol.id, 0);
      toast.success(`Done — ${task.title}`, { action: { label: 'Undo', onClick: () => get().moveTask(id, from, fromIndex) } });
    },

    async archiveTask(id) {
      const task = get().tasks.find((t) => t.id === id);
      await optimistic((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), selectedId: s.selectedId === id ? null : s.selectedId }), () => api.updateTask(id, { archived: true }));
      toast(`Archived “${task?.title ?? 'task'}”`, { action: { label: 'Undo', onClick: () => get().restoreTask(id) } });
    },

    restoreTask(id) {
      return optimistic(null, () => api.updateTask(id, { archived: false }), reconcileTask);
    },

    async deleteTask(id) {
      await optimistic((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), selectedId: s.selectedId === id ? null : s.selectedId }), () => api.deleteTask(id));
    },

    startTimer(id) {
      return optimistic((s) => ({ tasks: patchTask(s.tasks, id, { timerStartedAt: new Date().toISOString() }) }), () => api.startTimer(id), reconcileTask);
    },
    stopTimer(id) {
      return optimistic(null, () => api.stopTimer(id), reconcileTask);
    },

    // ---------- subtasks ----------

    addSubtask(taskId, title) {
      const tempId = `tmp-${Date.now()}`;
      return optimistic(
        (s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, subtasks: [...t.subtasks, { id: tempId, taskId, title, done: false, position: Infinity }] } : t)),
        }),
        () => api.addSubtask(taskId, title),
        (s, sub) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, subtasks: t.subtasks.map((x) => (x.id === tempId ? sub : x)) } : t)) })
      );
    },

    updateSubtask(taskId, id, patch) {
      if (typeof id === 'string') return; // still being created
      return optimistic(
        (s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, subtasks: t.subtasks.map((x) => (x.id === id ? { ...x, ...patch } : x)) } : t)) }),
        () => api.updateSubtask(id, patch)
      );
    },

    deleteSubtask(taskId, id) {
      if (typeof id === 'string') return;
      return optimistic(
        (s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, subtasks: t.subtasks.filter((x) => x.id !== id) } : t)) }),
        () => api.deleteSubtask(id)
      );
    },

    // ---------- columns ----------

    createColumn(data) {
      return optimistic(null, () => api.createColumn({ ...data, projectId: get().projectId }), (s, col) => ({ columns: [...s.columns, col] }));
    },

    updateColumn(id, patch) {
      return optimistic(
        (s) => ({ columns: s.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) }),
        () => api.updateColumn(id, patch),
        (s, col) => ({ columns: s.columns.map((c) => (c.id === id ? col : c)) })
      );
    },

    /** Drag-and-drop reorder: put `id` where `overId` is (hidden columns keep their slots). */
    reorderColumn(id, overId) {
      const cols = get().columns;
      const from = cols.findIndex((c) => c.id === id);
      const to = cols.findIndex((c) => c.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      const reordered = [...cols];
      reordered.splice(to, 0, reordered.splice(from, 1)[0]);
      return optimistic(
        () => ({ columns: reordered }),
        () => api.moveColumn(id, to),
        (s, columns) => ({ columns })
      );
    },

    /** dir: -1 left / +1 right, skipping hidden columns */
    shiftColumn(id, dir) {
      const cols = get().columns;
      const visible = cols.filter((c) => !c.hidden);
      const vi = visible.findIndex((c) => c.id === id);
      const neighbour = visible[vi + dir];
      if (!neighbour) return;
      const reordered = cols.filter((c) => c.id !== id);
      const insertAt = dir > 0 ? reordered.findIndex((c) => c.id === neighbour.id) + 1 : reordered.findIndex((c) => c.id === neighbour.id);
      reordered.splice(insertAt, 0, cols.find((c) => c.id === id));
      return optimistic(
        () => ({ columns: reordered }),
        () => api.moveColumn(id, insertAt),
        (s, columns) => ({ columns })
      );
    },

    async deleteColumn(id, moveTo) {
      await optimistic(
        (s) => ({
          columns: s.columns.filter((c) => c.id !== id),
          tasks: moveTo ? s.tasks.map((t) => (t.columnId === id ? { ...t, columnId: moveTo, position: t.position + 1e9 } : t)) : s.tasks,
        }),
        () => api.deleteColumn(id, moveTo)
      );
      get().load();
    },
  };
});

export function tasksForColumn(tasks, columnId) {
  return tasks.filter((t) => t.columnId === columnId).sort(sortByPos);
}
