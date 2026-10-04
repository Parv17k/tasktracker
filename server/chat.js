// "Ask about your tasks": a read-only chat with any OpenAI-compatible provider.
// Each request carries a compact snapshot of the board, so it works with providers
// that have no tool calling. The API key stays on this server.
import * as store from './db.js';
import { dueInfo, formatDuration } from '../shared/due.js';

const CONTEXT_BUDGET = 60000; // characters of board snapshot per request
const MAX_TURNS = 24;
const RECENT_DONE = 8; // finished tasks shown per project

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// timestamps are stored in UTC; the model should see the user's local date and time
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDue = (t) => (t.dueHasTime ? `${localDay(new Date(t.dueAt))} ${pad(new Date(t.dueAt).getHours())}:${pad(new Date(t.dueAt).getMinutes())}` : t.dueAt);

function taskLine(t, { done, detail, now }) {
  const parts = [`- #${t.id} ${t.title}`];
  if (t.priority !== 'none') parts.push(`${t.priority} priority`);
  const due = !done && dueInfo(t.dueAt, t.dueHasTime, now);
  if (due) parts.push(`${due.label} (${localDue(t)})`);
  if (done && t.completedAt) parts.push(`completed ${localDay(new Date(t.completedAt))}`);
  if (t.subtasks.length) parts.push(`subtasks ${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}`);
  if (t.timeSpent || t.timerStartedAt) parts.push(`${formatDuration(t.timeSpent + (t.timerStartedAt ? (now - Date.parse(t.timerStartedAt)) / 1000 : 0))} tracked${t.timerStartedAt ? ' (timer running)' : ''}`);
  let out = parts.join(' · ');
  if (detail && !done) {
    if (t.description) out += `\n  Description: ${clip(t.description, 300)}`;
    if (t.note) out += `\n  Note: ${clip(t.note, 300)}`;
    const open = t.subtasks.filter((s) => !s.done);
    if (open.length) out += `\n  Open subtasks: ${open.slice(0, 8).map((s) => s.title).join('; ')}${open.length > 8 ? '; …' : ''}`;
  }
  return out;
}

/**
 * Markdown snapshot of every active project for the model. `projectId` is the board the
 * user is looking at; it goes first. Detail is dropped step by step to stay within budget.
 */
export function boardContext({ projectId = null, now = new Date() } = {}) {
  const projects = store.listProjects();
  const active = projects.filter((p) => !p.archived);
  active.sort((a, b) => (b.id === projectId) - (a.id === projectId));
  const columns = store.listColumns();
  const tasks = store.listTasks({ limit: 1000 });

  const render = (detail) =>
    active
      .map((p) => {
        const lines = [`## ${p.icon} ${p.name}${p.id === projectId ? ' (open on screen)' : ''}`];
        if (p.description) lines.push(clip(p.description, 300));
        for (const c of columns.filter((c) => c.projectId === p.id)) {
          let list = tasks.filter((t) => t.columnId === c.id);
          const total = list.length;
          if (c.isDone) list = list.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))).slice(0, RECENT_DONE);
          const flags = [c.isDone && 'done column', c.hidden && 'hidden'].filter(Boolean).join(', ');
          lines.push(`### ${c.name}${flags ? ` (${flags})` : ''} · ${total} task${total === 1 ? '' : 's'}${c.isDone && total > list.length ? `, ${list.length} most recent shown` : ''}`);
          for (const t of list) lines.push(taskLine(t, { done: c.isDone, detail, now }));
        }
        return lines.join('\n');
      })
      .join('\n\n');

  let text = render(true);
  if (text.length > CONTEXT_BUDGET) text = render(false);
  if (text.length > CONTEXT_BUDGET) text = `${text.slice(0, CONTEXT_BUDGET)}\n…(snapshot truncated)`;

  const archived = projects.filter((p) => p.archived).map((p) => p.name);
  const today = now.toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return [
    `Today is ${today} (the user's local time).`,
    projectId == null ? 'The user is on the home page, which shows every project.' : '',
    archived.length ? `Archived projects (not shown): ${archived.join(', ')}.` : '',
    '',
    text || '(No projects yet.)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function systemPrompt(context) {
  return `You are the assistant built into Task Tracker, a local Kanban app. Help the user understand and plan their work using the snapshot of their projects and tasks below.

- Be concise and practical. Prefer short bullet lists. Mention tasks as "#id Title".
- Base answers on the snapshot. If it doesn't contain the answer, say so.
- You cannot change anything yourself. If the user wants tasks created, moved or edited, say exactly what to change so they can do it on the board.

# Snapshot
${context}`;
}

