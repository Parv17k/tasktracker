import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TASKTRACKER_DB = join(mkdtempSync(join(tmpdir(), 'tt-')), 'test.db');
const store = await import('../server/db.js');
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
