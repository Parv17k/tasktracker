import { Fragment, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { AlertCircle, ArrowLeft, ArrowUp, Check, KeyRound, Loader2, Mic, RotateCcw, Settings2, Sparkles, Square, Volume2, VolumeX, WandSparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { useBoard } from '../store';
import { canRecord, hasBrowserListening, listen, speak, speakable } from '../voice';
import { Button, cx, IconButton, Sheet, Tip } from './ui';

const PRESETS = [
  ['OpenAI', 'https://api.openai.com/v1'],
  ['OpenRouter', 'https://openrouter.ai/api/v1'],
  ['Groq', 'https://api.groq.com/openai/v1'],
  ['Ollama', 'http://localhost:11434/v1'],
  ['LM Studio', 'http://localhost:1234/v1'],
];

const SUGGESTIONS = {
  home: ['What should I focus on today?', 'What is due this week across my projects?', 'Which project needs the most attention?'],
  project: ['Summarize this project', 'What is overdue or due soon here?', 'What should I work on next?'],
};

// Errors from this app's own server already read as plain sentences. Anything else
// (the server is stopped, the network dropped) gets a plain sentence here.
const OFFLINE = 'Task Tracker’s server isn’t responding. Make sure it’s still running (npm start), then try again.';

async function request(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error(OFFLINE), { kind: 'offline' });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(data?.error || OFFLINE), { kind: data?.kind || (data ? undefined : 'offline') });
  return data;
}

/** The changes block the assistant appends to a reply (the server's ACTIONS_FENCE). */
const FENCE = '```tasktracker-actions';

/** Splits a reply into visible text and proposed actions. While streaming, an unfinished block is hidden. */
function splitReply(content) {
  const at = content.indexOf(FENCE);
  if (at < 0) return { text: content, actions: null, pending: false };
  const text = content.slice(0, at).trimEnd();
  const rest = content.slice(at + FENCE.length);
  const end = rest.indexOf('```');
  if (end < 0) return { text, actions: null, pending: true };
  try {
    const parsed = JSON.parse(rest.slice(0, end));
    const actions = Array.isArray(parsed) ? parsed : [parsed];
    return { text, actions: actions.length ? actions : null, pending: false, unreadable: false };
  } catch {
    return { text, actions: null, pending: false, unreadable: true };
  }
}