/** Validates and trims the conversation sent by the browser. */
export function cleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new store.AppError(400, 'messages must be a non-empty array');
  const out = messages.slice(-MAX_TURNS).map((m) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new store.AppError(400, 'Each message needs a role (user or assistant) and text content');
    return { role: m.role, content: m.content.slice(0, 20000) };
  });
  if (out.at(-1).role !== 'user') throw new store.AppError(400, 'The last message must be from the user');
  return out;
}

function providerHeaders(apiKey) {
  return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

async function providerError(res) {
  const text = await res.text().catch(() => '');
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || text;
  } catch {}
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key.' : res.status === 404 ? ' Check the base URL and model name.' : '';
  return new store.AppError(res.status === 401 || res.status === 403 ? 401 : 502, `Provider replied ${res.status}: ${clip(msg, 300) || res.statusText}.${hint}`);
}

function unreachable(err, baseUrl) {
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return new store.AppError(504, 'The provider took too long to respond');
  return new store.AppError(502, `Could not reach ${baseUrl} (${err.cause?.code || err.message})`);
}

function requireConfig() {
  const cfg = store.getLlmConfig();
  if (!cfg.baseUrl || !cfg.model) throw new store.AppError(400, 'Set up a chat provider first');
  return cfg;
}

/** Model ids offered by the provider (also a quick connection test). */
export async function listModels() {
  const cfg = store.getLlmConfig();
  if (!cfg.baseUrl) throw new store.AppError(400, 'Set a base URL first');
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/models`, { headers: providerHeaders(cfg.apiKey), signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw unreachable(err, cfg.baseUrl);
  }
  if (!res.ok) throw await providerError(res);
  const body = await res.json().catch(() => ({}));
  return (body.data || body.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

/**
 * Streams the reply as plain text chunks to `write`. Throws (before anything is written)
 * if the provider can't be reached or rejects the request.
 */
export async function streamChat({ messages, projectId, signal, onStart, write }) {
  const cfg = requireConfig();
  const body = {
    model: cfg.model,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt(boardContext({ projectId })) }, ...cleanMessages(messages)],
  };

  // give up if the provider doesn't start answering within a minute; once it streams, only the user stops it
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal.addEventListener('abort', stop);
  const startup = setTimeout(() => ac.abort(new DOMException('No response', 'TimeoutError')), 60000);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers: providerHeaders(cfg.apiKey), body: JSON.stringify(body), signal: ac.signal });
  } catch (err) {
    if (signal.aborted) return;
    throw unreachable(err, cfg.baseUrl);
  } finally {
    clearTimeout(startup);
  }
  if (!res.ok) throw await providerError(res);
  onStart();

  // a provider that ignores `stream` answers with one JSON object
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const j = await res.json().catch(() => null);
    write(j?.choices?.[0]?.message?.content ?? '');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const j = JSON.parse(data);
          if (j.error) return write(`\n\n⚠️ ${j.error.message || j.error}`);
          const text = j.choices?.[0]?.delta?.content;
          if (text) write(text);
        } catch {}
      }
    }
  } catch (err) {
    if (!signal.aborted) write(`\n\n⚠️ The connection to the provider dropped (${err.message}).`);
  }
}
