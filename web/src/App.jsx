import { useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { subscribe } from './api';
import { useBoard } from './store';
import { Board } from './components/Board';
import { TopBar } from './components/TopBar';
import { TaskSheet } from './components/TaskSheet';
import { ArchiveSheet } from './components/ArchiveSheet';
import { TipProvider } from './components/ui';
import Home from './components/Home';
import { useProjectRoute } from './router';
import { showReminderFallback, syncThemeColor } from './pwa';

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

export default function App() {
  const loaded = useBoard((s) => s.loaded);
  const theme = useBoard((s) => s.theme);
  const project = useBoard((s) => s.project);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const searchRef = useRef(null);
  const routeProjectId = useProjectRoute();
  const onHome = routeProjectId == null;

  // the URL decides what is on screen; "?task=12" (from a reminder) opens that task
  useEffect(() => {
    const task = Number(new URLSearchParams(location.search).get('task'));
    if (task) {
      useBoard.setState({ pendingSelect: task });
      history.replaceState(null, '', location.pathname);
    }
    useBoard.getState().openProject(routeProjectId);
    setArchiveOpen(false);
  }, [routeProjectId]);

  useEffect(() => {
    if (project) document.title = `${project.name} · Task Tracker`;
  }, [project]);

  useEffect(() => {
    const { load } = useBoard.getState();
    let t;
    // debounce bursts of external changes (e.g. an agent doing several edits)
    syncThemeColor();
    return subscribe(
      () => {
        clearTimeout(t);
        t = setTimeout(load, 120);
      },
      (reminder) => showReminderFallback(reminder)
    );
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement)) return;
      const s = useBoard.getState();
      if (s.selectedId != null || archiveOpen || document.querySelector('[role=dialog]')) return;
      if (onHome) {
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          useBoard.setState({ newProjectOpen: true });
        }
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        const col = s.columns.find((c) => !c.hidden && !c.isDone) || s.columns.find((c) => !c.hidden);
        if (col) s.setQuickAdd(col.id);
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [archiveOpen, onHome]);

  const dark = ['midnight', 'espresso', 'graphite', 'terminal', 'grayscale-dark'].includes(theme);

  return (
    <TipProvider>
      {onHome ? (
        <Home />
      ) : (
        <>
          <div className="flex h-full flex-col">
            <TopBar ref={searchRef} onOpenArchive={() => setArchiveOpen(true)} />
            <main className="min-h-0 flex-1">{loaded ? <Board /> : <BoardSkeleton />}</main>
          </div>
          <TaskSheet />
          <ArchiveSheet open={archiveOpen} onOpenChange={setArchiveOpen} />
        </>
      )}
      <Toaster
        position="bottom-center"
        theme={dark ? 'dark' : 'light'}
        toastOptions={{ style: { background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', fontFamily: 'var(--font-body)' } }}
      />
    </TipProvider>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 px-6">
      {[5, 3, 2, 4].map((n, i) => (
        <div key={i} className="w-[300px] shrink-0 space-y-2 rounded-[calc(var(--radius)+6px)] bg-surface/70 p-3">
          <div className="h-4 w-24 animate-pulse rounded bg-hover" />
          {Array.from({ length: n }).map((_, j) => (
            <div key={j} className="h-16 animate-pulse rounded-[var(--radius)] bg-card/70" />
          ))}
        </div>
      ))}
    </div>
  );
}
