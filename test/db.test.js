import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));
const { dueInfo } = await import('../shared/due.js');

test('seeds four default columns with a done column', () => {
  const cols = store.listColumns();
  assert.deepEqual(cols.map((c) => c.name), ['Open', 'In Progress', 'Follow-up', 'Done']);
  assert.equal(cols.filter((c) => c.isDone).length, 1);
});

test('creates, moves and completes a task', () => {
  const t = store.createTask({ title: 'Ship it', subtasks: ['a', 'b'], dueAt: '2030-01-01' });
  assert.equal(t.subtasks.length, 2);
  const moved = store.moveTask(t.id, { columnId: store.resolveColumn('in progress').id, index: 0 });
  assert.equal(moved.columnId, store.resolveColumn('In Progress').id);
  const done = store.completeTask(t.id);
  assert.ok(done.completedAt);
  assert.equal(store.moveTask(t.id, { columnId: 1 }).completedAt, null);
});

test('keeps order when inserting between tasks', () => {
  const col = store.createColumn({ name: 'Order' });
  const [a, b, c] = ['a', 'b', 'c'].map((title) => store.createTask({ title, columnId: col.id }));
  store.moveTask(c.id, { columnId: col.id, index: 1 });
  assert.deepEqual(store.listTasks({ columnId: col.id }).map((t) => t.title), ['a', 'c', 'b']);
  void a, b;
});

test('deleting a column with tasks requires a destination', () => {
  const col = store.createColumn({ name: 'Temp' });
  const t = store.createTask({ title: 'orphan?', columnId: col.id });
  assert.throws(() => store.deleteColumn(col.id), /Choose a column/);
  store.deleteColumn(col.id, { moveTo: 1 });
  assert.equal(store.getTask(t.id).columnId, 1);
});

test('cannot hide the last visible column', () => {
  const cols = store.listColumns();
  cols.slice(1).forEach((c) => store.updateColumn(c.id, { hidden: true }));
  assert.throws(() => store.updateColumn(cols[0].id, { hidden: true }), /visible/);
  cols.slice(1).forEach((c) => store.updateColumn(c.id, { hidden: false }));
});

test('archive and restore', () => {
  const t = store.createTask({ title: 'archive me' });
  store.archiveTask(t.id);
  assert.ok(!store.getBoard().tasks.some((x) => x.id === t.id));
  assert.ok(store.listTasks({ archived: true }).some((x) => x.id === t.id));
  store.archiveTask(t.id, false);
  assert.ok(store.getBoard().tasks.some((x) => x.id === t.id));
});

test('overdue / due-soon filters exclude done tasks', () => {
  const late = store.createTask({ title: 'late', dueAt: '2001-01-01' });
  const lateDone = store.createTask({ title: 'late but done', dueAt: '2001-01-01' });
  store.completeTask(lateDone.id);
  const ids = store.listTasks({ overdue: true }).map((t) => t.id);
  assert.ok(ids.includes(late.id));
  assert.ok(!ids.includes(lateDone.id));
});

test('timer accumulates time and stops on completion', () => {
  const t = store.createTask({ title: 'timed' });
  store.startTimer(t.id);
  assert.ok(store.getTask(t.id).timerStartedAt);
  const done = store.completeTask(t.id);
  assert.equal(done.timerStartedAt, null);
});

test('due labels', () => {
  const now = new Date(2026, 9, 3, 12, 0); // Sat Oct 3 2026, noon
  assert.equal(dueInfo('2026-10-03', false, now).label, 'Due today');
  assert.equal(dueInfo('2026-10-04', false, now).label, 'Due tomorrow');
  assert.match(dueInfo('2026-10-05', false, now).label, /^Due in 2 days/);
  assert.match(dueInfo('2026-10-12', false, now).label, /^Due next week/);
  assert.equal(dueInfo('2026-10-02', false, now).label, 'Overdue · yesterday');
  assert.equal(dueInfo('2026-09-28', false, now).tone, 'overdue');
  assert.equal(dueInfo(new Date(2026, 9, 3, 15, 0).toISOString(), true, now).label, 'Due in 3h');
});

test('existing board migrates into a first project', () => {
  const [first] = store.listProjects();
  assert.equal(first.name, 'My Tasks');
  assert.ok(store.listColumns().every((c) => c.projectId === first.id));
});

test('new projects get the default four columns and their own tasks', () => {
  const p = store.createProject({ name: 'Website relaunch', icon: '🚀', color: 'violet' });
  const cols = store.listColumns(p.id);
  assert.deepEqual(cols.map((c) => c.name), ['Open', 'In Progress', 'Follow-up', 'Done']);
  const t = store.createTask({ title: 'Hero copy', projectId: p.id });
  assert.equal(store.getColumn(t.columnId).projectId, p.id);
  const board = store.getBoard(p.id);
  assert.deepEqual(board.tasks.map((x) => x.title), ['Hero copy']);
  assert.ok(!store.getBoard().tasks.some((x) => x.id === t.id), 'default board must not show other projects');
});

test('completing a task uses the done column of its own project', () => {
  const p = store.resolveProject('website');
  const t = store.createTask({ title: 'Launch', projectId: p.id });
  const done = store.completeTask(t.id);
  assert.equal(store.getColumn(done.columnId).projectId, p.id);
});