// conversation lives outside the board store so it survives moving between pages
export const useChat = create((set, get) => ({
  open: false,
  // { role: 'user' | 'assistant', content, error?: { message, kind }, proposal?: { status, items?, error?, applied? } }
  messages: [],
  streaming: false,
  controller: null,
  // voice: provider models from settings (empty = the browser's own speech), and live state
  voiceSettings: { sttModel: '', ttsModel: '' },
  readAloud: localStorage.getItem('tt-read-aloud') === '1',
  listening: false,
  speaking: false,
  level: 0,
  interim: '',
  voiceCtl: null,

  async send(text, { voice = false } = {}) {
    get().stopVoice();
    // failed turns are left out of what the model sees; a decision on proposed changes is passed on
    const history = [...get().messages.filter((m) => !m.error), { role: 'user', content: text }];
    const controller = new AbortController();
    set({ messages: [...history, { role: 'assistant', content: '' }], streaming: true, controller });
    const patchLast = (fn) => set((s) => ({ messages: [...s.messages.slice(0, -1), fn(s.messages.at(-1))] }));
    try {
      let res;
      try {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: toProvider(history), projectId: useBoard.getState().projectId }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw Object.assign(new Error(OFFLINE), { kind: 'offline' });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw Object.assign(new Error(data?.error || OFFLINE), { kind: data?.kind || 'offline' });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        patchLast((m) => ({ ...m, content: m.content + chunk }));
      }
      const last = get().messages.at(-1);
      if (!last.content.trim()) patchLast((m) => ({ ...m, error: { message: 'Your AI provider sent back an empty answer. Try asking again, or choose a different model in settings.', kind: 'empty' } }));
      else get().review(get().messages.length - 1);
    } catch (err) {
      if (err.name === 'AbortError') patchLast((m) => (m.content ? m : { ...m, error: { message: 'Stopped.', kind: 'stopped' } }));
      else if (get().messages.at(-1).content) patchLast((m) => ({ ...m, content: `${m.content}\n\n⚠️ ${err.message}` }));
      else patchLast((m) => ({ ...m, error: { message: err.message, kind: err.kind } }));
    } finally {
      set({ streaming: false, controller: null });
    }
    await get().readReply(voice);
  },

  // ---------- voice ----------

  setReadAloud(on) {
    localStorage.setItem('tt-read-aloud', on ? '1' : '0');
    if (!on) get().stopVoice();
    set({ readAloud: on });
  },

  /** Tap the mic: listen for one message and send it. Tap again to stop. */
  async toggleListening() {
    if (get().listening) return get().stopVoice();
    get().stopVoice();
    const ctl = new AbortController();
    set({ listening: true, interim: '', level: 0, voiceCtl: ctl });
    try {
      const text = await listen({
        useProvider: !!get().voiceSettings.sttModel,
        signal: ctl.signal,
        onLevel: (level) => set({ level }),
        onInterim: (interim) => set({ interim }),
      });
      set({ listening: false, interim: '', voiceCtl: null });
      await get().send(text, { voice: true });
    } catch (err) {
      set({ listening: false, interim: '', level: 0, voiceCtl: null });
      if (err.kind !== 'stopped') toast.error(err.message);
    }
  },

  stopVoice() {
    get().voiceCtl?.abort();
    set({ listening: false, speaking: false, interim: '', level: 0, voiceCtl: null });
  },

  /**
   * Read the latest answer aloud (when that's on). After a spoken question the mic opens
   * again, so a conversation can be hands-free; proposed changes pause it for review.
   */
  async readReply(spokenQuestion) {
    const last = get().messages.at(-1);
    if (!get().readAloud || !last || last.role !== 'assistant' || last.error || !last.content.trim()) return;
    const { text, actions } = splitReply(last.content);
    let say = speakable(text);
    if (actions?.length) say += ` I’ve suggested ${actions.length === 1 ? 'one change' : `${actions.length} changes`}. Review them, then tap Apply.`;
    const ctl = new AbortController();
    set({ speaking: true, voiceCtl: ctl });
    try {
      await speak(say, { useProvider: !!get().voiceSettings.ttsModel, signal: ctl.signal });
    } catch (err) {
      set({ speaking: false, voiceCtl: null });
      return toast.error(err.message);
    }
    if (ctl.signal.aborted) return;
    set({ speaking: false, voiceCtl: null });
    if (spokenQuestion && !actions?.length && get().open) get().toggleListening();
  },

  /** Ask the server to check and describe the changes proposed in message `i`. */
  async review(i) {
    const { actions, unreadable } = splitReply(get().messages[i].content);
    const patch = (proposal) => set((s) => ({ messages: s.messages.map((m, j) => (j === i ? { ...m, proposal: { ...m.proposal, ...proposal } } : m)) }));
    if (unreadable) return patch({ status: 'unreadable', actions: null });
    if (!actions) return;
    patch({ status: 'checking', actions });
    try {
      const { items } = await request('POST', '/api/chat/actions/preview', { actions });
      patch({ status: 'pending', items, selected: items.map((it) => it.ok) });
    } catch (err) {
      patch({ status: 'invalid', error: err.message });
    }
  },

  toggle(i, k) {
    set((s) => ({ messages: s.messages.map((m, j) => (j === i ? { ...m, proposal: { ...m.proposal, selected: m.proposal.selected.map((v, n) => (n === k ? !v : v)) } } : m)) }));
  },

  async decide(i, approve) {
    const m = get().messages[i];
    const p = m.proposal;
    const patch = (proposal) => set((s) => ({ messages: s.messages.map((x, j) => (j === i ? { ...x, proposal: { ...x.proposal, ...proposal } } : x)) }));
    if (!approve) return patch({ status: 'dismissed' });
    const chosen = p.actions.filter((_, k) => p.selected[k]);
    if (!chosen.length) return patch({ status: 'dismissed' });
    patch({ status: 'applying', error: null });
    try {
      const { applied } = await request('POST', '/api/chat/actions/apply', { actions: chosen });
      patch({ status: 'applied', applied });
      toast.success(applied.length === 1 ? 'Change applied' : `${applied.length} changes applied`);
      // refresh what's on screen (the live-update stream also does this, but not for the same tab)
      const b = useBoard.getState();
      if (b.projectId != null) b.load();
      else b.loadHome?.();
    } catch (err) {
      patch({ status: 'pending', error: err.message });
    }
  },

  stop: () => get().controller?.abort(),
  clear: () => (get().controller?.abort(), get().stopVoice(), set({ messages: [] })),
}));

