// "Ask about your tasks": chat with any OpenAI-compatible provider about the board.
// Each request carries a compact snapshot of the board, and the assistant proposes changes
// as a JSON block the user approves (see actions.js), so it works without tool calling.
// The API key stays on this server.
import * as store from './db.js';
import { dueInfo, formatDuration } from '../shared/due.js';
import { MAX_ACTIONS } from './actions.js';

/** Fence label for the block of proposed changes at the end of a reply (parsed by the web app). */
export const ACTIONS_FENCE = 'tasktracker-actions';

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
  if (t.tags?.length) parts.push(t.tags.map((g) => `#${g}`).join(' '));
  const due = !done && dueInfo(t.dueAt, t.dueHasTime, now);
  if (!done && t.startAt) parts.push(`starts ${t.startAt}`);
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
        const tags = p.tags?.length ? ` ${p.tags.map((g) => `#${g}`).join(' ')}` : '';
        const prio = p.priority !== 'none' ? ` · ${p.priority} priority` : '';
        const lines = [`## ${p.icon} ${p.name}${prio}${tags}${p.id === projectId ? ' (open on screen)' : ''}`];
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

# Proposing changes
You can propose changes to the board. The user sees them as an approval card and nothing changes until they approve.
Only propose changes when the user asks for them or clearly agrees to a suggestion. To propose, briefly say what you suggest, then end your reply with exactly one block like this:

\`\`\`${ACTIONS_FENCE}
[{"type": "move_task", "task": 12, "column": "In Progress"}]
\`\`\`

The block is a JSON array (at most ${MAX_ACTIONS} items) using these types:
- {"type":"create_task","project":"<name>","column":"<name, optional>","title":"...","description":"...","priority":"low|medium|high|urgent","start":"YYYY-MM-DD","due":"YYYY-MM-DD or YYYY-MM-DDTHH:MM","subtasks":["..."],"tags":["..."]}
- {"type":"update_task","task":<id>, then any of "title", "description", "priority", "start", "due" (use "" to remove either), "add_tags":["..."], "remove_tags":["..."]}
- {"type":"move_task","task":<id>,"column":"<column name in that task's project>"}
- {"type":"complete_task","task":<id>}
- {"type":"archive_task","task":<id>}
- {"type":"add_subtasks","task":<id>,"subtasks":["..."]}
- {"type":"check_subtask","task":<id>,"subtask":"<subtask title>","done":true}
- {"type":"add_note","task":<id>,"text":"..."}
- {"type":"create_project","name":"...","icon":"<one emoji>","description":"...","priority":"low|medium|high|urgent","tags":["..."]}
- {"type":"update_project","project":"<name>", then any of "priority", "add_tags":["..."], "remove_tags":["..."]}

Tags appear as #name in the snapshot; reuse existing tag names where they fit.

Rules: use task ids and names exactly as in the snapshot; dates are in the user's local time; you cannot delete anything (archive instead). Never say a change is done: the user approves it. Messages in brackets like "[Changes applied: …]" tell you what the user approved.

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

// ---------- errors people can act on ----------
// Providers fail in many shapes (JSON, HTML error pages, dropped sockets). Users see one plain
// sentence and a `kind` the UI turns into a next step; the raw detail only goes to the server log.

/** kind: setup | auth | not_found | bad_url | rate_limit | too_long | bad_request | down | timeout | unreachable */
export class ChatError extends store.AppError {
  constructor(status, kind, message, detail = '') {
    super(status, message);
    this.kind = kind;
    this.detail = detail;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return 'your AI provider';
  }
};

/** The provider's own message, only when it's short, human text (never an HTML page). */
function providerMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || '';
    return typeof m === 'string' && m.length <= 200 && !/[<>{}]/.test(m) ? m.trim() : '';
  } catch {
    return '';
  }
}

export async function providerError(res, baseUrl) {
  const raw = await res.text().catch(() => '');
  const said = providerMessage(raw);
  const s = res.status;
  const detail = `provider ${s}: ${clip(raw, 500)}`;
  if (s === 401 || s === 403) return new ChatError(401, 'auth', 'Your AI provider didn’t accept the API key. Open settings and check that the key is correct.', detail);
  if (s === 404) return new ChatError(502, 'not_found', 'Your AI provider couldn’t find that model. Open settings and check the base URL and model name.', detail);
  if (s === 429) return new ChatError(429, 'rate_limit', 'Your AI provider is busy, or you’ve reached its usage limit. Wait a minute and try again.', detail);
  if (s === 413 || (s === 400 && /context|token|too long|length/i.test(said))) {
    return new ChatError(502, 'too_long', 'This conversation is too long for the model. Start a new conversation and ask again.', detail);
  }
  if (s >= 400 && s < 500) {
    return new ChatError(502, 'bad_request', `Your AI provider couldn’t handle this request${said ? `: “${said}”` : '.'} Try asking differently, or check the model in settings.`, detail);
  }
  return new ChatError(502, 'down', `Your AI provider (${hostOf(baseUrl)}) isn’t responding right now. It may be down or restarting. Try again in a few minutes.`, detail);
}

export function unreachable(err, baseUrl) {
  const host = hostOf(baseUrl);
  const code = err.cause?.code || err.code || '';
  const detail = `${err.name}: ${code || err.message}`;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return new ChatError(504, 'timeout', 'Your AI provider took too long to answer. It may be overloaded. Try again in a moment.', detail);
  }
  if (code === 'ECONNREFUSED') {
    return new ChatError(502, 'unreachable', `Can’t connect to ${host}. If the model runs on this computer (like Ollama or LM Studio), make sure it’s open and running.`, detail);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ChatError(502, 'unreachable', `Can’t find ${host}. Check your internet connection and the base URL in settings.`, detail);
  }
  if (/CERT|SSL|TLS/i.test(code)) {
    return new ChatError(502, 'bad_url', `Couldn’t make a secure connection to ${host}. Check the base URL in settings.`, detail);
  }
  return new ChatError(502, 'unreachable', `Can’t reach ${host}. Check your internet connection and try again.`, detail);
}

// marks an answer that stopped part-way; the app shows it as a notice under the partial reply
export const CUT_OFF = '\n\n⚠️ The answer was cut off because the connection to your AI provider dropped. Try asking again.';

const notAnApi = (baseUrl, detail) =>
  new ChatError(502, 'bad_url', `${hostOf(baseUrl)} answered with a web page instead of an AI response. Check the base URL in settings; it usually ends in /v1.`, detail);

function requireConfig() {
  const cfg = store.getLlmConfig();
  if (!cfg.baseUrl || !cfg.model) throw new ChatError(400, 'setup', 'Set up an AI provider first. Open settings to add one.');
  return cfg;
}

/** Model ids offered by the provider (also a quick connection test). */
export async function listModels() {
  const cfg = store.getLlmConfig();
  if (!cfg.baseUrl) throw new ChatError(400, 'setup', 'Enter the base URL first.');
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/models`, { headers: providerHeaders(cfg.apiKey), signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw unreachable(err, cfg.baseUrl);
  }
  if (!res.ok) throw await providerError(res, cfg.baseUrl);
  const text = await res.text().catch(() => '');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw notAnApi(cfg.baseUrl, `models: ${clip(text, 300)}`);
  }
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
  if (!res.ok) throw await providerError(res, cfg.baseUrl);

  // a provider that ignores `stream` answers with one JSON object; a wrong URL often answers with a web page
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await res.text().catch(() => '');
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw notAnApi(cfg.baseUrl, `chat: ${clip(text, 300)}`);
    }
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ChatError(502, 'bad_url', 'Your AI provider sent a reply this app couldn’t read. Check that the base URL points to an OpenAI-compatible API.', `chat: ${clip(text, 300)}`);
    onStart();
    write(content);
    return;
  }
  onStart();

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
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) {
          console.error('chat stream error:', clip(JSON.stringify(j.error), 300));
          return write(CUT_OFF);
        }
        const text = j.choices?.[0]?.delta?.content;
        if (text) write(text);
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      console.error('chat stream dropped:', err.message);
      write(CUT_OFF);
    }
  }
}

