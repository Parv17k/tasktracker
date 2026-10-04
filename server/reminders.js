// Deadline reminders: decides which notifications are due, then delivers them via
// Web Push (works with the app closed) and an SSE event (for open tabs without push).
import webpush from 'web-push';
import * as store from './db.js';

const HOUR = 3600000;
// a reminder that was missed (server off, laptop asleep) is still sent within this window, then dropped
const GRACE = 12 * HOUR;

/** Local Date for 'YYYY-MM-DD' at 'HH:MM', shifted by `dayOffset` days. */
function atLocal(dateStr, hhmm, dayOffset = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d + dayOffset, hh, mm);
}

const localDateOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** When each enabled reminder for a task should fire. */
export function reminderTimes(task, settings) {
  const timed = !!task.due_has_time;
  const due = timed ? new Date(task.due_at) : null;
  const day = timed ? localDateOf(due) : task.due_at;
  const out = [];
  if (settings.dayBefore) out.push({ kind: 'dayBefore', at: atLocal(day, settings.morningTime, -1) });
  if (settings.morningOf) {
    const morning = atLocal(day, settings.morningTime);
    if (!timed || morning < due) out.push({ kind: 'morningOf', at: morning });
  }
  if (settings.hourBefore && timed) out.push({ kind: 'hourBefore', at: new Date(due - settings.leadMinutes * 60000) });
  // a whole-day task becomes overdue at midnight; tell the user at their morning time instead
  if (settings.overdue) out.push({ kind: 'overdue', at: timed ? due : atLocal(day, settings.morningTime, 1) });
  return out;
}

/** Reminders that should go out at `now` (not yet de-duplicated against the sent log). */
export function dueReminders(tasks, settings, now = new Date()) {
  if (!settings.enabled) return [];
  const out = [];
  for (const t of tasks) {
    const created = new Date(t.created_at);
    for (const r of reminderTimes(t, settings)) {
      // only inside the grace window, and never for moments that passed before the task existed
      if (r.at <= now && now - r.at < GRACE && r.at >= created) out.push({ task: t, ...r });
    }
  }
  return out;
}

/** "25 min", "1 hour", "3 hours" — the real time left, not the configured lead. */
function timeLeft(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`;
}

export function message({ task, kind }, now = new Date()) {
  const time = task.due_has_time ? new Date(task.due_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  const titles = {
    dayBefore: `Due tomorrow${time ? ` at ${time}` : ''}`,
    morningOf: `Due today${time ? ` at ${time}` : ''}`,
    hourBefore: `Due in ${timeLeft(new Date(task.due_at) - now)}`,
    overdue: 'Overdue',
  };
  return {
    title: `${titles[kind]} · ${task.title}`,
    body: `${task.project_icon} ${task.project_name} · ${task.column_name}`,
    tag: `task-${task.id}`,
    url: `/p/${task.project_id}?task=${task.id}`,
  };
}

/**
 * @param {{ broadcast: (event: string, data: object) => void }} opts
 * @returns {{ test: () => Promise<object>, publicKey: string, stop: () => void }}
 */
export function startReminders({ broadcast }) {
  const vapid = store.getVapidKeys(() => webpush.generateVAPIDKeys());
  webpush.setVapidDetails('mailto:tasktracker@localhost', vapid.publicKey, vapid.privateKey);

  async function deliver(payload) {
    broadcast('reminder', payload);
    const subs = store.listPushSubscriptions();
    const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' })));
    results.forEach((r, i) => {
      // the browser revoked or expired this subscription
      if (r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode)) store.deletePushSubscription(subs[i].endpoint);
      else if (r.status === 'rejected') console.error('push failed:', r.reason?.statusCode || r.reason?.message);
    });
    return { subscriptions: subs.length, delivered: results.filter((r) => r.status === 'fulfilled').length };
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const settings = store.getReminderSettings();
      const fresh = dueReminders(store.reminderCandidates(), settings).filter((r) => store.markReminderSent(r.task.id, r.kind, r.task.due_at));
      if (fresh.length > 3) {
        // a burst (e.g. after the laptop wakes) becomes one calm summary instead of a flood
        await deliver({
          title: `${fresh.length} tasks need your attention`,
          body: fresh
            .slice(0, 4)
            .map((r) => `• ${r.task.title}`)
            .join('\n'),
          tag: 'summary',
          url: '/',
        });
      } else {
        for (const r of fresh) await deliver(message(r));
      }
    } catch (err) {
      console.error('reminders:', err.message);
    } finally {
      running = false;
    }
  }

  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, 60000);
  first.unref();
  timer.unref();

  return {
    publicKey: vapid.publicKey,
    test: () => deliver({ title: 'Reminders are on ✓', body: 'This is how deadline reminders will look.', tag: 'test', url: '/' }),
    stop: () => (clearTimeout(first), clearInterval(timer)),
  };
}
