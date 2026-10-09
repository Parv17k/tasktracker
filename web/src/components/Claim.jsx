// "An agent is working on this card": a quiet marker, never a lock. It expires on its own.
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { useBoard } from '../store';
import { Button, cx, useNow } from './ui';

const since = (iso, now) => {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** The claim if it's still active (claims can run out while the page sits open). */
export function useActiveClaim(claim) {
  const now = useNow(30000, !!claim);
  return claim && Date.parse(claim.expiresAt) > now ? { ...claim, age: since(claim.claimedAt, now) } : null;
}

export function ClaimChip({ claim }) {
  const c = useActiveClaim(claim);
  if (!c) return null;
  return (
    <span title={`${c.agent} is working on this${c.note ? `: ${c.note}` : ''}`} className="inline-flex h-[18px] max-w-full items-center gap-1 rounded-full bg-accent-soft px-1.5 text-[10.5px] font-medium text-fg">
      <Bot className="size-3 shrink-0 text-accent" />
      <span className="truncate">{c.agent}</span>
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
    </span>
  );
}

export function ClaimBanner({ task }) {
  const c = useActiveClaim(task.claim);
  if (!c) return null;
  const release = async () => {
    try {
      await api.releaseClaim(task.id);
      useBoard.getState().load();
      toast.success('Released. Other agents won’t be warned about this card any more.');
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className={cx('mx-6 mt-4 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/60 px-3.5 py-2.5')}>
      <Bot className="size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        <div className="font-medium text-fg">
          {c.agent} is working on this · {c.age}
        </div>
        <div className="text-muted">{c.note || 'You can still edit it. The marker clears itself when the agent finishes or goes quiet.'}</div>
      </div>
      <Button size="sm" variant="ghost" onClick={release}>
        Release
      </Button>
    </div>
  );
}
