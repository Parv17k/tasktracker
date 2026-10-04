// Installable-app plumbing: service worker, install prompt, and Web Push for deadline reminders.
import { useSyncExternalStore } from 'react';
import { navigate } from './router';
import { useBoard } from './store';

const swReady = 'serviceWorker' in navigator ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready) : Promise.resolve(null);

// ---------- install prompt ----------

let installEvent = null;
const installListeners = new Set();
const emitInstall = () => installListeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  emitInstall();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  emitInstall();
});

/** True when the browser offers to install the app (and it isn't installed yet). */
export function useCanInstall() {
  return useSyncExternalStore(
    (fn) => (installListeners.add(fn), () => installListeners.delete(fn)),
    () => !!installEvent
  );
}

export async function promptInstall() {
  if (!installEvent) return false;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  emitInstall();
  return outcome === 'accepted';
}

// ---------- opening a task from a notification ----------

/** Go to `/p/:project?task=:id` and open that task. */
export function openUrl(url) {
  const u = new URL(url, location.origin);
  const task = Number(u.searchParams.get('task')) || null;
  const s = useBoard.getState();
  const projectId = Number(/^\/p\/(\d+)/.exec(u.pathname)?.[1]) || null;
  if (task && projectId === s.projectId) s.select(task);
  else if (task) useBoard.setState({ pendingSelect: task });
  navigate(u.pathname);
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate') openUrl(e.data.url);
});

// ---------- notifications & push ----------

export const notificationsSupported = 'Notification' in window && 'serviceWorker' in navigator;

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** @returns {'unsupported'|'denied'|'off'|'on'} */
export async function pushState() {
  if (!notificationsSupported) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await swReady;
  const sub = await reg?.pushManager?.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Ask permission, subscribe this browser, and register it with the server. */
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await swReady;
  const { publicKey } = await (await fetch('/api/push/key')).json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  return 'on';
}

export async function disablePush() {
  const reg = await swReady;
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) {
    await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }
  return 'off';
}

/**
 * Reminders also arrive over the live-update stream. If this browser has no push subscription
 * (e.g. offline, or push unavailable) but notifications are allowed, show them from here.
 */
export async function showReminderFallback(payload) {
  if (!notificationsSupported || Notification.permission !== 'granted') return;
  const reg = await swReady;
  if (await reg?.pushManager?.getSubscription()) return; // push already delivered it
  reg?.showNotification(payload.title, { body: payload.body, tag: payload.tag, icon: '/icons/icon-192.png', data: { url: payload.url } });
}

/** Keep the browser/OS title bar colour in step with the active theme. */
export function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#f5efe3');
}
