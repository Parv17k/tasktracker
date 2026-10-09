// Task notes in Markdown: formatted by default, click to write, and ```mermaid blocks become
// diagrams. Rendering never injects raw HTML; Mermaid runs in strict mode and loads only when used.
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Maximize2, Pencil, X } from 'lucide-react';
import { useBoard } from '../store';
import { cx, IconButton } from './ui';

const DARK = ['midnight', 'espresso', 'graphite', 'terminal', 'grayscale-dark', 'cardinal', 'navy-gold', 'dracula', 'rose-pine', 'gruvbox', 'neon-orange'];

// ---------- mermaid (lazy) ----------

let mermaidReady = null;
let mermaidTheme = null;
async function loadMermaid(dark) {
  const theme = dark ? 'dark' : 'neutral';
  if (!mermaidReady) mermaidReady = import('mermaid').then((m) => m.default);
  const mermaid = await mermaidReady;
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' });
    mermaidTheme = theme;
  }
  return mermaid;
}

const Diagram = memo(function Diagram({ code }) {
  const theme = useBoard((s) => s.theme);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    loadMermaid(DARK.includes(theme))
      .then((m) => m.render(`mmd-${id}-${Date.now()}`, code))
      .then(({ svg }) => alive && (setSvg(svg), setError(null)))
      .catch((e) => alive && (setSvg(null), setError(String(e?.message || e).split('\n')[0])));
    return () => {
      alive = false;
    };
  }, [code, theme, id]);

  if (error) {
    return (
      <div className="my-2 rounded-lg border border-danger/30 bg-danger/6 p-3 text-[12.5px]">
        <div className="font-medium text-danger">This diagram couldn’t be drawn</div>
        <div className="mt-0.5 text-muted">{error}</div>
        <pre className="mt-2 overflow-x-auto font-mono text-[11.5px] text-muted">{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="my-2 h-24 animate-pulse rounded-lg bg-hover" />;
  // Mermaid's own output in strict mode (sanitised, no script)
  return <div className="my-2 flex justify-center overflow-x-auto rounded-lg bg-card p-3 [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
});

// ---------- markdown ----------

const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/;

/** Flip the n-th checklist item (0-based, in document order, ignoring code blocks). */
function toggleTask(text, n) {
  const lines = text.split('\n');
  let fence = null;
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence || !TASK_LINE.test(lines[i])) continue;
    if (++seen === n) {
      lines[i] = lines[i].replace(TASK_LINE, (_, pre, mark) => `${pre}[${mark === ' ' ? 'x' : ' '}]`);
      return lines.join('\n');
    }
  }
  return text;
}

export function MarkdownView({ text, onToggleTask, className }) {
  // checkboxes are numbered in render order, which matches their order in the text
  let box = 0;
  return (
    <div className={cx('md', className)}>
      <ReactMarkdown
        // single line breaks stay line breaks, so progress logs read one entry per line
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} />,
          code: ({ node, className: cls, children, ...props }) => {
            const lang = /language-(\w+)/.exec(cls || '')?.[1];
            if (lang === 'mermaid') return <Diagram code={String(children).replace(/\n$/, '')} />;
            return (
              <code className={cls} {...props}>
                {children}
              </code>
            );
          },
          // a fenced mermaid block shouldn't sit inside a <pre>
          pre: ({ node, children }) => {
            const child = node?.children?.[0];
            const isMermaid = child?.tagName === 'code' && /language-mermaid/.test((child.properties?.className || []).join(' '));
            return isMermaid ? <>{children}</> : <pre>{children}</pre>;
          },
          input: ({ node, checked, ...props }) => {
            if (props.type !== 'checkbox') return <input {...props} />;
            const n = box++;
            return (
              <input
                type="checkbox"
                checked={!!checked}
                disabled={!onToggleTask}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleTask?.(n)}
                className="mr-1.5 size-3.5 translate-y-[1px] accent-[var(--accent)]"
              />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ---------- editor ----------

function Editor({ value, onChange, onDone, autoFocus, className, minHeight = 120 }) {
  const ref = useRef(null);
  // Esc while writing finishes the note; it must not reach the panel, which also closes on Esc
  // (the panel listens in the capture phase, so this has to listen even earlier, on window)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.activeElement !== ref.current) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current.blur();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [value, minHeight]);
  useEffect(() => {
    if (autoFocus) {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck
      aria-label="Note (Markdown)"
      placeholder={'Write in Markdown: # headings, - lists, - [ ] checklists, **bold**, `code`, tables…\n\n```mermaid\nflowchart LR\n  Idea --> Plan --> Ship\n```'}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        // Tab indents instead of leaving the field
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: end } = el;
          const next = `${value.slice(0, s)}  ${value.slice(end)}`;
          onChange(next);
          requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
        }
      }}
      className={cx('block w-full resize-none bg-transparent font-mono text-[13px] leading-[1.65] text-fg outline-none placeholder:text-faint', className)}
    />
  );
}

