import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import { startReminders } from './reminders.js';
import { listModels, speak, streamChat, transcribe } from './chat.js';
import * as actions from './actions.js';

const PORT = Number(process.env.PORT) || 1717;
const HOST = process.env.HOST || '127.0.0.1';
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

const app = Fastify({ logger: false });

app.setErrorHandler((err, req, reply) => {
  const status = err.status || err.statusCode || 500;
  // chat errors carry a friendly message for people and a technical detail for this log
  if (err.kind) {
    if (err.detail) console.error(`chat ${err.kind}: ${err.detail}`);
  } else if (status >= 500) console.error(err);
  reply.code(status).send({ error: err.message, ...(err.kind && { kind: err.kind }) });
});

// ---------- live updates (SSE) ----------
// Each browser tab subscribes; writes from this process *and* from other
// processes (the MCP server) are pushed so the board refreshes instantly.

const clients = new Set();
let lastOrigin = null;

function send(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const broadcast = (origin) => send('change', { origin });

// Coalesce bursts of writes into one event per tick. The origin (the tab that
// made the change) is captured synchronously so that tab can skip a refetch.
let pending; // undefined = nothing queued
store.events.on('change', () => {
  if (pending === undefined) {
    pending = lastOrigin;
    setImmediate(() => {
      broadcast(pending);
      pending = undefined;
    });
  } else if (pending !== lastOrigin) pending = null;
});

let version = store.dataVersion();
setInterval(() => {
  const v = store.dataVersion();
  if (v !== version) {
    version = v;
    broadcast('external');
  }
}, 500).unref();

app.addHook('preHandler', async (req) => {
  lastOrigin = req.headers['x-client-id'] || null;
});

app.get('/api/events', (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 1500\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.raw.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ---------- API ----------

const id = (req) => Number(req.params.id);

app.get('/api/health', async () => ({ ok: true }));
app.get('/api/board', async () => store.getBoard());

// ---------- reminders & push ----------

const reminders = startReminders({ broadcast: send });

app.get('/api/settings/reminders', async () => store.getReminderSettings());
app.patch('/api/settings/reminders', async (req) => store.updateReminderSettings(req.body));
app.get('/api/push/key', async () => ({ publicKey: reminders.publicKey }));
app.post('/api/push/subscribe', async (req) => store.savePushSubscription(req.body));
app.post('/api/push/unsubscribe', async (req) => store.deletePushSubscription(req.body?.endpoint));
app.post('/api/push/test', async () => reminders.test());

// ---------- AI chat ----------

app.get('/api/settings/llm', async () => store.getLlmSettings());
app.patch('/api/settings/llm', async (req) => store.updateLlmSettings(req.body));
app.get('/api/chat/models', async () => ({ models: await listModels() }));
// voice: recordings arrive as raw audio; replies can be read aloud by the provider
app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (req, body, done) => done(null, body));
app.post('/api/chat/transcribe', async (req) => transcribe(req.body, req.headers['content-type']));
app.post('/api/chat/speech', async (req, reply) => {
  const { audio, contentType } = await speak(req.body?.text);
  return reply.type(contentType).header('Cache-Control', 'no-store').send(audio);
});

// changes proposed by the assistant: describe them for approval, then apply the approved ones
app.post('/api/chat/actions/preview', async (req) => ({ items: actions.preview(req.body?.actions) }));
app.post('/api/chat/actions/apply', async (req) => actions.apply(req.body?.actions));

// requests from agents (MCP) waiting for the user, and whether agents must ask first
app.get('/api/settings/agents', async () => store.getAgentSettings());
app.patch('/api/settings/agents', async (req) => store.updateAgentSettings(req.body));
app.get('/api/proposals', async (req) => store.listProposals({ status: req.query.status === 'recent' ? 'recent' : 'pending', limit: Math.min(Number(req.query.limit) || 50, 200) }));
app.post('/api/proposals/:id/apply', async (req) => actions.approve(id(req), req.body?.selected));
app.post('/api/proposals/:id/dismiss', async (req) => actions.dismiss(id(req)));
app.post('/api/chat', async (req, reply) => {
  const { messages, projectId } = req.body || {};
  // stop the upstream request if the user presses Stop or closes the tab
  const ac = new AbortController();
  reply.raw.on('close', () => !reply.raw.writableFinished && ac.abort());
  await streamChat({
    messages,
    projectId: projectId == null ? null : Number(projectId),
    signal: ac.signal,
    onStart: () => {
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    },
    write: (text) => reply.raw.write(text),
  });
  if (reply.sent || reply.raw.headersSent) reply.raw.end();
  else reply.code(204).send();
});

app.get('/api/home', async () => ({ projects: store.listProjects(), dueSoon: store.dueSoon({ days: 7, limit: 12 }), tags: store.listTags() }));

app.get('/api/tags', async () => store.listTags());
app.get('/api/timeline', async () => store.timeline());
app.patch('/api/tags/:id', async (req) => store.updateTag(id(req), req.body));
app.delete('/api/tags/:id', async (req) => store.deleteTag(id(req)));
app.get('/api/projects', async () => store.listProjects());
app.post('/api/projects', async (req, reply) => reply.code(201).send(store.createProject(req.body)));
app.get('/api/projects/:id/board', async (req) => store.getBoard(id(req)));
app.patch('/api/projects/:id', async (req) => store.updateProject(id(req), req.body));
app.post('/api/projects/:id/move', async (req) => store.moveProject(id(req), Number(req.body?.index)));
app.delete('/api/projects/:id', async (req) => store.deleteProject(id(req)));

app.get('/api/tasks', async (req) => {
  const { project, column, q, tag, archived, dueWithinDays, overdue, limit } = req.query;
  const projectId = project ? store.resolveProject(project).id : undefined;
  return store.listTasks({
    projectId,
    columnId: column ? store.resolveColumn(column, projectId).id : undefined,
    query: q,
    tag,
    archived: archived === 'all' ? 'all' : archived === 'true',
    dueWithinDays: dueWithinDays != null ? Number(dueWithinDays) : undefined,
    overdue: overdue === 'true',
    limit,
  });
});
app.get('/api/tasks/:id', async (req) => store.getTask(id(req)));
app.post('/api/tasks', async (req, reply) => reply.code(201).send(store.createTask(req.body)));
app.patch('/api/tasks/:id', async (req) => store.updateTask(id(req), req.body));
app.delete('/api/tasks/:id', async (req) => store.deleteTask(id(req)));
app.post('/api/tasks/:id/move', async (req) => store.moveTask(id(req), req.body));
app.post('/api/tasks/:id/complete', async (req) => store.completeTask(id(req)));
app.post('/api/tasks/:id/timer/start', async (req) => store.startTimer(id(req)));
app.post('/api/tasks/:id/timer/stop', async (req) => store.stopTimer(id(req)));
app.post('/api/tasks/:id/subtasks', async (req, reply) => reply.code(201).send(store.addSubtask(id(req), req.body?.title)));

app.patch('/api/subtasks/:id', async (req) => store.updateSubtask(id(req), req.body));
app.delete('/api/subtasks/:id', async (req) => store.deleteSubtask(id(req)));

app.get('/api/columns', async (req) => store.listColumns(req.query.project ? store.resolveProject(req.query.project).id : undefined));
app.post('/api/columns', async (req, reply) => reply.code(201).send(store.createColumn(req.body)));
app.patch('/api/columns/:id', async (req) => store.updateColumn(id(req), req.body));
app.post('/api/columns/:id/move', async (req) => store.moveColumn(id(req), Number(req.body?.index)));
app.delete('/api/columns/:id', async (req) => store.deleteColumn(id(req), { moveTo: req.query.moveTo }));

// ---------- static UI ----------

if (existsSync(DIST)) {
  // hashed assets are cached forever; index.html is always revalidated so rebuilds show up immediately
  await app.register(fastifyStatic, {
    root: DIST,
    setHeaders: (reply, path) => reply.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html', { maxAge: 0 });
  });
} else {
  app.get('/', async (req, reply) => reply.type('text/html').send('<p style="font-family:sans-serif">UI not built yet. Run <code>npm run build</code> (or <code>npm run dev</code> for development).</p>'));
}

await app.listen({ port: PORT, host: HOST });
console.log(`\n  ✦ Task Tracker running at  http://localhost:${PORT}`);
console.log(`    database: ${store.DB_PATH}\n`);