/** What the model sees: plain text, plus a note on what happened to changes it proposed. */
function toProvider(messages) {
  return messages.map((m) => {
    const p = m.proposal;
    if (m.role !== 'assistant' || !p) return { role: m.role, content: m.content };
    const outcome =
      p.status === 'applied'
        ? `[Changes applied: ${p.applied.map((a) => `${a.verb} ${a.summary}`).join('; ')}]`
        : p.status === 'dismissed'
          ? '[The user dismissed these changes. Nothing was changed.]'
          : '[These changes were not applied.]';
    return { role: 'assistant', content: `${m.content}\n\n${outcome}` };
  });
}

export function ChatButton() {
  return (
    <Tip label="Ask about your tasks">
      <IconButton aria-label="Ask about your tasks" onClick={() => useChat.setState({ open: true })}>
        <Sparkles className="size-4" />
      </IconButton>
    </Tip>
  );
}

export function ChatSheet() {
  const open = useChat((s) => s.open);
  const hasMessages = useChat((s) => s.messages.length > 0);
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!open) return;
    request('GET', '/api/settings/llm')
      .then(setSettings)
      .catch((e) => toast.error(e.message));
  }, [open]);

  // voice uses the provider's audio models when they're set
  useEffect(() => {
    if (settings) useChat.setState({ voiceSettings: { sttModel: settings.sttModel || '', ttsModel: settings.ttsModel || '' } });
  }, [settings]);
  useEffect(() => {
    if (!open) useChat.getState().stopVoice();
  }, [open]);

  const setup = settings && (!settings.configured || editing);
  const host = (() => {
    try {
      return new URL(settings.baseUrl).host;
    } catch {
      return '';
    }
  })();

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => useChat.setState({ open: v })}
      width={480}
      title={setup ? 'Chat provider' : 'Ask about your tasks'}
      header={
        settings?.configured && (
          <>
            {!setup && <ReadAloudToggle />}
            {hasMessages && !setup && <IconButton label="New conversation" onClick={() => useChat.getState().clear()}><RotateCcw className="size-4" /></IconButton>}
            {setup ? (
              <IconButton label="Back to chat" onClick={() => setEditing(false)}>
                <ArrowLeft className="size-4" />
              </IconButton>
            ) : (
              <IconButton label="Provider settings" onClick={() => setEditing(true)}>
                <Settings2 className="size-4" />
              </IconButton>
            )}
          </>
        )
      }
    >
      {!settings ? (
        <div className="flex h-full items-center justify-center text-faint">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : setup ? (
        <ProviderForm
          settings={settings}
          onChange={setSettings}
          onSaved={(s) => {
            setSettings(s);
            if (s.configured) setEditing(false);
          }}
          onBack={settings.configured ? () => setEditing(false) : null}
        />
      ) : (
        <Conversation model={settings.model} host={host} onSettings={() => setEditing(true)} />
      )}
    </Sheet>
  );
}

// ---------- conversation ----------

