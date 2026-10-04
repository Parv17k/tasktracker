import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'tt-chat-'));
process.env.TASKTRACKER_DB = join(tmp, 'test.db');
const store = await import('../server/db.js');
after(() => (store.db.close(), rmSync(tmp, { recursive: true, force: true })));
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
  const t = store.createTask({ title: 'Write report', priority: 'high', dueAt: '2030-01-11', description: 'Quarterly numbers', subtasks: ['draft', 'review'], tags: ['finance'] });
  store.updateProject(pid, { tags: ['work'] });
  const text = chat.boardContext({ projectId: pid, now });
  assert.match(text, /Today is .*2030/);
  assert.match(text, /\(open on screen\)/);
  assert.match(text, new RegExp(`- #${t.id} Write report · high priority · #finance · Due tomorrow \\(2030-01-11\\) · subtasks 0/2`));
  assert.match(text, /^## .* #work \(open on screen\)$/m);
  assert.match(text, /Description: Quarterly numbers/);
  // a timed task late in the evening keeps its local date even when UTC has rolled over
  const late = store.createTask({ title: 'Evening call', dueAt: new Date(2030, 0, 10, 23, 30).toISOString() });
  assert.match(chat.boardContext({ now }), new RegExp(`#${late.id} Evening call · .*\\(2030-01-10 23:30\\)`));
  assert.match(text, /### Done \(done column\)/);
  assert.match(chat.systemPrompt(text), /nothing changes until they approve/);
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
    (err) => err.status === 401 && err.kind === 'auth' && /didn’t accept the API key/.test(err.message)
  );
  assert.equal(started, false);
  // a port nothing listens on
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  store.updateLlmSettings({ baseUrl: `http://127.0.0.1:${port}/v1` });
  await assert.rejects(chat.listModels(), (err) => err.kind === 'unreachable' && /Can’t connect to 127\.0\.0\.1:\d+\. If the model runs on this computer/.test(err.message));
});

test('error messages stay plain: no status codes, HTML or stack traces', async () => {
  const page = '<!doctype html><!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--><title>Origin is unreachable</title>';
  const res = (status, body) => new Response(body, { status });
  const cases = [
    [530, page, 'down'],
    [502, page, 'down'],
    [503, '{"error":{"message":"overloaded"}}', 'down'],
    [429, '{"error":{"message":"Rate limit reached for requests"}}', 'rate_limit'],
    [404, '{"error":"model \'nope\' not found"}', 'not_found'],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', 'too_long'],
    [400, page, 'bad_request'],
  ];
  for (const [status, body, kind] of cases) {
    const err = await chat.providerError(res(status, body), 'https://llm.example.com/v1');
    assert.equal(err.kind, kind, `status ${status}`);
    assert.doesNotMatch(err.message, /<|>|doctype|\b\d{3}\b|undefined/i, err.message);
    assert.ok(err.detail.includes(String(status)), 'technical detail kept for the server log');
  }
  assert.match((await chat.providerError(res(530, page), 'https://llm.example.com/v1')).message, /llm\.example\.com.*isn’t responding/);
  const timeout = chat.unreachable(Object.assign(new Error('x'), { name: 'TimeoutError' }), 'https://llm.example.com/v1');
  assert.equal(timeout.kind, 'timeout');
  const dns = chat.unreachable(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'https://llm.example.com/v1');
  assert.match(dns.message, /Can’t find llm\.example\.com/);
});

test('a web page instead of an API is reported as a wrong base URL', async () => {
  const html = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Welcome</body></html>');
  });
  await new Promise((r) => html.listen(0, '127.0.0.1', r));
  store.updateLlmSettings({ baseUrl: `http://127.0.0.1:${html.address().port}`, apiKey: 'sk-test-1234' });
  await assert.rejects(chat.listModels(), (err) => err.kind === 'bad_url' && /web page/.test(err.message));
  let started = false;
  await assert.rejects(
    chat.streamChat({ messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, onStart: () => (started = true), write: () => {} }),
    (err) => err.kind === 'bad_url'
  );
  assert.equal(started, false);
  html.close();
});

test('the system prompt explains how to propose changes', () => {
  const p = chat.systemPrompt('(snapshot)');
  assert.match(p, new RegExp('```' + chat.ACTIONS_FENCE));
  assert.match(p, /nothing changes until they approve/);
  assert.match(p, /cannot delete/);
});
