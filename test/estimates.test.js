import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-estimates-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
const actions = await import('../server/actions.js');
const est = await import('../shared/estimate.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

test('parsing and formatting estimates', () => {
  const cases = { M: 240, xs: 30, XL: 1440, '30m': 30, '1.5h': 90, '2h30m': 150, '1d': 480, '1d 4h': 720, '90 min': 90, '2 hours': 120, 3: 180, '~2h': 120 };
  for (const [input, minutes] of Object.entries(cases)) assert.equal(est.parseEstimate(input === '3' ? '3' : input), minutes, input);
  assert.equal(est.parseEstimate(''), null);
  assert.throws(() => est.parseEstimate('soon'), /isn’t an estimate/);
  assert.throws(() => est.parseEstimate('100d'), /too large/);
  assert.equal(est.formatEstimate(90), '1h 30m');
  assert.equal(est.formatEstimate(720), '1d 4h');
  assert.equal(est.sizeOf(240).key, 'M');
  assert.equal(est.sizeOf(250), null);
});

test('tasks carry an optional estimate', () => {
  const pid = store.listProjects()[0].id;
  const t = store.createTask({ projectId: pid, title: 'Estimate me', estimateMinutes: 240 });
  assert.equal(t.estimateMinutes, 240);
  assert.equal(store.updateTask(t.id, { estimateMinutes: 90 }).estimateMinutes, 90);
  assert.equal(store.updateTask(t.id, { estimateMinutes: null }).estimateMinutes, null);
  assert.equal(store.createTask({ projectId: pid, title: 'None' }).estimateMinutes, null);
  assert.throws(() => store.updateTask(t.id, { estimateMinutes: 99999999 }), /too large/);
  assert.throws(() => store.updateTask(t.id, { estimateMinutes: 'lots' }), /number of minutes/);
});

test('projects: optional hourly rate and currency, plus work-left totals', () => {
  const p = store.createProject({ name: 'Client work', hourlyRate: 80, currency: 'eur' });
  assert.equal(p.hourlyRate, 80);
  assert.equal(p.currency, 'EUR');
  assert.equal(store.updateProject(p.id, { hourlyRate: '' }).hourlyRate, null);
  assert.equal(store.updateProject(p.id, { hourlyRate: 95.5 }).hourlyRate, 95.5);
  assert.throws(() => store.updateProject(p.id, { currency: 'euro' }), /3-letter code/);
  assert.throws(() => store.updateProject(p.id, { hourlyRate: -5 }), /hourly rate/);
  assert.equal(store.createProject({ name: 'Default' }).currency, 'USD');

  const a = store.createTask({ projectId: p.id, title: 'A', estimateMinutes: 240 });
  store.createTask({ projectId: p.id, title: 'B', estimateMinutes: 60 });
  store.createTask({ projectId: p.id, title: 'C' });
  const done = store.createTask({ projectId: p.id, title: 'D', estimateMinutes: 480 });
  store.completeTask(done.id);
  store.updateTask(a.id, { timeSpent: 3600 });
  const stats = store.listProjects().find((x) => x.id === p.id).stats;
  assert.equal(stats.estimateLeft, 300, 'only open tasks count as work left');
  assert.equal(stats.estimatedOpen, 2);
  assert.equal(stats.tracked, 3600);
});

test('the assistant and agents can propose estimates and rates', () => {
  const pid = store.listProjects()[0].id;
  const t = store.createTask({ projectId: pid, title: 'Plan me' });
  const items = actions.preview([
    { type: 'update_task', task: t.id, estimate: 'M' },
    { type: 'create_task', project: pid, title: 'Sized', estimate: '2h' },
    { type: 'update_task', task: t.id, estimate: 'forever' },
    { type: 'update_project', project: pid, hourly_rate: 60, currency: 'GBP' },
  ]);
  assert.match(items[0].summary, /estimate → M \(4h\)/);
  assert.match(items[1].summary, /~2h/);
  assert.equal(items[2].ok, false);
  assert.match(items[3].summary, /rate → £60\/h/);
  actions.apply([{ type: 'update_task', task: t.id, estimate: 'M' }, { type: 'update_project', project: pid, hourly_rate: 60, currency: 'GBP' }]);
  assert.equal(store.getTask(t.id).estimateMinutes, 240);
  assert.equal(store.getProject(pid).hourlyRate, 60);
});
