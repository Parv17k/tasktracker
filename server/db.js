// Shared data layer for the HTTP API and the MCP server.
// Uses Node's built-in SQLite (node:sqlite) — no native builds, no setup.
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Lives outside the project so the web app and MCP server always share one DB,
// and so cloud-synced folders (iCloud/Dropbox) never touch a live SQLite file.
export const DB_PATH = process.env.TASKTRACKER_DB || join(homedir(), '.tasktracker', 'tasktracker.db');

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
export const COLORS = ['slate', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet'];

const SCHEMA_V1 = `
CREATE TABLE columns (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT 'slate',
  position   REAL    NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  is_done    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE tasks (
  id               INTEGER PRIMARY KEY,
  column_id        INTEGER NOT NULL REFERENCES columns(id),
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  note             TEXT    NOT NULL DEFAULT '',
  priority         TEXT    NOT NULL DEFAULT 'none',
  due_at           TEXT,
  due_has_time     INTEGER NOT NULL DEFAULT 0,
  time_spent       INTEGER NOT NULL DEFAULT 0,
  timer_started_at TEXT,
  position         REAL    NOT NULL,
  archived         INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  completed_at     TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX tasks_board ON tasks(archived, column_id, position);
CREATE INDEX tasks_due ON tasks(archived, due_at);
CREATE TABLE subtasks (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   REAL    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX subtasks_task ON subtasks(task_id, position);
`;

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

/** Emits 'change' after every successful write made by this process. */
export const events = new EventEmitter();

const stmtCache = new Map();
function q(sql) {
  let s = stmtCache.get(sql);
  if (!s) stmtCache.set(sql, (s = db.prepare(sql)));
  return s;
}

let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    events.emit('change');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

/** Runs several writes as one all-or-nothing change (used to apply approved AI actions). */
export const transaction = (fn) => tx(fn);

const now = () => new Date().toISOString();
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- migrations & seed ----------

function migrate() {
  const { user_version } = q('PRAGMA user_version').get();
  if (user_version < 1) {
    tx(() => {
      db.exec(SCHEMA_V1);
      seed();
      db.exec('PRAGMA user_version = 1');
    });
  }
  if (user_version < 2) {
    // v2: projects — every column belongs to a project; the existing board becomes the first one
    tx(() => {
      db.exec(`
        CREATE TABLE projects (
          id          INTEGER PRIMARY KEY,
          name        TEXT    NOT NULL,
          icon        TEXT    NOT NULL DEFAULT '📋',
          color       TEXT    NOT NULL DEFAULT 'blue',
          description TEXT    NOT NULL DEFAULT '',
          position    REAL    NOT NULL,
          archived    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        ALTER TABLE columns ADD COLUMN project_id INTEGER REFERENCES projects(id);
        CREATE INDEX columns_project ON columns(project_id, position);
      `);
      const pid = q('INSERT INTO projects (name, icon, color, position) VALUES (?, ?, ?, ?)').run('My Tasks', '✅', 'blue', 1024).lastInsertRowid;
      q('UPDATE columns SET project_id = ?').run(pid);
      db.exec('PRAGMA user_version = 2');
    });
  }
  if (user_version < 3) {
    // v3: app settings, Web Push subscriptions, and a log so each reminder fires once
    tx(() => {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE push_subscriptions (
          endpoint   TEXT PRIMARY KEY,
          keys       TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE reminders_sent (
          task_id INTEGER NOT NULL,
          kind    TEXT    NOT NULL,
          due_at  TEXT    NOT NULL,
          sent_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (task_id, kind, due_at)
        );
      `);
      db.exec('PRAGMA user_version = 3');
    });
  }
}

const DEFAULT_COLUMNS = [
  ['Open', 'blue', 0],
  ['In Progress', 'amber', 0],
  ['Follow-up', 'violet', 0],
  ['Done', 'green', 1],
];

function seed() {
  const ids = DEFAULT_COLUMNS.map(([name, color, isDone], i) =>
    Number(q('INSERT INTO columns (name, color, position, is_done) VALUES (?, ?, ?, ?)').run(name, color, (i + 1) * 1024, isDone).lastInsertRowid)
  );
  const inDays = (n) => localDate(new Date(Date.now() + n * 86400000));
  const welcome = [
    [ids[0], 'Welcome to your board 👋', 'Click any card to open it. Everything autosaves — there is no Save button.', 'Tip: press N anywhere to add a task, / to search.', 'medium', inDays(0), ['Open this card', 'Tick this subtask', 'Drag the card to another column']],
    [ids[0], 'Try a theme', 'Use the palette icon in the top bar — Paper, Old Money, Nord, Midnight and more.', '', 'low', inDays(2), []],
    [ids[1], 'Connect your AI agent', 'Run the MCP server so your agent can read and update this board. See the README.', '', 'high', inDays(7), ['Add the MCP server to your agent', 'Ask it: "what is on my board?"']],
    [ids[2], 'Waiting on someone? Park it here', 'Follow-up is for tasks that are blocked or waiting. Rename or remove any column from its ⋯ menu.', '', 'none', null, []],
  ];
  welcome.forEach(([col, title, desc, note, prio, due, subs], i) => {
    const id = Number(
      q('INSERT INTO tasks (column_id, title, description, note, priority, due_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(col, title, desc, note, prio, due, (i + 1) * 1024).lastInsertRowid
    );
    subs.forEach((s, j) => q('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)').run(id, s, (j + 1) * 1024));
  });
}

migrate();

// ---------- mappers ----------

function mapColumn(r) {
  return r && { id: r.id, projectId: r.project_id, name: r.name, color: r.color, position: r.position, hidden: !!r.hidden, isDone: !!r.is_done };
}

function mapProject(r) {
  return (
    r && {
      id: r.id,
      name: r.name,
      icon: r.icon,
      color: r.color,
      description: r.description,
      position: r.position,
      archived: !!r.archived,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  );
}

function mapSubtask(r) {
  return { id: r.id, taskId: r.task_id, title: r.title, done: !!r.done, position: r.position };
}

function mapTask(r, subtasks = []) {
  return (
    r && {
      id: r.id,
      columnId: r.column_id,
      title: r.title,
      description: r.description,
      note: r.note,
      priority: r.priority,
      dueAt: r.due_at,
      dueHasTime: !!r.due_has_time,
      timeSpent: r.time_spent,
      timerStartedAt: r.timer_started_at,
      position: r.position,
      archived: !!r.archived,
      archivedAt: r.archived_at,
      completedAt: r.completed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      subtasks,
    }
  );
}

function withSubtasks(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const subs = q(`SELECT * FROM subtasks WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY position`).all(JSON.stringify(ids));
  const byTask = new Map();
  for (const s of subs) {
    if (!byTask.has(s.task_id)) byTask.set(s.task_id, []);
    byTask.get(s.task_id).push(mapSubtask(s));
  }
  return rows.map((r) => mapTask(r, byTask.get(r.id) || []));
}

// ---------- validation helpers ----------

function cleanText(v, field, { max = 20000, required = false } = {}) {
  if (v == null) {
    if (required) throw new AppError(400, `${field} is required`);
    return '';
  }
  const s = String(v);
  if (required && !s.trim()) throw new AppError(400, `${field} cannot be empty`);
  if (s.length > max) throw new AppError(400, `${field} is too long (max ${max})`);
  return required ? s.trim() : s;
}

/** Accepts 'YYYY-MM-DD' (date only) or any ISO datetime. Returns [stored, hasTime]. */
export function parseDue(v) {
  if (v == null || v === '') return [null, 0];
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (Number.isNaN(Date.parse(s))) throw new AppError(400, `Invalid due date: ${s}`);
    return [s, 0];
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new AppError(400, `Invalid due date: ${s} (use YYYY-MM-DD or an ISO datetime)`);
  return [new Date(t).toISOString(), 1];
}

// ---------- columns ----------

/** Columns of one project, or of every project when `projectId` is omitted. */
export function listColumns(projectId) {
  if (projectId == null) return q('SELECT * FROM columns ORDER BY project_id, position').all().map(mapColumn);
  return q('SELECT * FROM columns WHERE project_id = ? ORDER BY position').all(Number(projectId)).map(mapColumn);
}

export function getColumn(id) {
  const c = mapColumn(q('SELECT * FROM columns WHERE id = ?').get(Number(id)));
  if (!c) throw new AppError(404, `Column ${id} not found`);
  return c;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Find by exact, then prefix, then substring match on a punctuation-insensitive name. */
function fuzzyFind(items, ref) {
  const want = norm(ref);
  return items.find((x) => norm(x.name) === want) || items.find((x) => norm(x.name).startsWith(want)) || items.find((x) => norm(x.name).includes(want));
}

/** Resolve a column by numeric id or (case/punctuation-insensitive) name within a project. */
export function resolveColumn(ref, projectId = defaultProjectId()) {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return getColumn(Number(ref));
  const cols = listColumns(projectId);
  const hit = fuzzyFind(cols, ref);
  if (!hit) throw new AppError(404, `No column matching "${ref}". Columns: ${cols.map((c) => c.name).join(', ')}`);
  return hit;
}

export function createColumn({ projectId, name, color = 'slate', isDone = false } = {}) {
  return tx(() => {
    const pid = projectId != null ? getProject(projectId).id : defaultProjectId();
    const { m } = q('SELECT COALESCE(MAX(position), 0) AS m FROM columns WHERE project_id = ?').get(pid);
    const id = q('INSERT INTO columns (project_id, name, color, position, is_done) VALUES (?, ?, ?, ?, ?)').run(
      pid,
      cleanText(name, 'name', { max: 60, required: true }),
      COLORS.includes(color) ? color : 'slate',
      m + 1024,
      isDone ? 1 : 0
    ).lastInsertRowid;
    return getColumn(id);
  });
}

export function updateColumn(id, patch = {}) {
  return tx(() => {
    const col = getColumn(id);
    const sets = [];
    const vals = [];
    if (patch.name !== undefined) sets.push('name = ?'), vals.push(cleanText(patch.name, 'name', { max: 60, required: true }));
    if (patch.color !== undefined) {
      if (!COLORS.includes(patch.color)) throw new AppError(400, `color must be one of ${COLORS.join(', ')}`);
      sets.push('color = ?'), vals.push(patch.color);
    }
    if (patch.isDone !== undefined) sets.push('is_done = ?'), vals.push(patch.isDone ? 1 : 0);
    if (patch.hidden !== undefined) {
      if (patch.hidden && !col.hidden) {
        const { n } = q('SELECT COUNT(*) AS n FROM columns WHERE hidden = 0 AND project_id = ?').get(col.projectId);
        if (n <= 1) throw new AppError(400, 'At least one column must stay visible');
      }
      sets.push('hidden = ?'), vals.push(patch.hidden ? 1 : 0);
    }
    if (sets.length) q(`UPDATE columns SET ${sets.join(', ')} WHERE id = ?`).run(...vals, col.id);
    return getColumn(col.id);
  });
}

/** Move a column to `index` among its project's columns (0-based). */
export function moveColumn(id, index) {
  return tx(() => {
    const col = getColumn(id);
    const others = listColumns(col.projectId).filter((c) => c.id !== col.id);
    others.splice(Math.max(0, Math.min(index, others.length)), 0, col);
    others.forEach((c, i) => q('UPDATE columns SET position = ? WHERE id = ?').run((i + 1) * 1024, c.id));
    return listColumns(col.projectId);
  });
}

/**
 * Delete a column. If it holds tasks, `moveTo` (a column id) is required for active tasks.
 * Archived tasks always follow `moveTo`, or the first remaining column.
 */
export function deleteColumn(id, { moveTo } = {}) {
  return tx(() => {
    const col = getColumn(id);
    const remaining = listColumns(col.projectId).filter((c) => c.id !== col.id);
    if (!remaining.some((c) => !c.hidden)) throw new AppError(400, 'Cannot delete the last visible column');
    const { active, total } = q('SELECT SUM(archived = 0) AS active, COUNT(*) AS total FROM tasks WHERE column_id = ?').get(col.id);
    let target = null;
    if (moveTo != null && moveTo !== '') {
      target = getColumn(moveTo);
      if (target.id === col.id) throw new AppError(400, 'Cannot move tasks into the column being deleted');
    }
    if (active > 0 && !target) throw new AppError(409, `Column "${col.name}" has ${active} task(s). Choose a column to move them to, or hide the column instead.`);
    if (total > 0) {
      const dest = target || remaining.find((c) => !c.hidden);
      const { m } = q('SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE column_id = ?').get(dest.id);
      const rows = q('SELECT id FROM tasks WHERE column_id = ? ORDER BY position').all(col.id);
      const completed = dest.isDone ? now() : null;
      rows.forEach((r, i) =>
        q('UPDATE tasks SET column_id = ?, position = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(dest.id, m + (i + 1) * 1024, completed, now(), r.id)
      );
    }
    q('DELETE FROM columns WHERE id = ?').run(col.id);
    return { deleted: col.id, movedTo: target?.id ?? null };
  });
}

// ---------- tasks ----------

export function getBoard(projectId = defaultProjectId()) {
  const project = getProject(projectId);
  const columns = listColumns(project.id);
  const tasks = withSubtasks(
    q('SELECT t.* FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.archived = 0 AND c.project_id = ? ORDER BY t.column_id, t.position').all(project.id)
  );
  return { project, columns, tasks };
}

export function getTask(id) {
  const row = q('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!row) throw new AppError(404, `Task ${id} not found`);
  return withSubtasks([row])[0];
}

/**
 * Flexible task listing for the API & MCP.
 * @param {{columnId?: number, query?: string, archived?: boolean|'all', dueWithinDays?: number, overdue?: boolean, limit?: number}} opts
 */
export function listTasks({ projectId, columnId, query, archived = false, dueWithinDays, overdue, limit = 200 } = {}) {
  const where = [];
  const vals = [];
  if (projectId != null) where.push('column_id IN (SELECT id FROM columns WHERE project_id = ?)'), vals.push(Number(projectId));
  if (archived !== 'all') where.push('archived = ?'), vals.push(archived ? 1 : 0);
  if (columnId != null) where.push('column_id = ?'), vals.push(Number(columnId));
  if (query) {
    where.push(`(title LIKE ? OR description LIKE ? OR note LIKE ? OR EXISTS (SELECT 1 FROM subtasks s WHERE s.task_id = tasks.id AND s.title LIKE ?))`);
    const like = `%${query}%`;
    vals.push(like, like, like, like);
  }
  if (dueWithinDays != null || overdue) {
    where.push('due_at IS NOT NULL');
    where.push('column_id NOT IN (SELECT id FROM columns WHERE is_done = 1)');
    if (dueWithinDays != null) {
      const until = new Date(Date.now() + Number(dueWithinDays) * 86400000).toISOString();
      where.push('due_at <= ?'), vals.push(until);
    }
    if (overdue) where.push('((due_has_time = 0 AND due_at < ?) OR (due_has_time = 1 AND due_at < ?))'), vals.push(localDate(), now());
  }
  const order = archived === true ? 'archived_at DESC' : dueWithinDays != null || overdue ? 'due_at, position' : 'column_id, position';
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
  return withSubtasks(q(sql).all(...vals, Math.min(Number(limit) || 200, 1000)));
}

function defaultColumnId(projectId = defaultProjectId()) {
  const c =
    q('SELECT id FROM columns WHERE project_id = ? AND hidden = 0 AND is_done = 0 ORDER BY position LIMIT 1').get(projectId) ||
    q('SELECT id FROM columns WHERE project_id = ? AND hidden = 0 ORDER BY position LIMIT 1').get(projectId);
  if (!c) throw new AppError(400, 'No visible column to add the task to');
  return c.id;
}

export function createTask({ title, description, note, projectId, columnId, priority = 'none', dueAt, subtasks = [], placement = 'bottom' } = {}) {
  return tx(() => {
    const colId = columnId != null ? getColumn(columnId).id : defaultColumnId(projectId != null ? getProject(projectId).id : defaultProjectId());
    if (!PRIORITIES.includes(priority)) throw new AppError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
    const [due, dueHasTime] = parseDue(dueAt);
    const edge =
      placement === 'top'
        ? q('SELECT COALESCE(MIN(position), 1024) - 1024 AS p FROM tasks WHERE column_id = ? AND archived = 0').get(colId).p
        : q('SELECT COALESCE(MAX(position), 0) + 1024 AS p FROM tasks WHERE column_id = ? AND archived = 0').get(colId).p;
    const isDone = getColumn(colId).isDone;
    const id = Number(
      q('INSERT INTO tasks (column_id, title, description, note, priority, due_at, due_has_time, position, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        colId,
        cleanText(title, 'title', { max: 500, required: true }),
        cleanText(description, 'description'),
        cleanText(note, 'note'),
        priority,
        due,
        dueHasTime,
        edge,
        isDone ? now() : null
      ).lastInsertRowid
    );
    subtasks.filter((s) => String(s).trim()).forEach((s, i) => q('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)').run(id, cleanText(s, 'subtask', { max: 500, required: true }), (i + 1) * 1024));
    return getTask(id);
  });
}

export function updateTask(id, patch = {}) {
  return tx(() => {
    const task = getTask(id);
    const sets = [];
    const vals = [];
    if (patch.title !== undefined) sets.push('title = ?'), vals.push(cleanText(patch.title, 'title', { max: 500, required: true }));
    if (patch.description !== undefined) sets.push('description = ?'), vals.push(cleanText(patch.description, 'description'));
    if (patch.note !== undefined) sets.push('note = ?'), vals.push(cleanText(patch.note, 'note'));
    if (patch.priority !== undefined) {
      if (!PRIORITIES.includes(patch.priority)) throw new AppError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
      sets.push('priority = ?'), vals.push(patch.priority);
    }
    if (patch.dueAt !== undefined) {
      const [due, hasTime] = parseDue(patch.dueAt);
      sets.push('due_at = ?', 'due_has_time = ?'), vals.push(due, hasTime);
    }
    if (patch.timeSpent !== undefined) sets.push('time_spent = ?'), vals.push(Math.max(0, Math.round(Number(patch.timeSpent) || 0)));
    if (patch.archived !== undefined) {
      sets.push('archived = ?', 'archived_at = ?'), vals.push(patch.archived ? 1 : 0, patch.archived ? now() : null);
      if (!patch.archived) {
        // restore to the bottom of its column (or the default column if that one is hidden)
        const col = getColumn(task.columnId);
        const colId = col.hidden ? defaultColumnId(col.projectId) : col.id;
        const { p } = q('SELECT COALESCE(MAX(position), 0) + 1024 AS p FROM tasks WHERE column_id = ? AND archived = 0').get(colId);
        sets.push('column_id = ?', 'position = ?'), vals.push(colId, p);
      }
    }
    if (sets.length) {
      sets.push('updated_at = ?'), vals.push(now());
      q(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, task.id);
    }
    if (patch.columnId !== undefined && patch.columnId !== task.columnId) moveTask(task.id, { columnId: patch.columnId });
    return getTask(task.id);
  });
}

/** Move a task to a column at `index` (0-based among active tasks; defaults to the end). */
export function moveTask(id, { columnId, index } = {}) {
  return tx(() => {
    const task = getTask(id);
    const col = columnId != null ? getColumn(columnId) : getColumn(task.columnId);
    const siblings = q('SELECT id, position FROM tasks WHERE column_id = ? AND archived = 0 AND id != ? ORDER BY position').all(col.id, task.id);
    const i = index == null ? siblings.length : Math.max(0, Math.min(Number(index), siblings.length));
    const before = siblings[i - 1]?.position;
    const after = siblings[i]?.position;
    let pos;
    if (before == null && after == null) pos = 1024;
    else if (before == null) pos = after - 1024;
    else if (after == null) pos = before + 1024;
    else pos = (before + after) / 2;
    if (before != null && after != null && after - before < 1e-6) {
      // positions got too dense — renumber the column
      siblings.splice(i, 0, { id: task.id });
      siblings.forEach((s, k) => q('UPDATE tasks SET position = ? WHERE id = ?').run((k + 1) * 1024, s.id));
      pos = (i + 1) * 1024;
    }
    const changedColumn = col.id !== task.columnId;
    const completedAt = col.isDone ? (changedColumn || !task.completedAt ? now() : task.completedAt) : null;
    let timer = '';
    // stop a running timer when the task lands in a done column
    if (col.isDone && task.timerStartedAt) {
      const extra = Math.round((Date.now() - Date.parse(task.timerStartedAt)) / 1000);
      timer = `, timer_started_at = NULL, time_spent = time_spent + ${Math.max(0, extra)}`;
    }
    q(`UPDATE tasks SET column_id = ?, position = ?, completed_at = ?, updated_at = ?${timer} WHERE id = ?`).run(col.id, pos, completedAt, now(), task.id);
    return getTask(task.id);
  });
}

/** Move to the first done-flagged column. */
export function completeTask(id) {
  const { projectId } = getColumn(getTask(id).columnId);
  const done = q('SELECT id FROM columns WHERE project_id = ? AND is_done = 1 ORDER BY hidden, position LIMIT 1').get(projectId);
  if (!done) throw new AppError(400, 'No column is marked as "done". Mark one via its column menu.');
  return moveTask(id, { columnId: done.id, index: 0 });
}

export function archiveTask(id, archived = true) {
  return updateTask(id, { archived });
}

export function deleteTask(id) {
  return tx(() => {
    const task = getTask(id);
    q('DELETE FROM tasks WHERE id = ?').run(task.id);
    return { deleted: task.id };
  });
}

export function appendNote(id, text) {
  return tx(() => {
    const task = getTask(id);
    const line = cleanText(text, 'text', { required: true });
    const note = task.note ? `${task.note.replace(/\s+$/, '')}\n${line}` : line;
    return updateTask(task.id, { note });
  });
}

export function startTimer(id) {
  return tx(() => {
    const task = getTask(id);
    if (!task.timerStartedAt) q('UPDATE tasks SET timer_started_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), task.id);
    return getTask(task.id);
  });
}

export function stopTimer(id) {
  return tx(() => {
    const task = getTask(id);
    if (task.timerStartedAt) {
      const extra = Math.max(0, Math.round((Date.now() - Date.parse(task.timerStartedAt)) / 1000));
      q('UPDATE tasks SET timer_started_at = NULL, time_spent = time_spent + ?, updated_at = ? WHERE id = ?').run(extra, now(), task.id);
    }
    return getTask(task.id);
  });
}

// ---------- projects ----------

export function getProject(id) {
  const p = mapProject(q('SELECT * FROM projects WHERE id = ?').get(Number(id)));
  if (!p) throw new AppError(404, `Project ${id} not found`);
  return p;
}

/** The project used when none is specified: the first active one on the home page. */
export function defaultProjectId() {
  const p = q('SELECT id FROM projects ORDER BY archived, position LIMIT 1').get();
  if (!p) throw new AppError(500, 'No projects exist');
  return p.id;
}

/** Resolve a project by numeric id or (case/punctuation-insensitive) name. */
export function resolveProject(ref) {
  if (ref == null || ref === '') return getProject(defaultProjectId());
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return getProject(Number(ref));
  const all = q('SELECT * FROM projects ORDER BY archived, position').all().map(mapProject);
  const hit = fuzzyFind(all, ref);
  if (!hit) throw new AppError(404, `No project matching "${ref}". Projects: ${all.map((p) => p.name).join(', ')}`);
  return hit;
}

function dueState(t, today, nowIso, weekEnd) {
  if (!t.due_at) return null;
  const overdue = t.due_has_time ? t.due_at < nowIso : t.due_at < today;
  if (overdue) return 'overdue';
  const day = t.due_has_time ? localDate(new Date(t.due_at)) : t.due_at;
  if (day === today) return 'today';
  return day <= weekEnd ? 'week' : 'later';
}

/** Every project with the numbers the home page shows: per-column counts, deadlines, progress. */
export function listProjects({ includeArchived = true } = {}) {
  const projects = q(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived, position`).all().map(mapProject);
  const columns = listColumns();
  const colById = new Map(columns.map((c) => [c.id, c]));
  const tasks = q('SELECT column_id, due_at, due_has_time, completed_at, updated_at FROM tasks WHERE archived = 0').all();
  const today = localDate();
  const nowIso = now();
  const weekEnd = localDate(new Date(Date.now() + 7 * 86400000));
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const stats = new Map(
    projects.map((p) => [
      p.id,
      {
        total: 0,
        done: 0,
        overdue: 0,
        dueToday: 0,
        dueWeek: 0,
        completedThisWeek: 0,
        lastActivity: p.updatedAt,
        byColumn: new Map(columns.filter((c) => c.projectId === p.id).map((c) => [c.id, 0])),
      },
    ])
  );
  for (const t of tasks) {
    const col = colById.get(t.column_id);
    const st = col && stats.get(col.projectId);
    if (!st) continue;
    st.total++;
    st.byColumn.set(col.id, (st.byColumn.get(col.id) || 0) + 1);
    if (t.updated_at > st.lastActivity) st.lastActivity = t.updated_at;
    if (col.isDone) {
      st.done++;
      if (t.completed_at && t.completed_at >= weekAgo) st.completedThisWeek++;
      continue;
    }
    const due = dueState(t, today, nowIso, weekEnd);
    if (due === 'overdue') st.overdue++;
    if (due === 'today') st.dueToday++;
    if (due === 'overdue' || due === 'today' || due === 'week') st.dueWeek++;
  }
  return projects.map((p) => {
    const st = stats.get(p.id);
    return {
      ...p,
      stats: {
        total: st.total,
        done: st.done,
        open: st.total - st.done,
        overdue: st.overdue,
        dueToday: st.dueToday,
        dueWeek: st.dueWeek,
        completedThisWeek: st.completedThisWeek,
        lastActivity: st.lastActivity,
        columns: columns
          .filter((c) => c.projectId === p.id)
          .map((c) => ({ id: c.id, name: c.name, color: c.color, isDone: c.isDone, hidden: c.hidden, count: st.byColumn.get(c.id) || 0 })),
      },
    };
  });
}

/** Open tasks due within `days` (overdue included) across every active project, soonest first. */
export function dueSoon({ days = 7, limit = 12 } = {}) {
  const until = localDate(new Date(Date.now() + days * 86400000)) + 'T23:59:59.999Z';
  const rows = q(
    `SELECT t.*, c.name AS column_name, p.id AS project_id, p.name AS project_name, p.icon AS project_icon, p.color AS project_color
     FROM tasks t JOIN columns c ON c.id = t.column_id JOIN projects p ON p.id = c.project_id
     WHERE t.archived = 0 AND p.archived = 0 AND c.is_done = 0 AND c.hidden = 0 AND t.due_at IS NOT NULL AND t.due_at <= ?
     ORDER BY t.due_at LIMIT ?`
  ).all(until, Math.min(Number(limit) || 12, 100));
  return withSubtasks(rows).map((t, i) => ({
    ...t,
    columnName: rows[i].column_name,
    project: { id: rows[i].project_id, name: rows[i].project_name, icon: rows[i].project_icon, color: rows[i].project_color },
  }));
}

export function createProject({ name, icon = '📋', color = 'blue', description = '', copyColumnsFrom } = {}) {
  return tx(() => {
    const { m } = q('SELECT COALESCE(MAX(position), 0) AS m FROM projects').get();
    const id = Number(
      q('INSERT INTO projects (name, icon, color, description, position) VALUES (?, ?, ?, ?, ?)').run(
        cleanText(name, 'name', { max: 80, required: true }),
        cleanText(icon, 'icon', { max: 16, required: true }),
        COLORS.includes(color) ? color : 'blue',
        cleanText(description, 'description', { max: 280 }),
        m + 1024
      ).lastInsertRowid
    );
    const template =
      copyColumnsFrom != null ? listColumns(getProject(copyColumnsFrom).id).map((c) => [c.name, c.color, c.isDone ? 1 : 0, c.hidden ? 1 : 0]) : DEFAULT_COLUMNS.map((c) => [...c, 0]);
    template.forEach(([colName, colColor, isDone, hidden], i) =>
      q('INSERT INTO columns (project_id, name, color, position, is_done, hidden) VALUES (?, ?, ?, ?, ?, ?)').run(id, colName, colColor, (i + 1) * 1024, isDone, hidden)
    );
    return getProject(id);
  });
}

export function updateProject(id, patch = {}) {
  return tx(() => {
    const p = getProject(id);
    const sets = [];
    const vals = [];
    if (patch.name !== undefined) sets.push('name = ?'), vals.push(cleanText(patch.name, 'name', { max: 80, required: true }));
    if (patch.icon !== undefined) sets.push('icon = ?'), vals.push(cleanText(patch.icon, 'icon', { max: 16, required: true }));
    if (patch.description !== undefined) sets.push('description = ?'), vals.push(cleanText(patch.description, 'description', { max: 280 }));
    if (patch.color !== undefined) {
      if (!COLORS.includes(patch.color)) throw new AppError(400, `color must be one of ${COLORS.join(', ')}`);
      sets.push('color = ?'), vals.push(patch.color);
    }
    if (patch.archived !== undefined) {
      if (patch.archived && !p.archived) {
        const { n } = q('SELECT COUNT(*) AS n FROM projects WHERE archived = 0').get();
        if (n <= 1) throw new AppError(400, 'At least one project must stay active');
      }
      sets.push('archived = ?'), vals.push(patch.archived ? 1 : 0);
    }
    if (sets.length) {
      sets.push('updated_at = ?'), vals.push(now());
      q(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, p.id);
    }
    return getProject(p.id);
  });
}

/** Move a project to `index` among active projects (0-based). The first one is the default for agents. */
export function moveProject(id, index) {
  return tx(() => {
    const p = getProject(id);
    const others = q('SELECT id FROM projects WHERE archived = 0 AND id != ? ORDER BY position').all(p.id);
    others.splice(Math.max(0, Math.min(Number(index), others.length)), 0, { id: p.id });
    others.forEach((x, i) => q('UPDATE projects SET position = ? WHERE id = ?').run((i + 1) * 1024, x.id));
    return getProject(p.id);
  });
}

/** Permanently delete a project with all its columns, tasks and subtasks. */
export function deleteProject(id) {
  return tx(() => {
    const p = getProject(id);
    const { n } = q('SELECT COUNT(*) AS n FROM projects WHERE id != ?').get(p.id);
    if (n === 0) throw new AppError(400, 'Cannot delete the only project');
    const { tasks } = q('SELECT COUNT(*) AS tasks FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE project_id = ?)').get(p.id);
    q('DELETE FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE project_id = ?)').run(p.id);
    q('DELETE FROM columns WHERE project_id = ?').run(p.id);
    q('DELETE FROM projects WHERE id = ?').run(p.id);
    return { deleted: p.id, tasksDeleted: tasks };
  });
}

// ---------- subtasks ----------

function getSubtaskRow(id) {
  const r = q('SELECT * FROM subtasks WHERE id = ?').get(Number(id));
  if (!r) throw new AppError(404, `Subtask ${id} not found`);
  return r;
}

function touch(taskId) {
  q('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), taskId);
}

export function addSubtask(taskId, title) {
  return tx(() => {
    const task = getTask(taskId);
    const { p } = q('SELECT COALESCE(MAX(position), 0) + 1024 AS p FROM subtasks WHERE task_id = ?').get(task.id);
    const id = q('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)').run(task.id, cleanText(title, 'title', { max: 500, required: true }), p).lastInsertRowid;
    touch(task.id);
    return mapSubtask(getSubtaskRow(id));
  });
}

export function updateSubtask(id, patch = {}) {
  return tx(() => {
    const row = getSubtaskRow(id);
    if (patch.title !== undefined) q('UPDATE subtasks SET title = ? WHERE id = ?').run(cleanText(patch.title, 'title', { max: 500, required: true }), row.id);
    if (patch.done !== undefined) q('UPDATE subtasks SET done = ? WHERE id = ?').run(patch.done ? 1 : 0, row.id);
    if (patch.index !== undefined) {
      const sibs = q('SELECT id FROM subtasks WHERE task_id = ? AND id != ? ORDER BY position').all(row.task_id, row.id);
      sibs.splice(Math.max(0, Math.min(Number(patch.index), sibs.length)), 0, { id: row.id });
      sibs.forEach((s, i) => q('UPDATE subtasks SET position = ? WHERE id = ?').run((i + 1) * 1024, s.id));
    }
    touch(row.task_id);
    return mapSubtask(getSubtaskRow(row.id));
  });
}

export function deleteSubtask(id) {
  return tx(() => {
    const row = getSubtaskRow(id);
    q('DELETE FROM subtasks WHERE id = ?').run(row.id);
    touch(row.task_id);
    return { deleted: row.id, taskId: row.task_id };
  });
}

// ---------- settings ----------

export const REMINDER_DEFAULTS = {
  enabled: true,
  dayBefore: true,
  morningOf: true,
  hourBefore: true,
  leadMinutes: 60,
  overdue: true,
  morningTime: '09:00',
};

function getSetting(key, fallback) {
  const r = q('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}

function setSetting(key, value) {
  q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function getReminderSettings() {
  return { ...REMINDER_DEFAULTS, ...getSetting('reminders', {}) };
}

export function updateReminderSettings(patch = {}) {
  return tx(() => {
    const next = { ...getReminderSettings() };
    for (const k of ['enabled', 'dayBefore', 'morningOf', 'hourBefore', 'overdue']) if (patch[k] !== undefined) next[k] = !!patch[k];
    if (patch.leadMinutes !== undefined) {
      const m = Math.round(Number(patch.leadMinutes));
      if (!(m >= 5 && m <= 24 * 60)) throw new AppError(400, 'leadMinutes must be between 5 and 1440');
      next.leadMinutes = m;
    }
    if (patch.morningTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.morningTime))) throw new AppError(400, 'morningTime must be HH:MM');
      next.morningTime = patch.morningTime;
    }
    setSetting('reminders', next);
    return next;
  });
}

// ---------- AI chat provider (any OpenAI-compatible API) ----------

/** Full config, including the API key. Server-side only. */
export function getLlmConfig() {
  return { baseUrl: '', apiKey: '', model: '', ...getSetting('llm', {}) };
}

/** Safe to send to the browser: the key itself never leaves the server. */
export function getLlmSettings() {
  const c = getLlmConfig();
  return { baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey, keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : '', configured: !!(c.baseUrl && c.model) };
}

/** `apiKey`: omit to keep the saved key, '' to remove it. */
export function updateLlmSettings(patch = {}) {
  return tx(() => {
    const next = getLlmConfig();
    if (patch.baseUrl !== undefined) {
      const url = String(patch.baseUrl).trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new AppError(400, 'Base URL must start with http:// or https://');
      next.baseUrl = url;
    }
    if (patch.model !== undefined) next.model = cleanText(patch.model, 'model', { max: 200 }).trim();
    if (patch.apiKey !== undefined) next.apiKey = cleanText(patch.apiKey, 'apiKey', { max: 1000 }).trim();
    setSetting('llm', next);
    return getLlmSettings();
  });
}

/** VAPID keys for Web Push, created once per install. */
export function getVapidKeys(generate) {
  let keys = getSetting('vapid', null);
  if (!keys) {
    keys = generate();
    tx(() => setSetting('vapid', keys));
  }
  return keys;
}

// ---------- push subscriptions & reminder log ----------

export function savePushSubscription(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new AppError(400, 'Invalid push subscription');
  tx(() =>
    q('INSERT INTO push_subscriptions (endpoint, keys) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys').run(
      String(sub.endpoint),
      JSON.stringify(sub.keys)
    )
  );
  return { ok: true };
}

export function deletePushSubscription(endpoint) {
  tx(() => q('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint)));
  return { ok: true };
}

export function listPushSubscriptions() {
  return q('SELECT endpoint, keys FROM push_subscriptions').all().map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys) }));
}

/** Open tasks with a deadline in active projects and visible columns — reminder candidates. */
export function reminderCandidates() {
  return q(
    `SELECT t.id, t.title, t.due_at, t.due_has_time, t.created_at, c.name AS column_name, p.id AS project_id, p.name AS project_name, p.icon AS project_icon
     FROM tasks t JOIN columns c ON c.id = t.column_id JOIN projects p ON p.id = c.project_id
     WHERE t.archived = 0 AND p.archived = 0 AND c.is_done = 0 AND c.hidden = 0 AND t.due_at IS NOT NULL`
  ).all();
}

/** Record a reminder; returns false if it was already sent (so each fires exactly once). */
export function markReminderSent(taskId, kind, dueAt) {
  return Number(q('INSERT OR IGNORE INTO reminders_sent (task_id, kind, due_at) VALUES (?, ?, ?)').run(taskId, kind, dueAt).changes) > 0;
}

/** Changes whenever *another* connection (e.g. the MCP process) commits. */
export function dataVersion() {
  return q('PRAGMA data_version').get().data_version;
}