function Conversation({ model, host, onSettings }) {
  const messages = useChat((s) => s.messages);
  const streaming = useChat((s) => s.streaming);
  const onProject = useBoard((s) => s.projectId != null);
  const scroller = useRef(null);
  const stick = useRef(true);

  // follow the reply as it streams, unless the user scrolled up to read
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="flex h-full flex-col">
      <div ref={scroller} onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)} className="flex-1 overflow-y-auto px-5 py-5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-2 pb-2">
            <p className="mb-2 text-[13px] text-muted">Ask anything about your projects and tasks.</p>
            {SUGGESTIONS[onProject ? 'project' : 'home'].map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => useChat.getState().send(q)}
                className="rounded-xl border border-line bg-bg/40 px-3.5 py-2.5 text-left text-[13px] text-fg transition hover:border-line-strong hover:bg-hover"
              >
                {q}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="ml-10 whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2.5 text-[13.5px] leading-relaxed text-fg">
                  {m.content}
                </div>
              ) : m.error ? (
                <ErrorNotice key={i} error={m.error} onSettings={onSettings} />
              ) : (
                <AssistantMessage key={i} index={i} message={m} streaming={streaming && i === messages.length - 1} />
              )
            )}
          </div>
        )}
      </div>
      <Composer streaming={streaming} />
      <p className="px-5 pb-3 text-center text-[11px] text-faint">
        {model} via {host} · your tasks are shared with it when you ask · changes need your OK
      </p>
    </div>
  );
}

const ERROR_TITLES = {
  setup: 'Set up an AI provider',
  auth: 'API key not accepted',
  not_found: 'Model not found',
  bad_url: 'Check the base URL',
  rate_limit: 'Provider is busy',
  too_long: 'Conversation too long',
  down: 'AI provider is unavailable',
  timeout: 'No answer in time',
  unreachable: 'Can’t reach the AI provider',
  offline: 'Task Tracker isn’t responding',
  empty: 'Empty answer',
  no_voice: 'Voice isn’t set up',
};
const FIX_IN_SETTINGS = ['setup', 'auth', 'not_found', 'bad_url', 'no_voice'];