// ---------- voice: speech-to-text and text-to-speech through the same provider ----------

const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

function requireVoice(kind) {
  const cfg = store.getLlmConfig();
  if (!cfg.baseUrl) throw new ChatError(400, 'setup', 'Set up an AI provider first. Open settings to add one.');
  const model = kind === 'stt' ? cfg.sttModel : cfg.ttsModel;
  if (!model) throw new ChatError(400, 'no_voice', kind === 'stt' ? 'No speech-to-text model is set. Add one in settings, or leave it empty to use your browser’s.' : 'No voice model is set. Add one in settings, or leave it empty to use your browser’s voice.');
  return { ...cfg, model };
}

/** Turn a recording into text with the provider's /audio/transcriptions endpoint. */
export async function transcribe(audio, contentType = 'audio/webm') {
  const cfg = requireVoice('stt');
  if (!audio?.length) throw new ChatError(400, 'empty_audio', 'Nothing was recorded. Try again and speak a little closer to the microphone.');
  const type = contentType.split(';')[0].trim();
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('file', new Blob([audio], { type }), `speech.${AUDIO_TYPES[type] || 'webm'}`);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, { method: 'POST', headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, body: form, signal: AbortSignal.timeout(90000) });
  } catch (err) {
    throw unreachable(err, cfg.baseUrl);
  }
  if (!res.ok) throw await providerError(res, cfg.baseUrl);
  const raw = await res.text().catch(() => '');
  let text;
  try {
    const j = JSON.parse(raw);
    text = typeof j === 'string' ? j : j.text;
  } catch {
    // some servers answer in plain text
    text = /^\s*</.test(raw) ? undefined : raw;
  }
  if (typeof text !== 'string') throw notAnApi(cfg.baseUrl, `transcribe: ${clip(raw, 300)}`);
  return { text: text.trim() };
}

/** Speak `text` with the provider's /audio/speech endpoint. Returns { audio, contentType }. */
export async function speak(text) {
  const cfg = requireVoice('tts');
  const input = String(text ?? '').trim().slice(0, 4000);
  if (!input) throw new ChatError(400, 'empty_text', 'There’s nothing to read aloud.');
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: providerHeaders(cfg.apiKey),
      body: JSON.stringify({ model: cfg.model, input, voice: cfg.ttsVoice || 'alloy', response_format: 'mp3' }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    throw unreachable(err, cfg.baseUrl);
  }
  if (!res.ok) throw await providerError(res, cfg.baseUrl);
  const type = res.headers.get('content-type') || 'audio/mpeg';
  if (!type.startsWith('audio/') && !type.includes('octet-stream')) throw notAnApi(cfg.baseUrl, `speech: ${type}`);
  return { audio: Buffer.from(await res.arrayBuffer()), contentType: type.startsWith('audio/') ? type : 'audio/mpeg' };
}
