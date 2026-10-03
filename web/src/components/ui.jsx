// Small shadcn-style primitives built on Radix, themed via CSS variables.
import { forwardRef, useEffect, useState } from 'react';
import { Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from 'radix-ui';
import { X } from 'lucide-react';

export const cx = (...c) => c.filter(Boolean).join(' ');

const btnBase =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[13px] font-medium transition-[background,color,box-shadow,transform] duration-150 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none select-none';
const btnVariants = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 shadow-sm',
  ghost: 'text-muted hover:text-fg hover:bg-hover',
  outline: 'border border-line bg-card text-fg hover:bg-hover',
  danger: 'bg-danger text-white hover:brightness-110',
  subtle: 'bg-hover text-fg hover:bg-line',
};
const btnSizes = { sm: 'h-7 px-2.5', md: 'h-8 px-3', lg: 'h-10 px-4 text-sm' };

export const Button = forwardRef(function Button({ variant = 'outline', size = 'md', className, ...props }, ref) {
  return <button ref={ref} type="button" className={cx(btnBase, btnVariants[variant], btnSizes[size], className)} {...props} />;
});

export const IconButton = forwardRef(function IconButton({ label, className, size = 'md', children, ...props }, ref) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cx(btnBase, 'text-muted hover:text-fg hover:bg-hover', size === 'sm' ? 'size-6 rounded-md' : 'size-8', className)}
      {...props}
    >
      {children}
    </button>
  );
  return label ? <Tip label={label}>{btn}</Tip> : btn;
});

export function Kbd({ children }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-card px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

// ---------- tooltip ----------

export function TipProvider({ children }) {
  return <T.Provider delayDuration={400}>{children}</T.Provider>;
}

export function Tip({ label, side = 'bottom', children }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="anim-pop z-50 rounded-md bg-fg px-2 py-1 text-[11px] font-medium text-bg shadow-pop">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

// ---------- dropdown menu ----------

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuSub = DM.Sub;

export function MenuContent({ className, children, align = 'end', ...props }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} className={cx('anim-pop z-50 min-w-[200px] rounded-xl border border-line bg-card p-1 shadow-pop', className)} {...props}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

const itemCls =
  'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&>svg]:size-4 [&>svg]:text-muted';

export function MenuItem({ className, danger, ...props }) {
  return <DM.Item className={cx(itemCls, danger && 'text-danger [&>svg]:!text-danger', className)} {...props} />;
}

export function MenuSubTrigger({ className, ...props }) {
  return <DM.SubTrigger className={cx(itemCls, 'data-[state=open]:bg-hover', className)} {...props} />;
}

export function MenuSubContent({ className, ...props }) {
  return (
    <DM.Portal>
      <DM.SubContent sideOffset={6} className={cx('anim-pop z-50 rounded-xl border border-line bg-card p-1 shadow-pop', className)} {...props} />
    </DM.Portal>
  );
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }) {
  return <DM.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{children}</DM.Label>;
}

// ---------- popover ----------

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

export function PopoverContent({ className, align = 'end', ...props }) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={8} className={cx('anim-pop z-50 rounded-xl border border-line bg-card p-3 shadow-pop outline-none', className)} {...props} />
    </P.Portal>
  );
}

// ---------- dialog & sheet ----------

export function Dialog({ open, onOpenChange, title, description, children, className }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <D.Content className={cx('anim-dialog fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-card p-5 shadow-pop outline-none', className)}>
          <D.Title className="font-display text-lg text-fg">{title}</D.Title>
          {description && <D.Description className="mt-1 text-[13px] leading-relaxed text-muted">{description}</D.Description>}
          <div className="mt-4">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Sheet({ open, onOpenChange, title, children, width = 560, header }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-overlay fixed inset-0 z-40 bg-black/20" />
        <D.Content
          aria-describedby={undefined}
          style={{ width: `min(100vw, ${width}px)` }}
          className="anim-sheet fixed inset-y-0 right-0 z-50 flex flex-col border-l border-line bg-card shadow-pop outline-none"
        >
          <div className="flex items-center gap-2 border-b border-line px-5 py-3">
            <D.Title className="flex-1 truncate text-[13px] font-medium text-muted">{title}</D.Title>
            {header}
            <D.Close asChild>
              <IconButton label="Close (Esc)">
                <X className="size-4" />
              </IconButton>
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---------- hooks ----------

/** Re-render every `ms` (only while `active`). Used for live countdowns. */
export function useNow(ms = 30000, active = true) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

export function ColorDot({ color, className }) {
  return <span data-color={color} className={cx('inline-block size-2.5 shrink-0 rounded-full bg-[var(--col)]', className)} />;
}
