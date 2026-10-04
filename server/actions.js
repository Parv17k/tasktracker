// Changes the chat assistant proposes. Nothing is written until the user approves:
// preview() validates and describes each action for the approval card, apply() runs the
// approved ones in one transaction through the same data layer as the board and MCP tools.
import * as store from './db.js';
import { dueInfo } from '../shared/due.js';

export const MAX_ACTIONS = 20;

const PRIORITY_ALIASES = { med: 'medium', normal: 'medium', crit: 'urgent', critical: 'urgent', '': 'none' };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const fail = (message) => {
  throw new store.AppError(400, message);
};

function taskRef(ref) {
  const id = Number(String(ref ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) fail('It didn’t say which task to change.');
  try {
    return store.getTask(id);
  } catch {
    return fail(`Task #${id} doesn’t exist.`);
  }
}

const label = (t) => `#${t.id} ${t.title}`;
const columnOf = (t) => store.getColumn(t.columnId);

function text(v, what, { required = false, max = 2000 } = {}) {
  if (v == null || v === '') return required ? fail(`The ${what} is missing.`) : undefined;
  if (typeof v !== 'string') fail(`The ${what} should be text.`);
  const s = v.trim();
  if (required && !s) fail(`The ${what} is missing.`);
  if (s.length > max) fail(`The ${what} is too long.`);
  return s;
}

function priority(v) {
  if (v == null) return undefined;
  const p = PRIORITY_ALIASES[norm(v)] ?? norm(v);
  if (!store.PRIORITIES.includes(p)) fail(`“${v}” isn’t a priority. Use low, medium, high or urgent.`);
  return p;
}

/** Returns [value for the data layer, human label]. '' or null clears the deadline. */
function due(v) {
  if (v === undefined) return [undefined, ''];
  if (v === null || v === '') return ['', 'no deadline'];
  let parsed;
  try {
    parsed = store.parseDue(String(v));
  } catch {
    fail(`“${v}” isn’t a date this app understands.`);
  }
  const info = dueInfo(parsed[0], !!parsed[1]);
  return [String(v), info ? info.label.replace(/^Due /, 'due ').replace(/^Overdue/, 'overdue') : String(v)];
}

function resolveColumnIn(ref, projectId) {
  try {
    return store.resolveColumn(ref, projectId);
  } catch {
    const names = store.listColumns(projectId).map((c) => c.name).join(', ');
    return fail(`There’s no column called “${ref}” here. Columns: ${names}.`);
  }
}

function resolveProjectRef(ref) {
  try {
    return store.resolveProject(ref);
  } catch {
    return fail(`There’s no project called “${ref}”.`);
  }
}

/**
 * Validates one action and returns { verb, summary, run }. Throws AppError with a
 * plain-language message when the action can't be applied.
 */
function plan(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('This change couldn’t be read.');
  switch (a.type) {
    case 'create_task': {
      const project = resolveProjectRef(a.project);
      const cols = store.listColumns(project.id);
      const column = a.column ? resolveColumnIn(a.column, project.id) : cols.find((c) => !c.hidden && !c.isDone) || cols.find((c) => !c.hidden);
      if (!column) fail(`${project.name} has no visible column to add tasks to.`);
      const title = text(a.title, 'task title', { required: true, max: 500 });
      const description = text(a.description, 'description', { max: 20000 });
      const p = priority(a.priority);
      const [dueAt, dueLabel] = due(a.due);
      const subtasks = Array.isArray(a.subtasks) ? a.subtasks.map((s) => text(s, 'subtask', { required: true, max: 500 })).slice(0, 30) : [];
      const extras = [p && p !== 'none' && `${p} priority`, dueLabel, subtasks.length && `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}`].filter(Boolean);
      return {
        verb: 'Create',
        summary: `“${title}” in ${project.icon} ${project.name} › ${column.name}${extras.length ? ` · ${extras.join(' · ')}` : ''}`,
        run: () => store.createTask({ projectId: project.id, columnId: column.id, title, description, priority: p, dueAt: dueAt || undefined, subtasks }),
      };
    }

    case 'update_task': {
      const t = taskRef(a.task);
      const patch = {};
      const changes = [];
      // only fields that actually differ count as changes
      if (a.title !== undefined) {
        const v = text(a.title, 'task title', { required: true, max: 500 });
        if (v !== t.title) (patch.title = v), changes.push(`title → “${v}”`);
      }
      if (a.description !== undefined) {
        const v = text(a.description, 'description', { max: 20000 }) ?? '';
        if (v !== t.description) (patch.description = v), changes.push(v ? 'new description' : 'clear description');
      }
      if (a.priority !== undefined) {
        const v = priority(a.priority);
        if (v !== t.priority) (patch.priority = v), changes.push(`priority → ${v}`);
      }
      if (a.due !== undefined) {
        const [dueAt, dueLabel] = due(a.due);
        const same = dueAt ? t.dueAt && store.parseDue(dueAt)[0] === t.dueAt : !t.dueAt;
        if (!same) (patch.dueAt = dueAt), changes.push(dueAt ? dueLabel : 'remove deadline');
      }
      if (!changes.length) fail(`${label(t)} already looks like that.`);
      return { verb: 'Edit', summary: `${label(t)}: ${changes.join(', ')}`, run: () => store.updateTask(t.id, patch) };
    }

    case 'move_task': {
      const t = taskRef(a.task);
      const from = columnOf(t);
      const to = resolveColumnIn(a.column, from.projectId);
      if (to.id === from.id) fail(`${label(t)} is already in ${to.name}.`);
      return { verb: 'Move', summary: `${label(t)}: ${from.name} → ${to.name}`, run: () => store.moveTask(t.id, { columnId: to.id }) };
    }

    case 'complete_task': {
      const t = taskRef(a.task);
      if (columnOf(t).isDone) fail(`${label(t)} is already done.`);
      return { verb: 'Complete', summary: label(t), run: () => store.completeTask(t.id) };
    }

    case 'archive_task': {
      const t = taskRef(a.task);
      if (t.archived) fail(`${label(t)} is already archived.`);
      return { verb: 'Archive', summary: `${label(t)} (you can restore it from the archive)`, run: () => store.archiveTask(t.id) };
    }

    case 'add_subtasks': {
      const t = taskRef(a.task);
      const items = (Array.isArray(a.subtasks) ? a.subtasks : [a.subtasks]).filter((s) => s != null && s !== '').map((s) => text(s, 'subtask', { required: true, max: 500 }));
      if (!items.length) fail(`No subtasks to add to ${label(t)}.`);
      if (items.length > 30) fail('That’s too many subtasks at once.');
      return { verb: 'Add subtasks', summary: `${label(t)}: ${items.map((s) => `“${s}”`).join(', ')}`, run: () => items.forEach((s) => store.addSubtask(t.id, s)) };
    }

    case 'check_subtask': {
      const t = taskRef(a.task);
      const want = norm(text(a.subtask, 'subtask', { required: true }));
      const sub = t.subtasks.find((s) => norm(s.title) === want) || t.subtasks.find((s) => norm(s.title).includes(want));
      if (!sub) fail(`${label(t)} has no subtask like “${a.subtask}”.`);
      const done = a.done !== false;
      if (sub.done === done) fail(`“${sub.title}” is already ${done ? 'ticked' : 'unticked'}.`);
      return { verb: done ? 'Tick' : 'Untick', summary: `“${sub.title}” on ${label(t)}`, run: () => store.updateSubtask(sub.id, { done }) };
    }

    case 'add_note': {
      const t = taskRef(a.task);
      const note = text(a.text, 'note', { required: true });
      return { verb: 'Add note', summary: `${label(t)}: “${note.length > 80 ? `${note.slice(0, 79)}…` : note}”`, run: () => store.appendNote(t.id, note) };
    }

    case 'create_project': {
      const name = text(a.name, 'project name', { required: true, max: 80 });
      const icon = text(a.icon, 'icon', { max: 16 }) || '📋';
      const description = text(a.description, 'project description', { max: 500 }) || '';
      return { verb: 'Create project', summary: `${icon} ${name} (with the four default columns)`, run: () => store.createProject({ name, icon, description }) };
    }

    default:
      return fail(a.type ? `“${a.type}” isn’t something the assistant can do.` : 'This change couldn’t be read.');
  }
}

function checkList(actions) {
  if (!Array.isArray(actions) || !actions.length) fail('There are no changes to review.');
  if (actions.length > MAX_ACTIONS) fail(`That’s too many changes at once (the limit is ${MAX_ACTIONS}).`);
}

/** Describe each proposed action without changing anything. */
export function preview(actions) {
  checkList(actions);
  return actions.map((a) => {
    try {
      const { verb, summary } = plan(a);
      return { ok: true, verb, summary };
    } catch (err) {
      if (!(err instanceof store.AppError)) throw err;
      return { ok: false, verb: 'Can’t do', summary: err.message };
    }
  });
}

/** Apply approved actions, all or nothing. Later actions see the effects of earlier ones. */
export function apply(actions) {
  checkList(actions);
  const done = [];
  try {
    store.transaction(() => {
      for (const a of actions) {
        const step = plan(a);
        step.run();
        done.push({ verb: step.verb, summary: step.summary });
      }
    });
  } catch (err) {
    if (!(err instanceof store.AppError)) throw err;
    throw new store.AppError(400, `Nothing was changed. ${err.message}`);
  }
  return { applied: done };
}
