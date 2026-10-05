import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'tt-proposals-'));
const DB = join(tmp, 'test.db');
process.env.TASKTRACKER_DB = DB;
const store = await import('../server/db.js');
const actions = await import('../server/actions.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

const pid = store.listProjects()[0].id;

test('agents ask first by default; the setting can be changed', () => {
  assert.equal(store.getAgentSettings().approval, 'ask');
  assert.equal(store.updateAgentSettings({ approval: 'auto' }).approval, 'auto');
  assert.throws(() => store.updateAgentSettings({ approval: 'sometimes' }), /approval must be/);
  store.updateAgentSettings({ approval: 'ask' });
});

test('a request waits, then applies only the chosen changes', () => {
  const t = store.createTask({ projectId: pid, title: 'Agent target', subtasks: ['one', 'two'] });
  const before = store.getTask(t.id);
  const p = actions.propose({
    agent: 'Claude Code',
    actions: [
      { type: 'move_task', task: t.id, column: 'In Progress' },
      { type: 'add_note', task: t.id, text: 'Started' },
      { type: 'create_task', project: pid, title: 'Follow-up from agent', tags: ['agent'] },
      { type: 'move_task', task: 99999, column: 'Done' },
    ],
  });
  assert.equal(p.status, 'pending');
  assert.equal(p.agent, 'Claude Code');
  assert.deepEqual(p.items.map((i) => i.ok), [true, true, true, false]);
  assert.deepEqual(store.getTask(t.id), before, 'nothing changes while it waits');
  assert.deepEqual(store.listProposals().map((x) => x.id), [p.id]);

  const done = actions.approve(p.id, [true, false, true, true]);
  assert.equal(done.status, 'applied');
  assert.equal(done.result.applied.length, 2, 'the unticked note and the invalid move are left out');
  const created = done.result.applied.find((a) => a.verb === 'Create');
  assert.ok(created.taskId > 0);
  assert.equal(store.getColumn(store.getTask(t.id).columnId).name, 'In Progress');
  assert.equal(store.getTask(t.id).note, '');
  assert.deepEqual(store.getTask(created.taskId).tags, ['agent']);
  assert.deepEqual(store.listProposals(), []);
  assert.equal(store.listProposals({ status: 'recent' })[0].id, p.id);
  assert.throws(() => actions.approve(p.id), /already applied/);
});

test('dismissing changes nothing; a request with nothing valid is refused', () => {
  const t = store.createTask({ projectId: pid, title: 'Leave me' });
  const p = actions.propose({ agent: 'Cursor', actions: [{ type: 'archive_task', task: t.id }] });
  assert.equal(actions.dismiss(p.id).status, 'dismissed');
  assert.equal(store.getTask(t.id).archived, false);
  assert.throws(() => actions.propose({ agent: 'Cursor', actions: [{ type: 'move_task', task: 99999, column: 'Done' }] }), /doesn’t exist/);
});

test('agents can propose subtask edits and deletes; the chat assistant can’t delete', () => {
  const t = store.createTask({ projectId: pid, title: 'Subs', subtasks: ['keep', 'drop'] });
  const [keep, drop] = t.subtasks;
  const p = actions.propose({ agent: 'Claude Code', actions: [{ type: 'update_subtask', subtask_id: keep.id, done: true }, { type: 'delete_subtask', subtask_id: drop.id }] });
  assert.deepEqual(p.items.map((i) => i.verb), ['Edit subtask', 'Delete subtask']);
  actions.approve(p.id);
  assert.deepEqual(store.getTask(t.id).subtasks.map((s) => [s.title, s.done]), [['keep', true]]);
  const chat = actions.preview([{ type: 'delete_subtask', subtask_id: keep.id }]);
  assert.equal(chat[0].ok, false);
  assert.match(chat[0].summary, /isn’t something the assistant can do/);
});

test('over MCP: ask mode queues requests; get_request reports the outcome; auto mode writes', async () => {
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env, TASKTRACKER_DB: DB } }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  try {
    const out = await call('create_task', { title: 'Written by MCP', project: pid, tags: ['mcp'] });
    assert.match(out, /Waiting for the user's approval in Task Tracker \(request (\d+)\)/);
    const id = Number(/request (\d+)/.exec(out)[1]);
    assert.equal(store.listTasks({ query: 'Written by MCP' }).length, 0);
    assert.equal(store.getProposal(id).agent, 'Claude Code');
    assert.match(await call('get_request', { id }), /still waiting/);
    actions.approve(id);
    const status = await call('get_request', { id });
    assert.match(status, /The user applied request/);
    assert.match(status, /→ task #\d+/);

    store.updateAgentSettings({ approval: 'auto' });
    assert.match(await call('create_task', { title: 'Straight in', project: pid }), /^Created in/);
    assert.equal(store.listTasks({ query: 'Straight in' }).length, 1);
  } finally {
    store.updateAgentSettings({ approval: 'ask' });
    await client.close();
  }
});