test('project stats count tasks per column and deadlines', () => {
  const p = store.createProject({ name: 'Stats' });
  const [open, prog] = store.listColumns(p.id);
  store.createTask({ title: 'a', columnId: open.id, dueAt: '2001-01-01' });
  store.createTask({ title: 'b', columnId: prog.id });
  store.completeTask(store.createTask({ title: 'c', projectId: p.id }).id);
  const { stats } = store.listProjects().find((x) => x.id === p.id);
  assert.equal(stats.total, 3);
  assert.equal(stats.done, 1);
  assert.equal(stats.open, 2);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.completedThisWeek, 1);
  assert.deepEqual(stats.columns.map((c) => c.count), [1, 1, 0, 1]);
  assert.ok(store.dueSoon().some((t) => t.title === 'a' && t.project.id === p.id));
});

test('copying columns from another project', () => {
  const src = store.resolveProject('stats');
  store.createColumn({ projectId: src.id, name: 'Blocked', color: 'rose' });
  const copy = store.createProject({ name: 'Copy', copyColumnsFrom: src.id });
  assert.deepEqual(store.listColumns(copy.id).map((c) => c.name), store.listColumns(src.id).map((c) => c.name));
});

test('hiding columns only counts columns in the same project', () => {
  const p = store.createProject({ name: 'Solo' });
  const cols = store.listColumns(p.id);
  cols.slice(1).forEach((c) => store.updateColumn(c.id, { hidden: true }));
  assert.throws(() => store.updateColumn(cols[0].id, { hidden: true }), /visible/);
});

test('cannot archive or delete the last project; delete removes its tasks', () => {
  const p = store.createProject({ name: 'Doomed' });
  const t = store.createTask({ title: 'gone', projectId: p.id });
  const r = store.deleteProject(p.id);
  assert.equal(r.tasksDeleted, 1);
  assert.throws(() => store.getTask(t.id), /not found/);
  const all = store.listProjects();
  all.slice(1).forEach((x) => store.updateProject(x.id, { archived: true }));
  assert.throws(() => store.updateProject(all[0].id, { archived: true }), /active/);
});

test('reminder timing: day before, morning of, lead time, overdue', async () => {
  const { reminderTimes, dueReminders } = await import('../server/reminders.js');
  const settings = { ...store.REMINDER_DEFAULTS };
  const dateOnly = { id: 1, due_at: '2030-05-10', due_has_time: 0, created_at: '2030-01-01T00:00:00Z' };
  const kinds = Object.fromEntries(reminderTimes(dateOnly, settings).map((r) => [r.kind, r.at]));
  assert.deepEqual(Object.keys(kinds).sort(), ['dayBefore', 'morningOf', 'overdue']);
  assert.equal(kinds.dayBefore.getDate(), 9);
  assert.equal(kinds.dayBefore.getHours(), 9);
  assert.equal(kinds.overdue.getDate(), 11);

  const due = new Date(2030, 4, 10, 15, 0);
  const timed = { id: 2, due_at: due.toISOString(), due_has_time: 1, created_at: '2030-01-01T00:00:00Z' };
  const t = Object.fromEntries(reminderTimes(timed, { ...settings, leadMinutes: 30 }).map((r) => [r.kind, r.at]));
  assert.equal(due - t.hourBefore, 30 * 60000);
  assert.equal(+t.overdue, +due);

  // fires inside the window, not before it, not long after
  assert.deepEqual(dueReminders([timed], settings, new Date(2030, 4, 10, 14, 10)).map((r) => r.kind).sort(), ['hourBefore', 'morningOf']);
  // 8:00 on the day: yesterday's 9:00 reminder is 23h old (past the 12h grace), today's 9:00 hasn't come yet
  assert.equal(dueReminders([timed], settings, new Date(2030, 4, 10, 8, 0)).length, 0);
  assert.deepEqual(dueReminders([timed], settings, new Date(2030, 4, 9, 9, 5)).map((r) => r.kind), ['dayBefore']);
  assert.equal(dueReminders([timed], { ...settings, enabled: false }, new Date(2030, 4, 10, 14, 10)).length, 0);
  // never for moments before the task existed
  const late = { ...timed, created_at: new Date(2030, 4, 10, 14, 30).toISOString() };
  assert.deepEqual(dueReminders([late], settings, new Date(2030, 4, 10, 14, 31)).map((r) => r.kind), []);
});

test('each reminder is logged once; settings validate', () => {
  assert.equal(store.markReminderSent(1, 'overdue', '2030-05-10'), true);
  assert.equal(store.markReminderSent(1, 'overdue', '2030-05-10'), false);
  assert.equal(store.markReminderSent(1, 'overdue', '2030-05-12'), true, 'a new due date re-arms the reminder');
  assert.equal(store.updateReminderSettings({ leadMinutes: 15, morningTime: '07:30' }).leadMinutes, 15);
  assert.throws(() => store.updateReminderSettings({ morningTime: '25:00' }), /HH:MM/);
  assert.throws(() => store.updateReminderSettings({ leadMinutes: 1 }), /leadMinutes/);
});

test('reminder text uses the real time left', async () => {
  const { message } = await import('../server/reminders.js');
  const now = new Date(2030, 4, 10, 14, 32);
  const task = { id: 7, title: 'Ship', due_at: new Date(2030, 4, 10, 15, 0).toISOString(), due_has_time: 1, project_id: 2, project_name: 'Web', project_icon: '🎨', column_name: 'Open' };
  const m = message({ task, kind: 'hourBefore' }, now);
  assert.equal(m.title, 'Due in 28 min · Ship');
  assert.equal(m.url, '/p/2?task=7');
  assert.equal(m.body, '🎨 Web · Open');
  assert.match(message({ task: { ...task, due_at: '2030-05-10', due_has_time: 0 }, kind: 'overdue' }).title, /^Overdue · Ship/);
});
