import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'tt-claims-'));
const DB = join(tmp, 'test.db');
process.env.TASKTRACKER_DB = DB;
const store = await import('../server/db.js');
const actions = await import('../server/actions.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));

const pid = store.listProjects()[0].id;
const A = { agent: 'Claude Code', session: 'session-a' };
const B = { agent: 'Cursor', session: 'session-b' };

test('a claim is a lease: one holder, renewable, released on request', () => {
  const t = store.createTask({ projectId: pid, title: 'Claim me' });
  const first = store.claimTask(t.id, { ...A, note: 'writing docs' });
  assert.equal(first.claim.agent, 'Claude Code');
  assert.equal(store.getTask(t.id).claim.note, 'writing docs');
  // another agent is told, nothing changes
  const second = store.claimTask(t.id, B);
  assert.equal(second.heldBy.agent, 'Claude Code');
  assert.equal(store.getClaim(t.id).session, 'session-a');
  // only the holder renews or releases with its session; the user can always release
  assert.equal(store.refreshClaim(t.id, 'session-b'), false);
  assert.equal(store.refreshClaim(t.id, 'session-a'), true);
  assert.equal(store.releaseClaim(t.id, { session: 'session-b' }).released, false);
  assert.equal(store.releaseClaim(t.id).released, true);
  assert.equal(store.getTask(t.id).claim, null);
});

test('claims expire on their own, and a new agent can take the card', () => {
  const t = store.createTask({ projectId: pid, title: 'Forgotten' });
  store.claimTask(t.id, A);
  store.db.prepare('UPDATE claims SET expires_at = ? WHERE task_id = ?').run(new Date(Date.now() - 1000).toISOString(), t.id);
  assert.equal(store.getTask(t.id).claim, null, 'an expired claim is not shown');
  assert.equal(store.claimTask(t.id, B).claim.agent, 'Cursor');
});

test('finishing, archiving or deleting a card releases its claim; so does the agent leaving', () => {
  const done = store.createTask({ projectId: pid, title: 'Done soon' });
  const arch = store.createTask({ projectId: pid, title: 'Archive soon' });
  const gone = store.createTask({ projectId: pid, title: 'Delete soon' });
  const kept = store.createTask({ projectId: pid, title: 'Session ends' });
  for (const t of [done, arch, gone, kept]) store.claimTask(t.id, A);
  store.completeTask(done.id);
  store.archiveTask(arch.id);
  store.deleteTask(gone.id);
  assert.equal(store.getClaim(done.id), null);
  assert.equal(store.getClaim(arch.id), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM claims WHERE task_id = ?').get(gone.id).n, 0);
  assert.equal(store.releaseSession('session-a'), 1);
  assert.equal(store.getClaim(kept.id), null);
  assert.throws(() => store.claimTask(done.id, A), /already done/);
});

test('requests flag changes made since the agent asked, but not append-only ones', () => {
  const t = store.createTask({ projectId: pid, title: 'Original', priority: 'low', subtasks: ['step'] });
  const p = actions.propose({
    ...A,
    actions: [
      { type: 'update_task', task: t.id, title: 'Agent title', priority: 'high' },
      { type: 'move_task', task: t.id, column: 'In Progress' },
      { type: 'add_note', task: t.id, text: 'progress' },
      { type: 'update_subtask', subtask_id: t.subtasks[0].id, done: true },
    ],
  });
  let review = actions.annotate(store.getProposal(p.id));
  assert.deepEqual(review.items.map((i) => i.changed ?? null), [null, null, null, null], 'nothing changed yet');
  // the user edits the title and drags the card within its column (not a conflict)
  store.updateTask(t.id, { title: 'Edited by me' });
  store.moveTask(t.id, { columnId: t.columnId, index: 0 });
  store.appendNote(t.id, 'my own note');
  review = actions.annotate(store.getProposal(p.id));
  assert.deepEqual(review.items[0].changed, ['title']);
  assert.equal(review.items[1].changed, undefined, 'still in the same column');
  assert.equal(review.items[2].changed, undefined, 'notes are append-only');
  // the user ticks the subtask themselves
  store.updateSubtask(t.subtasks[0].id, { done: true });
  assert.deepEqual(actions.annotate(store.getProposal(p.id)).items[3].changed, ['subtask']);
});

test('requests show when another agent is working on the card', () => {
  const t = store.createTask({ projectId: pid, title: 'Contested' });
  store.claimTask(t.id, { ...B, note: 'refactoring' });
  const mine = actions.propose({ ...A, actions: [{ type: 'update_task', task: t.id, priority: 'high' }] });
  assert.deepEqual(actions.annotate(store.getProposal(mine.id)).items[0].claimedBy.agent, 'Cursor');
  const theirs = actions.propose({ ...B, actions: [{ type: 'update_task', task: t.id, priority: 'urgent' }] });
  assert.equal(actions.annotate(store.getProposal(theirs.id)).items[0].claimedBy, undefined, 'your own claim is no warning');
  store.releaseClaim(t.id);
});

async function connect(name) {
  const c = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/index.js'], env: { ...process.env, TASKTRACKER_DB: DB, NODE_OPTIONS: '' } });
  await c.connect(transport);
  return { c, transport, call: async (tool, args) => (await c.callTool({ name: tool, arguments: args })).content.map((x) => x.text).join('\n') };
}

test('over MCP: claim, heads-up for a second agent, renew on touch, release on disconnect', async () => {
  const t = store.createTask({ projectId: pid, title: 'Shared card' });
  const a = await connect('claude-code');
  const b = await connect('cursor');
  try {
    assert.match(await a.call('claim_task', { id: t.id, note: 'writing tests' }), /You're marked as working on/);
    assert.match(await b.call('claim_task', { id: t.id }), /Claude Code is already working on/);
    assert.match(await b.call('get_task', { id: t.id }), /working on it: Claude Code since .*writing tests/);
    // a write from the other agent still goes through, with a heads-up
    assert.match(await b.call('update_task', { id: t.id, priority: 'high' }), /Heads-up: Claude Code is working on/);
    // the holder's touch renews the lease
    const before = store.getClaim(t.id).expiresAt;
    await new Promise((r) => setTimeout(r, 15));
    await a.call('append_note', { id: t.id, text: 'half way' });
    assert.ok(store.getClaim(t.id).expiresAt > before);
  } finally {
    await b.c.close();
    await a.c.close();
  }
  // the server process exits with its client; its claims go with it
  for (let i = 0; i < 50 && store.getClaim(t.id); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.getClaim(t.id), null);
});
