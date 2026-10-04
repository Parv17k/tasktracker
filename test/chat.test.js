import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TASKTRACKER_DB = join(mkdtempSync(join(tmpdir(), 'tt-chat-')), 'test.db');
const store = await import('../server/db.js');
const chat = await import('../server/chat.js');

// a tiny OpenAI-compatible provider that records what it receives
const received = [];
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] }));
    if (req.headers.authorization !== 'Bearer sk-test-1234') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['Focus on ', '**#1**', ' first.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
after(() => provider.close());

test('provider settings validate and never expose the key', () => {
  assert.equal(store.getLlmSettings().configured, false);
  assert.throws(() => store.updateLlmSettings({ baseUrl: 'ftp://nope' }), /http/);
  const s = store.updateLlmSettings({ baseUrl: `${baseUrl}/`, apiKey: 'sk-test-1234', model: 'a-model' });
  assert.deepEqual(s, { baseUrl, model: 'a-model', hasKey: true, keyHint: '…1234', configured: true });
  assert.ok(!JSON.stringify(s).includes('sk-test'));
  // omitting the key keeps it; '' removes it
  assert.equal(store.updateLlmSettings({ model: 'b-model' }).hasKey, true);
  assert.equal(store.getLlmConfig().apiKey, 'sk-test-1234');
});

test('board snapshot covers projects, columns, due labels and detail', () => {
  const now = new Date(2030, 0, 10, 9, 0);
  const pid = store.listProjects()[0].id;
  const t = store.createTask({ title: 'Write report', priority: 'high', dueAt: '2030-01-11', description: 'Quarterly numbers', subtasks: ['draft', 'review'] });
  const text = chat.boardContext({ projectId: pid, now });
  assert.match(text, /Today is .*2030/);
  assert.match(text, /\(open on screen\)/);
  assert.match(text, new RegExp(`- #${t.id} Write report · high priority · Due tomorrow \\(2030-01-11\\) · subtasks 0/2`));
  assert.match(text, /Description: Quarterly numbers/);
  // a timed task late in the evening keeps its local date even when UTC has rolled over
  const late = store.createTask({ title: 'Evening call', dueAt: new Date(2030, 0, 10, 23, 30).toISOString() });
  assert.match(chat.boardContext({ now }), new RegExp(`#${late.id} Evening call · .*\\(2030-01-10 23:30\\)`));
  assert.match(text, /### Done \(done column\)/);
  assert.match(chat.systemPrompt(text), /cannot change anything/);
});

test('conversation is validated', () => {
  assert.throws(() => chat.cleanMessages([]), /non-empty/);
  assert.throws(() => chat.cleanMessages([{ role: 'system', content: 'x' }]), /role/);
  assert.throws(() => chat.cleanMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }]), /last message/);
});

test('lists models and streams a reply with the snapshot attached', async () => {
  assert.deepEqual(await chat.listModels(), ['a-model', 'b-model']);
  let out = '';
  let started = false;
  await chat.streamChat({
    messages: [{ role: 'user', content: 'What first?' }],
    projectId: null,
    signal: new AbortController().signal,
    onStart: () => (started = true),
    write: (t) => (out += t),
  });
  assert.ok(started);
  assert.equal(out, 'Focus on **#1** first.');
  const sent = received.at(-1);
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.body.model, 'b-model');
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.messages[0].role, 'system');
  assert.match(sent.body.messages[0].content, /Write report/);
  assert.deepEqual(sent.body.messages.at(-1), { role: 'user', content: 'What first?' });
});

test('provider errors are explained before anything streams', async () => {
  store.updateLlmSettings({ apiKey: 'sk-wrong' });
  let started = false;
  await assert.rejects(
    chat.streamChat({ messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, onStart: () => (started = true), write: () => {} }),
    (err) => err.status === 401 && /Invalid API key/.test(err.message) && /Check the API key/.test(err.message)
  );
  assert.equal(started, false);
  store.updateLlmSettings({ baseUrl: 'http://127.0.0.1:9/v1' });
  await assert.rejects(chat.listModels(), /Could not reach/);
});
