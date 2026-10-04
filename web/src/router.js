// Minimal client-side routing: "/" is the home page, "/p/:id" is a project board.
import { useSyncExternalStore } from 'react';

const listeners = new Set();

function subscribe(fn) {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', fn);
  };
}

export function navigate(path) {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  listeners.forEach((fn) => fn());
}

export const projectPath = (id) => `/p/${id}`;

/** @returns {number|null} the project id in the URL, or null on the home page */
export function useProjectRoute() {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  const m = /^\/p\/(\d+)/.exec(path);
  return m ? Number(m[1]) : null;
}