/** A failed reply: a plain title, a plain explanation, and the obvious next step. */
function ErrorNotice({ error, onSettings }) {
  if (error.kind === 'stopped') return <p className="text-[12.5px] italic text-faint">Stopped.</p>;
  const retry = () => {
    const s = useChat.getState();
    const msgs = s.messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // drop the failed turn and ask the same question again
    useChat.setState({ messages: msgs.slice(0, msgs.lastIndexOf(lastUser)) });
    s.send(lastUser.content);
  };
  return (
    <div role="alert" className="rounded-xl border border-danger/25 bg-danger/6 px-3.5 py-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-danger">
        <AlertCircle className="size-4 shrink-0" /> {ERROR_TITLES[error.kind] || 'Something went wrong'}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-fg">{error.message}</p>
      <div className="mt-2.5 flex gap-2">
        {FIX_IN_SETTINGS.includes(error.kind) ? (
          <Button size="sm" variant="outline" onClick={onSettings}>
            <Settings2 className="size-3.5" /> Open settings
          </Button>
        ) : (
          <>
            {error.kind !== 'too_long' && (
              <Button size="sm" variant="outline" onClick={retry}>
                <RotateCcw className="size-3.5" /> Try again
              </Button>
            )}
            {error.kind === 'too_long' && (
              <Button size="sm" variant="outline" onClick={() => useChat.getState().clear()}>
                New conversation
              </Button>
            )}
            {error.kind !== 'offline' && (
              <Button size="sm" variant="ghost" onClick={onSettings}>
                Settings
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ index, message, streaming }) {
  const { text, pending } = splitReply(message.content);
  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed text-fg">
      {text ? <Markdown text={text} /> : !pending && <Loader2 className="size-4 animate-spin text-faint" />}
      {streaming && pending && (
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 className="size-3.5 animate-spin" /> Preparing changes for your approval…
        </p>
      )}
      {message.proposal && <Proposal index={index} proposal={message.proposal} />}
    </div>
  );
}

/** Proposed changes: nothing happens until the user approves. */
function Proposal({ index, proposal: p }) {
  const { toggle, decide } = useChat.getState();
  if (p.status === 'unreadable') {
    return <p className="rounded-xl border border-line bg-bg/40 px-3.5 py-2.5 text-[12.5px] text-muted">The assistant suggested changes, but they couldn’t be read. Ask it to try again.</p>;
  }
  if (p.status === 'checking') {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-muted">
        <Loader2 className="size-3.5 animate-spin" /> Checking the suggested changes…
      </p>
    );
  }
  if (p.status === 'invalid') return <p className="rounded-xl border border-line bg-bg/40 px-3.5 py-2.5 text-[12.5px] text-muted">{p.error}</p>;

  const count = p.selected?.filter(Boolean).length || 0;
  const settled = p.status === 'applied' || p.status === 'dismissed';
  const rows = p.status === 'applied' ? p.applied.map((a) => ({ ...a, ok: true })) : p.items;
  const possible = p.items?.filter((it) => it.ok).length || 0;

  return (
    <section aria-label="Proposed changes" className={cx('overflow-hidden rounded-xl border bg-card shadow-card', settled ? 'border-line' : 'border-accent/40')}>
      <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <WandSparkles className="size-4 text-accent" />
        <span className="flex-1 text-[12.5px] font-medium text-fg">
          {p.status === 'applied' ? 'Applied' : p.status === 'dismissed' ? 'Dismissed. Nothing was changed' : 'Suggested changes · nothing changes until you approve'}
        </span>
      </header>
      <ul className="divide-y divide-line">
        {rows.map((it, k) => (
          <li key={k} className={cx('flex items-start gap-2.5 px-3.5 py-2.5 text-[12.5px]', p.status === 'dismissed' && 'opacity-50')}>
            {p.status === 'applied' ? (
              <Check className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : !it.ok ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-faint" />
            ) : (
              <input
                type="checkbox"
                aria-label={`${it.verb} ${it.summary}`}
                checked={!!p.selected[k]}
                disabled={settled || p.status === 'applying'}
                onChange={() => toggle(index, k)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
              />
            )}
            <span className={cx('min-w-0', !it.ok && 'text-faint')}>
              <span className={cx('font-medium', it.ok ? 'text-fg' : 'text-faint')}>{it.verb}</span> <span className={it.ok ? 'text-muted' : ''}>{it.summary}</span>
            </span>
          </li>
        ))}
      </ul>
      {p.error && <p className="border-t border-line bg-danger/6 px-3.5 py-2 text-[12.5px] text-danger">{p.error}</p>}
      {!settled && (
        <footer className="flex items-center justify-end gap-2 border-t border-line px-3.5 py-2.5">
          <Button size="sm" variant="ghost" disabled={p.status === 'applying'} onClick={() => decide(index, false)}>
            <X className="size-3.5" /> Dismiss
          </Button>
          <Button size="sm" variant="primary" disabled={!count || p.status === 'applying'} onClick={() => decide(index, true)}>
            {p.status === 'applying' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {count === possible ? (count === 1 ? 'Apply change' : `Apply ${count} changes`) : `Apply ${count} of ${possible}`}
          </Button>
        </footer>
      )}
    </section>
  );
}

function ReadAloudToggle() {
  const on = useChat((s) => s.readAloud);
  const speaking = useChat((s) => s.speaking);
  const Icon = on ? Volume2 : VolumeX;
  return (
    <IconButton
      label={speaking ? 'Stop reading' : on ? 'Read answers aloud: on' : 'Read answers aloud: off'}
      aria-pressed={on}
      onClick={() => (speaking ? useChat.getState().stopVoice() : useChat.getState().setReadAloud(!on))}
      className={cx(on && 'text-accent', speaking && 'animate-pulse')}
    >
      <Icon className="size-4" />
    </IconButton>
  );
}

const voiceInput = canRecord || hasBrowserListening;

/** Mic button: tap to speak, tap again to stop. The ring follows your voice level. */
function MicButton({ disabled }) {
  const listening = useChat((s) => s.listening);
  const level = useChat((s) => s.level);
  if (!voiceInput) return null;
  return (
    <IconButton
      label={listening ? 'Stop listening' : 'Speak (voice)'}
      aria-pressed={listening}
      disabled={disabled}
      onClick={() => useChat.getState().toggleListening()}
      className={cx('relative', listening ? 'bg-danger/12 text-danger hover:bg-danger/20 hover:text-danger' : '')}
    >
      {listening && <span aria-hidden className="absolute inset-0 rounded-[inherit] ring-2 ring-danger/50 transition-transform" style={{ transform: `scale(${1 + Math.min(level * 4, 0.45)})` }} />}
      {listening ? <Square className="size-3 fill-current" /> : <Mic className="size-4" />}
    </IconButton>
  );
}

function Composer({ streaming }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const listening = useChat((s) => s.listening);
  const interim = useChat((s) => s.interim);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const t = text.trim();
    if (!t || streaming) return;
    setText('');
    useChat.getState().send(t);
  };

  return (
    <div className="px-4 pb-2 pt-1">
      <div className="flex items-end gap-2 rounded-2xl border border-line bg-bg/40 p-2 pl-3.5 focus-within:border-accent">
        <textarea
          ref={ref}
          rows={1}
          value={listening ? interim : text}
          readOnly={listening}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={listening ? 'Listening… speak now' : voiceInput ? 'Ask about your tasks, or tap the mic…' : 'Ask about your tasks…'}
          aria-label="Message"
          className="max-h-40 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[13.5px] text-fg outline-none [field-sizing:content] placeholder:text-faint"
        />
        <MicButton disabled={streaming} />
        {streaming ? (
          <IconButton label="Stop" onClick={() => useChat.getState().stop()} className="bg-hover text-fg">
            <Square className="size-3.5 fill-current" />
          </IconButton>
        ) : (
          <IconButton label="Send (Enter)" onClick={submit} disabled={!text.trim() || listening} className="bg-accent text-accent-fg hover:bg-accent hover:text-accent-fg hover:brightness-110">
            <ArrowUp className="size-4" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

// ---------- provider setup ----------

function ProviderForm({ settings, onChange, onSaved, onBack }) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.model);
  const [sttModel, setSttModel] = useState(settings.sttModel || '');
  const [ttsModel, setTtsModel] = useState(settings.ttsModel || '');
  const [ttsVoice, setTtsVoice] = useState(settings.ttsVoice || '');
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(null); // 'models' | 'save'

  const saveConnection = async () => request('PATCH', '/api/settings/llm', { baseUrl, ...(apiKey ? { apiKey } : {}) });

  const loadModels = async () => {
    setBusy('models');
    try {
      await saveConnection();
      const { models } = await request('GET', '/api/chat/models');
      setModels(models);
      if (!models.length) toast('Connected, but the provider listed no models. Type the model name instead.');
      else toast.success(`Connected · ${models.length} models available`);
      if (!model && models.length) setModel(models[0]);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy('save');
    try {
      const s = await request('PATCH', '/api/settings/llm', { baseUrl, model, sttModel, ttsModel, ttsVoice, ...(apiKey ? { apiKey } : {}) });
      setApiKey('');
      onSaved(s);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async () => {
    try {
      onChange(await request('PATCH', '/api/settings/llm', { apiKey: '' }));
      toast.success('Saved key removed');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5 p-5">
      <p className="text-[13px] leading-relaxed text-muted">Connect any OpenAI-compatible provider, in the cloud or running on this computer.</p>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(([name, url]) => (
          <button
            key={name}
            type="button"
            onClick={() => setBaseUrl(url)}
            className={cx('h-7 rounded-full border px-3 text-[12px] transition', baseUrl === url ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted hover:bg-hover hover:text-fg')}
          >
            {name}
          </button>
        ))}
      </div>

      <Field label="Base URL" hint="The address that ends before /chat/completions">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" required className={inputCls} />
      </Field>

      <Field label="API key" hint={settings.hasKey ? 'Leave blank to keep the saved key. Local servers usually need none.' : 'Local servers like Ollama usually need none.'}>
        <div className="relative">
          <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.hasKey ? `Saved (${settings.keyHint})` : 'sk-…'}
            className={cx(inputCls, 'pl-8')}
          />
        </div>
        {settings.hasKey && (
          <button type="button" onClick={removeKey} className="mt-1.5 text-[12px] text-faint hover:text-danger">
            Remove saved key
          </button>
        )}
      </Field>

      <Field label="Model">
        <div className="flex gap-2">
          <input list="tt-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model name" required className={cx(inputCls, 'flex-1')} />
          <datalist id="tt-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Button variant="outline" disabled={!baseUrl || busy} onClick={loadModels} className="h-9">
            {busy === 'models' ? <Loader2 className="size-3.5 animate-spin" /> : 'Load models'}
          </Button>
        </div>
      </Field>

      <fieldset className="space-y-3 rounded-xl border border-line p-3.5">
        <legend className="px-1 text-[12px] font-medium text-muted">Voice (optional)</legend>
        <p className="text-[11.5px] leading-relaxed text-faint">
          Leave these empty to use your browser’s built-in speech. Note that some browsers (like Chrome) send what you say to their own speech service; a model on your provider, or a local one, keeps it between you and that provider.
        </p>
        <Field label="Speech-to-text model" hint="e.g. whisper-1. Turns what you say into a message.">
          <input list="tt-models" value={sttModel} onChange={(e) => setSttModel(e.target.value)} placeholder="Browser speech recognition" className={inputCls} />
        </Field>
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Field label="Voice model" hint="e.g. tts-1. Reads answers aloud.">
            <input list="tt-models" value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} placeholder="Browser voice" className={inputCls} />
          </Field>
          <Field label="Voice">
            <input value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} placeholder="alloy" disabled={!ttsModel} className={cx(inputCls, 'disabled:opacity-50')} />
          </Field>
        </div>
      </fieldset>

      <div className="flex items-center justify-end gap-2 pt-1">
        {onBack && (
          <Button variant="ghost" size="lg" onClick={onBack}>
            <ArrowLeft className="size-4" /> Back to chat
          </Button>
        )}
        <Button type="submit" variant="primary" size="lg" disabled={!baseUrl || !model || busy}>
          {busy === 'save' && <Loader2 className="size-4 animate-spin" />} Save & chat
        </Button>
      </div>

      <p className="border-t border-line pt-4 text-[11.5px] leading-relaxed text-faint">
        Your key is stored only in the local database on this computer and is sent only to this provider. When you ask a question, a summary of your projects and tasks is sent along with it.
      </p>
    </form>
  );
}

const inputCls = 'h-9 w-full rounded-lg border border-line bg-bg/40 px-3 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}

// ---------- minimal, safe Markdown (no HTML injection: everything renders as React text) ----------

function Markdown({ text }) {
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      blocks.push(
        <pre key={blocks.length} className="overflow-x-auto rounded-lg bg-hover px-3 py-2 font-mono text-[12px]">
          {code.join('\n')}
        </pre>
      );
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(
        <p key={blocks.length} className="font-semibold text-fg">
          <Inline text={line.replace(/^#+\s/, '')} />
        </p>
      );
      i++;
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) {
        items.push({ depth: lines[i].match(/^\s*/)[0].length >= 2, text: lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '') });
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={blocks.length} className={cx('space-y-1 pl-5', ordered ? 'list-decimal' : 'list-disc', 'marker:text-faint')}>
          {items.map((it, j) => (
            <li key={j} className={cx(it.depth && 'ml-4')}>
              <Inline text={it.text} />
            </li>
          ))}
        </List>
      );
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*•]|\d+[.)])\s+)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(
        <p key={blocks.length}>
          {para.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              <Inline text={l} />
            </Fragment>
          ))}
        </p>
      );
    }
  }
  return <div className="space-y-3">{blocks}</div>;
}

function Inline({ text }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
      <code key={i} className="rounded bg-hover px-1 py-0.5 font-mono text-[12px]">
        {p.slice(1, -1)}
      </code>
    ) : p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
      <strong key={i} className="font-semibold">
        {p.slice(2, -2)}
      </strong>
    ) : p.startsWith('*') && p.endsWith('*') && p.length > 2 ? (
      <em key={i}>{p.slice(1, -1)}</em>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    )
  );
}
