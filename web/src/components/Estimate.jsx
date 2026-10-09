// Task estimates (sizes or amounts) and, when a project has an hourly rate, cost.
// Everything here stays out of sight until it's used: no estimate, no chip.
import { useEffect, useState } from 'react';
import { costOf, formatEstimate, formatMoney, parseEstimate, sizeOf, SIZES } from '../../../shared/estimate.js';
import { cx, Tip, useNow } from './ui';

/** Tracked seconds, including a running timer. */
export function useTracked(task) {
  const running = !!task.timerStartedAt;
  const now = useNow(30000, running);
  return task.timeSpent + (running ? Math.max(0, (now - Date.parse(task.timerStartedAt)) / 1000) : 0);
}

/** "M" when the estimate is a size, otherwise "~1h 30m". */
export const estimateLabel = (minutes) => sizeOf(minutes)?.key ?? `~${formatEstimate(minutes)}`;

/** Small chip on a card; amber once tracked time goes past the estimate. */
export function EstimateChip({ task, done }) {
  const tracked = useTracked(task);
  if (!task.estimateMinutes) return null;
  const over = !done && tracked > task.estimateMinutes * 60;
  const size = sizeOf(task.estimateMinutes);
  return (
    <span
      title={`Estimate: ${size ? `${size.label}, ` : ''}${formatEstimate(task.estimateMinutes)}${over ? ' · over estimate' : ''}`}
      className={cx('inline-flex h-[18px] items-center rounded px-1.5 font-mono text-[10.5px] font-medium tabular-nums', over ? 'bg-warn/15 text-warn' : 'bg-hover text-muted')}
    >
      {estimateLabel(task.estimateMinutes)}
    </span>
  );
}

/** Task panel: size presets plus a free-form amount, and how tracked time compares. */
export function EstimatePicker({ task, project, onChange }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const tracked = useTracked(task);
  const current = task.estimateMinutes;
  const size = sizeOf(current);

  useEffect(() => {
    setText(current && !size ? formatEstimate(current) : '');
    setError('');
  }, [current, size]);

  const commit = () => {
    if (!text.trim()) return;
    try {
      const m = parseEstimate(text);
      setError('');
      if (m !== current) onChange(m);
    } catch (e) {
      setError(e.message);
    }
  };

  const trackedMin = Math.round(tracked / 60);
  const over = current && trackedMin > current;
  const rate = project?.hourlyRate;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Size">
          {SIZES.map((s) => (
            <Tip key={s.key} label={`${s.label} · ${formatEstimate(s.minutes)}`}>
              <button
                type="button"
                role="radio"
                aria-checked={current === s.minutes}
                aria-label={`${s.label}, ${formatEstimate(s.minutes)}`}
                onClick={() => onChange(current === s.minutes ? null : s.minutes)}
                className={cx('h-7 min-w-8 rounded-md px-2 font-mono text-[12px] transition-colors', current === s.minutes ? 'bg-accent-soft font-semibold text-fg shadow-sm' : 'text-muted hover:text-fg')}
              >
                {s.key}
              </button>
            </Tip>
          ))}
        </div>
        <input
          value={text}
          aria-label="Exact estimate"
          placeholder={size ? formatEstimate(current) : 'or e.g. 90m, 2.5h'}
          onChange={(e) => (setText(e.target.value), setError(''))}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
          className={cx('h-8 w-32 rounded-lg border bg-bg/60 px-2 text-[13px] outline-none focus:border-accent', error ? 'border-danger' : 'border-line')}
        />
        {current && (
          <button type="button" onClick={() => onChange(null)} className="ml-auto h-8 rounded-lg px-2 text-[12px] text-faint hover:bg-hover hover:text-danger">
            Clear
          </button>
        )}
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {current && (
        <p className={cx('text-[12px]', over ? 'font-medium text-warn' : 'text-muted')}>
          {trackedMin ? `${formatEstimate(trackedMin) || '0m'} tracked of ~${formatEstimate(current)}` : `~${formatEstimate(current)} estimated`}
          {over && ' · over estimate'}
          {rate ? (
            <span className="text-muted">
              {' '}
              · ~{formatMoney(costOf(current, rate), project.currency)}
              {trackedMin ? ` est., ${formatMoney(costOf(trackedMin, rate), project.currency)} so far` : ''}
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}
