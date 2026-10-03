import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';

const PORT = Number(process.env.PORT) || 1717;
const HOST = process.env.HOST || '127.0.0.1';
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

const app = Fastify({ logger: false });

app.setErrorHandler((err, req, reply) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  reply.code(status).send({ error: err.message });
});

// ---------- live updates (SSE) ----------
// Each browser tab subscribes; writes from this process *and* from other
// processes (the MCP server) are pushed so the board refreshes instantly.

const clients = new Set();
let lastOrigin = null;

function broadcast(origin) {
  const msg = `event: change\ndata: ${JSON.stringify({ origin })}\n\n`;
  for (const res of clients) res.write(msg);
}

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

app.get('/api/tasks', async (req) => {
  const { column, q, archived, dueWithinDays, overdue, limit } = req.query;
  return store.listTasks({
    columnId: column ? store.resolveColumn(column).id : undefined,
    query: q,
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

app.get('/api/columns', async () => store.listColumns());
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
