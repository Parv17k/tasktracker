import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-tags-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

const pid = store.listProjects()[0].id;

test('tasks get tags; names are cleaned, deduplicated and sorted', () => {
  const t = store.createTask({ projectId: pid, title: 'Ship', tags: ['  #Design ', 'backend', 'design', 'Q4   launch'] });
  assert.deepEqual(t.tags, ['backend', 'Design', 'Q4 launch']);
  const updated = store.updateTask(t.id, { tags: ['backend'] });
  assert.deepEqual(updated.tags, ['backend']);
  assert.ok(updated.updatedAt >= t.updatedAt);
  // the board and listings carry tags too
  assert.deepEqual(store.getBoard(pid).tasks.find((x) => x.id === t.id).tags, ['backend']);
  assert.ok(store.getBoard(pid).tags.some((g) => g.name === 'backend'));
});

test('one tag per name regardless of case; the first spelling wins', () => {
  const a = store.createTask({ projectId: pid, title: 'A', tags: ['Research'] });
  const b = store.createTask({ projectId: pid, title: 'B', tags: ['research'] });
  assert.deepEqual(b.tags, ['Research']);
  const tag = store.listTags().find((g) => g.name === 'Research');
  assert.equal(tag.tasks, 2);
  assert.ok(store.COLORS.includes(tag.color));
  store.deleteTask(a.id);
  store.deleteTask(b.id);
});

test('filter and search tasks by tag', () => {
  const t = store.createTask({ projectId: pid, title: 'Plan offsite', tags: ['team'] });
  store.createTask({ projectId: pid, title: 'Unrelated' });
  assert.deepEqual(store.listTasks({ tag: 'TEAM' }).map((x) => x.id), [t.id]);
  assert.deepEqual(store.listTasks({ tag: '#team' }).map((x) => x.id), [t.id]);
  assert.ok(store.listTasks({ query: 'tea' }).some((x) => x.id === t.id), 'free-text search matches tag names');
});

test('projects get tags', () => {
  const p = store.createProject({ name: 'Garden', tags: ['home', 'Weekend'] });
  assert.deepEqual(p.tags, ['home', 'Weekend']);
  assert.deepEqual(store.updateProject(p.id, { tags: ['home'] }).tags, ['home']);
  assert.deepEqual(store.listProjects().find((x) => x.id === p.id).tags, ['home']);
  assert.equal(store.listTags().find((g) => g.name === 'home').projects, 1);
});

test('rename, recolour and delete a tag everywhere', () => {
  const t = store.createTask({ projectId: pid, title: 'Fix login', tags: ['bug'] });
  const p = store.createProject({ name: 'Website', tags: ['bug'] });
  const tag = store.resolveTag('bug');
  const renamed = store.updateTag(tag.id, { name: 'Bugs', color: 'rose' });
  assert.equal(renamed.name, 'Bugs');
  assert.equal(renamed.color, 'rose');
  assert.deepEqual(store.getTask(t.id).tags, ['Bugs']);
  assert.deepEqual(store.getProject(p.id).tags, ['Bugs']);
  assert.throws(() => store.updateTag(tag.id, { name: 'team' }), /already a tag called “team”/);
  assert.throws(() => store.updateTag(tag.id, { color: 'plaid' }), /color must be one of/);
  store.deleteTag(tag.id);
  assert.deepEqual(store.getTask(t.id).tags, []);
  assert.deepEqual(store.getProject(p.id).tags, []);
});

test('unused tags disappear; bad names are rejected', () => {
  const t = store.createTask({ projectId: pid, title: 'Temp', tags: ['ephemeral'] });
  store.updateTask(t.id, { tags: [] });
  assert.ok(!store.listTags().some((g) => g.name === 'ephemeral'));
  const u = store.createTask({ projectId: pid, title: 'Temp 2', tags: ['gone-with-task'] });
  store.deleteTask(u.id);
  assert.ok(!store.listTags().some((g) => g.name === 'gone-with-task'));
  assert.throws(() => store.updateTask(t.id, { tags: ['   '] }), /can’t be empty/);
  assert.throws(() => store.updateTask(t.id, { tags: ['a,b'] }), /commas/);
  assert.throws(() => store.updateTask(t.id, { tags: ['x'.repeat(41)] }), /too long/);
  assert.throws(() => store.updateTask(t.id, { tags: 'design' }), /list of names/);
  assert.throws(() => store.updateTask(t.id, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), /At most 20/);
});

test('changeTags adds and removes without duplicates, ignoring case and #', async () => {
  const { changeTags } = await import('../shared/tags.js');
  assert.deepEqual(changeTags(['Design', 'q4'], { add: ['#design', 'Bug'], remove: ['Q4'] }), ['Design', 'Bug']);
  assert.deepEqual(changeTags([], { add: ['x'], remove: ['x'] }), []);
});

test('projects have a priority', () => {
  const p = store.createProject({ name: 'Launch', priority: 'high' });
  assert.equal(p.priority, 'high');
  assert.equal(store.createProject({ name: 'Someday' }).priority, 'none');
  assert.equal(store.updateProject(p.id, { priority: 'urgent' }).priority, 'urgent');
  assert.equal(store.listProjects().find((x) => x.id === p.id).priority, 'urgent');
  assert.throws(() => store.updateProject(p.id, { priority: 'asap' }), /priority must be one of/);
  assert.throws(() => store.createProject({ name: 'X', priority: 'asap' }), /priority must be one of/);
});