/** Autosaving note: formatted until clicked, Markdown while writing, and an expanded writer. */
export function NoteField({ value, onSave }) {
  const [local, setLocal] = useState(value);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef();
  const writing = editing || expanded;

  useEffect(() => {
    if (!writing) setLocal(value);
  }, [value, writing]);

  const change = (v) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => v !== value && onSave(v), 600);
  };
  const flush = () => {
    clearTimeout(timer.current);
    if (local !== value) onSave(local);
  };
  const toggle = (n) => {
    const next = toggleTask(local, n);
    setLocal(next);
    onSave(next);
  };

  return (
    <>
      <div className="group/note relative rounded-lg border border-line bg-[var(--note)] shadow-card">
        <div className="absolute right-1.5 top-1.5 z-10 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/note:opacity-100">
          {!editing && local && (
            <IconButton size="sm" label="Edit note" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </IconButton>
          )}
          <IconButton size="sm" label="Expand" onClick={() => (flush(), setEditing(false), setExpanded(true))}>
            <Maximize2 className="size-3.5" />
          </IconButton>
        </div>
        {editing || !local ? (
          <div className="px-3 py-2.5">
            <Editor value={local} onChange={change} onDone={() => (flush(), setEditing(false))} autoFocus={editing} minHeight={editing ? 120 : 72} />
            {editing && <p className="mt-1.5 text-[11px] text-faint">Markdown · ```mermaid for diagrams · Esc to finish</p>}
          </div>
        ) : (
          // clicking the formatted note starts editing (links and checkboxes keep working)
          <div role="button" tabIndex={0} title="Click to edit" onClick={() => setEditing(true)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && setEditing(true)} className="cursor-text px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <MarkdownView text={local} onToggleTask={toggle} />
          </div>
        )}
      </div>
      {expanded && <ExpandedWriter value={local} onChange={change} onClose={() => (flush(), setExpanded(false))} onToggleTask={toggle} />}
    </>
  );
}

/** A roomy, distraction-free writer: Markdown on the left, the result on the right. */
function ExpandedWriter({ value, onChange, onClose, onToggleTask }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Note" className="anim-overlay fixed inset-0 z-[60] flex flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-line px-6 py-3">
        <span className="flex-1 text-[13px] font-medium text-muted">Note · Markdown with Mermaid diagrams</span>
        <span className="text-[11.5px] text-faint">Saves as you type · Esc to close</span>
        <IconButton label="Close (Esc)" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <div className="min-h-0 overflow-y-auto border-line px-8 py-6 md:border-r">
          <Editor value={value} onChange={onChange} autoFocus minHeight={400} onDone={() => {}} className="text-[14px]" />
        </div>
        <div className="hidden min-h-0 overflow-y-auto bg-[var(--note)] px-10 py-6 md:block">
          {value ? <MarkdownView text={value} onToggleTask={onToggleTask} className="text-[15px]" /> : <p className="text-[13px] text-faint">The formatted note appears here.</p>}
        </div>
      </div>
    </div>
  );
}
