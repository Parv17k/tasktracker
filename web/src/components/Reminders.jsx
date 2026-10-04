import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, Download, Send } from 'lucide-react';
import { toast } from 'sonner';
import { disablePush, enablePush, notificationsSupported, promptInstall, pushState, useCanInstall } from '../pwa';
import { Button, cx, IconButton, Popover, PopoverContent, PopoverTrigger, Tip } from './ui';

const LEADS = [
  [15, '15 min'],
  [30, '30 min'],
  [60, '1 hour'],
  [120, '2 hours'],
  [1440, '1 day'],
];

const request = (method, url, body) =>
  fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
    return data;
  });

/** Offered only when the browser says the app can be installed. */
export function InstallButton() {
  const canInstall = useCanInstall();
  if (!canInstall) return null;
  return (
    <Tip label="Install as an app">
      <Button variant="ghost" onClick={() => promptInstall()} aria-label="Install app">
        <Download className="size-4" /> <span className="hidden sm:inline">Install</span>
      </Button>
    </Tip>
  );
}

function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      <span className={cx('size-4 rounded-full bg-card shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

function Row({ title, hint, children }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{title}</div>
        {hint && <div className="text-[11.5px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Bell in the top bar: turn reminders on for this device and choose when they fire. */
export function RemindersButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState('off');
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    pushState().then(setState);
  }, []);

  useEffect(() => {
    if (!open) return;
    pushState().then(setState);
    request('GET', '/api/settings/reminders').then(setSettings).catch((e) => toast.error(e.message));
  }, [open]);

  const patch = async (p) => {
    setSettings((s) => ({ ...s, ...p }));
    try {
      setSettings(await request('PATCH', '/api/settings/reminders', p));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const toggleDevice = async () => {
    setBusy(true);
    try {
      const next = state === 'on' ? await disablePush() : await enablePush();
      setState(next);
      if (next === 'on') toast.success('Reminders are on for this device');
      if (next === 'denied') toast.error('Notifications are blocked. Allow them in your browser’s site settings.');
    } catch (e) {
      toast.error(`Could not turn on notifications: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      const r = await request('POST', '/api/push/test');
      if (!r.subscriptions) toast('Sent to open windows only', { description: 'Turn on notifications on this device to get them when the app is closed.' });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const Icon = state === 'on' && settings?.enabled !== false ? BellRing : state === 'denied' ? BellOff : Bell;
  const off = !settings?.enabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Reminders">
        <PopoverTrigger asChild>
          <IconButton aria-label="Reminders" className={cx(state === 'on' && 'text-accent')}>
            <Icon className="size-4" />
          </IconButton>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-[340px] p-4">
        <div className="flex items-center gap-2">
          <h3 className="font-display flex-1 text-[16px] text-fg">Deadline reminders</h3>
          {settings && <Switch label="Reminders on" checked={settings.enabled} onChange={(v) => patch({ enabled: v })} />}
        </div>

        {/* this device */}
        <div className="mt-3 rounded-xl border border-line bg-bg/40 p-3">
          {!notificationsSupported ? (
            <p className="text-[12.5px] text-muted">This browser can’t show notifications.</p>
          ) : state === 'denied' ? (
            <p className="text-[12.5px] text-muted">Notifications are blocked for this site. Allow them in your browser’s site settings, then reopen this panel.</p>
          ) : (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-[12.5px] text-muted">
                {state === 'on' ? 'This device gets reminders, even when the app is closed.' : 'Get system notifications on this device.'}
              </div>
              <Button size="sm" variant={state === 'on' ? 'outline' : 'primary'} disabled={busy} onClick={toggleDevice}>
                {state === 'on' ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          )}
        </div>

        {settings && (
          <div className={cx('mt-2 divide-y divide-line transition-opacity', off && 'pointer-events-none opacity-40')}>
            <Row title="The day before" hint={`At ${settings.morningTime}`}>
              <Switch label="The day before" checked={settings.dayBefore} onChange={(v) => patch({ dayBefore: v })} />
            </Row>
            <Row title="On the morning it’s due" hint={`At ${settings.morningTime}`}>
              <Switch label="On the morning it's due" checked={settings.morningOf} onChange={(v) => patch({ morningOf: v })} />
            </Row>
            <Row title="Before a due time" hint="For tasks with a time">
              <select
                aria-label="How long before"
                value={settings.leadMinutes}
                disabled={!settings.hourBefore}
                onChange={(e) => patch({ leadMinutes: Number(e.target.value) })}
                className="h-7 rounded-md border border-line bg-card px-1.5 text-[12px] outline-none focus:border-accent disabled:opacity-40"
              >
                {LEADS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <Switch label="Before a due time" checked={settings.hourBefore} onChange={(v) => patch({ hourBefore: v })} />
            </Row>
            <Row title="When it becomes overdue">
              <Switch label="When overdue" checked={settings.overdue} onChange={(v) => patch({ overdue: v })} />
            </Row>
            <Row title="Morning reminders at">
              <input
                type="time"
                aria-label="Morning reminder time"
                value={settings.morningTime}
                onChange={(e) => e.target.value && patch({ morningTime: e.target.value })}
                className="h-7 rounded-md border border-line bg-card px-1.5 text-[12px] outline-none focus:border-accent"
              />
            </Row>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-faint">Done tasks never remind you.</span>
          <Button size="sm" variant="ghost" onClick={test}>
            <Send className="size-3.5" /> Send test
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
