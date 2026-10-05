// Requests from AI agents (over MCP) waiting for the user. In "ask me first" mode an agent's
// changes land here instead of on the board; nothing happens until the user taps Apply.
import { useEffect, useState } from 'react';
import { AlertCircle, Bot, Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { setProposalListener, useBoard } from '../store';
import { Button, cx, IconButton, Sheet, Tip } from './ui';

const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const count = (n) => (n === 1 ? '1 change' : `${n} changes`);

export function AgentInboxButton() {
  const pending = useBoard((s) => s.proposals.length);
  const [open, setOpen] = useState(false);

  // announce requests that arrive while the app is open
  useEffect(() => {
    setProposalListener((p) =>
      toast(`${p.agent} wants to make ${count(p.items.filter((i) => i.ok).length)}`, {
        icon: <Bot className="size-4" />,
        action: { label: 'Review', onClick: () => setOpen(true) },
        duration: 8000,
      })
    );
    return () => setProposalListener(null);
  }, []);

  return (
    <>
      <Tip label={pending ? `${pending} agent request${pending === 1 ? '' : 's'} waiting` : 'Agent requests'}>
        <IconButton aria-label={pending ? `Agent requests: ${pending} waiting` : 'Agent requests'} onClick={() => setOpen(true)} className={cx('relative', pending > 0 && 'text-accent')}>
          <Bot className="size-4" />
          {pending > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">{pending}</span>
          )}
        </IconButton>
      </Tip>
      <AgentInbox open={open} onOpenChange={setOpen} />
    </>
  );
}

function AgentInbox({ open, onOpenChange }) {
  const proposals = useBoard((s) => s.proposals);
  const [approval, setApproval] = useState(null);
  const [recent, setRecent] = useState([]);
  const [showRecent, setShowRecent] = useState(false);

  useEffect(() => {
    if (!open) return;
    useBoard.getState().loadProposals();
    api.agentSettings().then((s) => setApproval(s.approval), () => {});
    api.proposals('recent').then(setRecent, () => {});
  }, [open, proposals.length]);

  const setMode = async (mode) => {
    setApproval(mode);
    try {
      await api.updateAgentSettings({ approval: mode });
      toast.success(mode === 'ask' ? 'Agents will ask before changing anything' : 'Agents’ changes will apply straight away');
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Agent requests" width={500}>
      <div className="space-y-5 p-5">
        <section className="rounded-xl border border-line bg-bg/40 p-3.5">
          <div className="text-[12.5px] font-medium text-fg">When agents change your board</div>
          <div className="mt-2 inline-flex rounded-lg border border-line bg-card p-0.5 text-[12.5px]" role="radiogroup" aria-label="When agents change your board">
            {[
              ['ask', 'Ask me first'],
              ['auto', 'Apply right away'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={approval === key}
                onClick={() => setMode(key)}
                className={cx('h-7 rounded-md px-3 transition-colors', approval === key ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
            {approval === 'auto'
              ? 'Agents connected over MCP (like Claude Code or Cursor) change the board directly. You’ll see their changes appear live.'
              : 'Agents connected over MCP (like Claude Code or Cursor) can read everything, but their changes wait here until you approve them.'}
          </p>
        </section>

        {proposals.length === 0 ? (
          <div className="py-8 text-center">
            <Bot className="mx-auto size-6 text-faint" />
            <p className="font-display mt-2 text-[17px] text-fg">Nothing waiting</p>
            <p className="mt-1 text-[12.5px] text-muted">When an agent wants to change your board, its request shows up here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {proposals.map((p) => (
              <RequestCard key={p.id} proposal={p} />
            ))}
          </div>
        )}

        {recent.length > 0 && (
          <section>
            <button type="button" onClick={() => setShowRecent((v) => !v)} aria-expanded={showRecent} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-fg">
              {showRecent ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Recent decisions
            </button>
            {showRecent && (
              <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                {recent.slice(0, 15).map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-3.5 py-2 text-[12.5px]">
                    {p.status === 'applied' ? <Check className="size-3.5 text-ok" /> : <X className="size-3.5 text-faint" />}
                    <span className="min-w-0 flex-1 truncate text-fg">
                      {p.agent}: {p.status === 'applied' ? count(p.result?.applied?.length || 0) + ' applied' : 'dismissed'}
                    </span>
                    <span className="text-faint">{ago(p.decidedAt || p.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}

/** One agent request: each change in plain words, with a checkbox. Nothing happens until Apply. */
function RequestCard({ proposal: p }) {
  const [selected, setSelected] = useState(() => p.items.map((i) => i.ok));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const possible = p.items.filter((i) => i.ok).length;
  const chosen = selected.filter(Boolean).length;

  const decide = async (approve) => {
    setBusy(approve ? 'apply' : 'dismiss');
    setError(null);
    try {
      const res = await useBoard.getState().decideProposal(p.id, approve, selected);
      if (approve) toast.success(`${count(res.result?.applied?.length || 0)} applied`);
    } catch (e) {
      setError(e.message);
      setBusy(null);
    }
  };

  return (
    <section aria-label={`Request from ${p.agent}`} className="overflow-hidden rounded-xl border border-accent/40 bg-card shadow-card">
      <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <Bot className="size-4 text-accent" />
        <span className="flex-1 text-[12.5px] font-medium text-fg">{p.agent} wants to make {count(possible)}</span>
        <span className="text-[11.5px] text-faint">{ago(p.createdAt)}</span>
      </header>
      <ul className="divide-y divide-line">
        {p.items.map((it, k) => (
          <li key={k} className="flex items-start gap-2.5 px-3.5 py-2.5 text-[12.5px]">
            {it.ok ? (
              <input
                type="checkbox"
                aria-label={`${it.verb} ${it.summary}`}
                checked={!!selected[k]}
                disabled={!!busy}
                onChange={() => setSelected((s) => s.map((v, n) => (n === k ? !v : v)))}
                className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
              />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-faint" />
            )}
            <span className={cx('min-w-0', !it.ok && 'text-faint')}>
              <span className={cx('font-medium', it.ok ? 'text-fg' : 'text-faint')}>{it.verb}</span> <span className={it.ok ? 'text-muted' : ''}>{it.summary}</span>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="border-t border-line bg-danger/6 px-3.5 py-2 text-[12.5px] text-danger">{error}</p>}
      <footer className="flex items-center justify-end gap-2 border-t border-line px-3.5 py-2.5">
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => decide(false)}>
          {busy === 'dismiss' ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} Dismiss
        </Button>
        <Button size="sm" variant="primary" disabled={!chosen || !!busy} onClick={() => decide(true)}>
          {busy === 'apply' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {chosen === possible ? (chosen === 1 ? 'Apply change' : `Apply ${chosen} changes`) : `Apply ${chosen} of ${possible}`}
        </Button>
      </footer>
    </section>
  );
}
