import { Fragment, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ArrowLeft, ArrowUp, KeyRound, Loader2, RotateCcw, Settings2, Sparkles, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useBoard } from '../store';
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

const request = (method, url, body) =>
  fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
    return data;
  });

// conversation lives outside the board store so it survives moving between pages
export const useChat = create((set, get) => ({
  open: false,
  messages: [], // { role: 'user' | 'assistant', content, error? }
  streaming: false,
  controller: null,

  async send(text) {
    const history = [...get().messages.filter((m) => !m.error), { role: 'user', content: text }];
    const controller = new AbortController();
    set({ messages: [...history, { role: 'assistant', content: '' }], streaming: true, controller });
    const patchLast = (fn) => set((s) => ({ messages: [...s.messages.slice(0, -1), fn(s.messages.at(-1))] }));
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, projectId: useBoard.getState().projectId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        patchLast((m) => ({ ...m, content: m.content + text }));
      }
      patchLast((m) => (m.content ? m : { ...m, content: 'The model returned an empty reply.', error: true }));
    } catch (err) {
      if (err.name === 'AbortError') patchLast((m) => (m.content ? m : { ...m, content: 'Stopped.', error: true }));
      else patchLast((m) => ({ ...m, content: m.content ? `${m.content}\n\n⚠️ ${err.message}` : err.message, error: !m.content }));
    } finally {
      set({ streaming: false, controller: null });
    }
  },

  stop: () => get().controller?.abort(),
  clear: () => (get().controller?.abort(), set({ messages: [] })),
}));

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
        <Conversation model={settings.model} host={host} />
      )}
    </Sheet>
  );
}

// ---------- conversation ----------

function Conversation({ model, host }) {
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
                <p key={i} className="rounded-xl border border-danger/30 bg-danger/8 px-3.5 py-2.5 text-[13px] text-danger">
                  {m.content}
                </p>
              ) : (
                <div key={i} className="text-[13.5px] leading-relaxed text-fg">
                  {m.content ? <Markdown text={m.content} /> : <Loader2 className="size-4 animate-spin text-faint" />}
                </div>
              )
            )}
          </div>
        )}
      </div>
      <Composer streaming={streaming} />
      <p className="px-5 pb-3 text-center text-[11px] text-faint">
        {model} via {host} · your tasks are shared with it when you ask · read-only
      </p>
    </div>
  );
}

function Composer({ streaming }) {
  const [text, setText] = useState('');
  const ref = useRef(null);

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
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about your tasks…"
          aria-label="Message"
          className="max-h-40 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[13.5px] text-fg outline-none [field-sizing:content] placeholder:text-faint"
        />
        {streaming ? (
          <IconButton label="Stop" onClick={() => useChat.getState().stop()} className="bg-hover text-fg">
            <Square className="size-3.5 fill-current" />
          </IconButton>
        ) : (
          <IconButton label="Send (Enter)" onClick={submit} disabled={!text.trim()} className="bg-accent text-accent-fg hover:bg-accent hover:text-accent-fg hover:brightness-110">
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
      const s = await request('PATCH', '/api/settings/llm', { baseUrl, model, ...(apiKey ? { apiKey } : {}) });
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
