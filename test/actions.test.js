import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-actions-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));
const actions = await import('../server/actions.js');

const pid = store.listProjects()[0].id;
const task = store.createTask({ projectId: pid, title: 'Write report', subtasks: ['Draft', 'Review'] });

test('preview describes changes without writing anything', () => {
  const before = store.dataVersion();
  const items = actions.preview([
    { type: 'move_task', task: task.id, column: 'in prog' },
    { type: 'update_task', task: `#${task.id}`, priority: 'High', due: '2030-01-11' },
    { type: 'create_task', project: store.getProject(pid).name, title: 'Book venue', priority: 'med', subtasks: ['Call', 'Pay deposit'] },
    { type: 'check_subtask', task: task.id, subtask: 'draft' },
    { type: 'add_note', task: task.id, text: 'Sent to Maya' },
    { type: 'create_project', name: 'Garden', icon: '🌱' },
  ]);
  assert.ok(items.every((i) => i.ok), JSON.stringify(items));
  assert.equal(items[0].summary, `#${task.id} Write report: Open → In Progress`);
  assert.match(items[1].summary, /priority → high/);
  assert.match(items[2].summary, /“Book venue” in .* › Open · medium priority · 2 subtasks/);
  assert.equal(items[3].verb, 'Tick');
  assert.equal(store.getTask(task.id).columnId, task.columnId, 'nothing moved');
  assert.equal(store.dataVersion(), before);
});

test('invalid actions are explained in plain words and never applied', () => {
  const items = actions.preview([
    { type: 'delete_task', task: task.id },
    { type: 'move_task', task: 99999, column: 'Done' },
    { type: 'move_task', task: task.id, column: 'Someday' },
    { type: 'update_task', task: task.id, priority: 'whenever' },
    { type: 'update_task', task: task.id, due: 'next blursday' },
    { type: 'complete_task' },
    'nonsense',
  ]);
  assert.deepEqual(items.map((i) => i.ok), [false, false, false, false, false, false, false]);
  assert.match(items[0].summary, /isn’t something the assistant can do/);
  assert.match(items[1].summary, /Task #99999 doesn’t exist/);
  assert.match(items[2].summary, /no column called “Someday”.*Columns: Open, In Progress/);
  assert.match(items[3].summary, /isn’t a priority/);
  assert.match(items[4].summary, /isn’t a date/);
  const same = actions.preview([{ type: 'update_task', task: task.id, priority: store.getTask(task.id).priority }]);
  assert.match(same[0].summary, /already looks like that/);
  assert.throws(() => actions.preview([]), /no changes/);
  assert.throws(() => actions.preview(Array(21).fill({ type: 'complete_task', task: task.id })), /too many/);
});

test('apply makes every approved change, in order', () => {
  const { applied } = actions.apply([
    { type: 'move_task', task: task.id, column: 'In Progress' },
    { type: 'update_task', task: task.id, priority: 'urgent', due: '2030-01-11' },
    { type: 'check_subtask', task: task.id, subtask: 'Draft' },
    { type: 'add_subtasks', task: task.id, subtasks: ['Publish'] },
    { type: 'add_note', task: task.id, text: 'Sent to Maya' },
    { type: 'create_task', project: pid, title: 'Book venue', due: '2030-02-01T15:30' },
    { type: 'create_project', name: 'Garden', icon: '🌱' },
  ]);
  assert.equal(applied.length, 7);
  const t = store.getTask(task.id);
  assert.equal(store.getColumn(t.columnId).name, 'In Progress');
  assert.equal(t.priority, 'urgent');
  assert.equal(t.dueAt, '2030-01-11');
  assert.deepEqual(t.subtasks.map((s) => [s.title, s.done]), [['Draft', true], ['Review', false], ['Publish', false]]);
  assert.match(t.note, /Sent to Maya/);
  const venue = store.listTasks({ query: 'Book venue' })[0];
  assert.ok(venue.dueHasTime);
  assert.ok(store.listProjects().some((p) => p.name === 'Garden'));
  // complete and archive
  actions.apply([{ type: 'complete_task', task: task.id }]);
  assert.ok(store.getColumn(store.getTask(task.id).columnId).isDone);
  actions.apply([{ type: 'archive_task', task: venue.id }]);
  assert.ok(store.getTask(venue.id).archived);
});

test('apply is all or nothing', () => {
  const t = store.createTask({ projectId: pid, title: 'Untouched' });
  assert.throws(
    () =>
      actions.apply([
        { type: 'update_task', task: t.id, title: 'Renamed' },
        { type: 'move_task', task: t.id, column: 'Nowhere' },
      ]),
    (err) => err.status === 400 && /^Nothing was changed\. There’s no column called “Nowhere”/.test(err.message)
  );
  assert.equal(store.getTask(t.id).title, 'Untouched');
});

test('tags: propose and apply tag changes on tasks and projects', () => {
  const t = store.createTask({ projectId: pid, title: 'Tag me', tags: ['old'] });
  const items = actions.preview([
    { type: 'update_task', task: t.id, add_tags: ['#Design', 'old'], remove_tags: ['OLD'] },
    { type: 'create_task', project: pid, title: 'Tagged at birth', tags: ['q4'] },
    { type: 'update_project', project: pid, add_tags: ['work'], priority: 'high' },
    { type: 'update_task', task: t.id, add_tags: ['a,b'] },
    { type: 'update_task', task: t.id, remove_tags: ['not-there'] },
  ]);
  assert.equal(items[0].summary, `#${t.id} Tag me: tags: add #Design, remove #old`);
  assert.match(items[1].summary, /#q4$/);
  assert.match(items[2].summary, /: priority → high, tags: add #work$/);
  assert.equal(items[3].ok, false);
  assert.match(items[3].summary, /commas/);
  assert.match(items[4].summary, /already looks like that/);
  actions.apply([
    { type: 'update_task', task: t.id, add_tags: ['Design'], remove_tags: ['old'] },
    { type: 'update_project', project: pid, add_tags: ['work'], priority: 'high' },
    { type: 'create_project', name: 'Big bet', priority: 'urgent', tags: ['work'] },
  ]);
  assert.deepEqual(store.getTask(t.id).tags, ['Design']);
  assert.deepEqual(store.getProject(pid).tags, ['work']);
  assert.equal(store.getProject(pid).priority, 'high');
  assert.equal(store.listProjects().find((p) => p.name === 'Big bet').priority, 'urgent');
});
