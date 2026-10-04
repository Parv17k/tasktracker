import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-timeline-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

const pid = store.listProjects()[0].id;

test('tasks have an optional start date (a whole day)', () => {
  const t = store.createTask({ projectId: pid, title: 'Span', startAt: '2030-01-06', dueAt: '2030-01-10' });
  assert.equal(t.startAt, '2030-01-06');
  assert.equal(store.createTask({ projectId: pid, title: 'No start' }).startAt, null);
  // a datetime is cut to the local day
  const local = new Date(2030, 0, 7, 23, 30).toISOString();
  assert.equal(store.updateTask(t.id, { startAt: local }).startAt, '2030-01-07');
  assert.equal(store.updateTask(t.id, { startAt: '' }).startAt, null);
  assert.throws(() => store.updateTask(t.id, { startAt: 'soon' }), /Invalid start date/);
});

test('the start can’t be after the deadline', () => {
  assert.throws(() => store.createTask({ projectId: pid, title: 'Bad', startAt: '2030-01-11', dueAt: '2030-01-10' }), /start date can’t be after the deadline/);
  const t = store.createTask({ projectId: pid, title: 'Ok', startAt: '2030-01-10', dueAt: '2030-01-10' });
  assert.throws(() => store.updateTask(t.id, { dueAt: '2030-01-09' }), /after the deadline/);
  assert.throws(() => store.updateTask(t.id, { startAt: '2030-01-11' }), /after the deadline/);
  // moving both together is fine, and a timed deadline counts by its local day
  const moved = store.updateTask(t.id, { startAt: '2030-01-20', dueAt: new Date(2030, 0, 20, 9, 0).toISOString() });
  assert.equal(moved.startAt, '2030-01-20');
  assert.ok(moved.dueHasTime);
  // with no deadline, any start is fine
  assert.equal(store.updateTask(t.id, { dueAt: '' , startAt: '2031-05-01' }).startAt, '2031-05-01');
});

test('timeline data: dated tasks of active projects, recent done ones, undated counts', () => {
  const p = store.createProject({ name: 'Timeline project' });
  const cols = store.listColumns(p.id);
  const a = store.createTask({ projectId: p.id, title: 'Dated', startAt: '2030-02-01', dueAt: '2030-02-05' });
  store.createTask({ projectId: p.id, title: 'Undated' });
  store.createTask({ projectId: p.id, title: 'Undated 2' });
  const done = store.createTask({ projectId: p.id, title: 'Finished', dueAt: '2030-02-02' });
  store.completeTask(done.id);
  const archived = store.createTask({ projectId: p.id, title: 'Archived', dueAt: '2030-02-03' });
  store.archiveTask(archived.id);
  const data = store.timeline();
  const proj = data.projects.find((x) => x.id === p.id);
  assert.equal(proj.undated, 2);
  assert.deepEqual(proj.columns.map((c) => c.name), cols.filter((c) => !c.hidden).map((c) => c.name));
  const titles = data.tasks.filter((t) => proj.columns.some((c) => c.id === t.columnId)).map((t) => t.title);
  assert.deepEqual(titles.sort(), ['Dated', 'Finished']);
  assert.equal(data.tasks.find((t) => t.id === a.id).startAt, '2030-02-01');
  store.updateProject(p.id, { archived: true });
  assert.ok(!store.timeline().projects.some((x) => x.id === p.id), 'archived projects are left out');
});
