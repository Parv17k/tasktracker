import { useMemo, useRef, useState } from 'react';
import { Check, Pencil, Tag, Tags as TagsIcon, Trash2, X } from 'lucide-react';
import { tagColor, TAG_COLORS } from '../../../shared/tags.js';
import { useBoard } from '../store';
import { Button, cx, Dialog, IconButton, Popover, PopoverContent, PopoverTrigger, Tip } from './ui';

/** Colour of a tag: the saved one, or the same colour the server will give a new tag. */
export function useTagColor() {
  const tags = useBoard((s) => s.tags);
  const byName = useMemo(() => new Map(tags.map((t) => [t.name.toLowerCase(), t.color])), [tags]);
  return (name) => byName.get(name.toLowerCase()) || tagColor(name);
}

/** Clean a typed tag the way the server will: no leading #, single spaces, no commas. */
export const cleanTag = (raw) =>
  String(raw)
    .replace(/,/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

export function TagChip({ name, color, active, onClick, onRemove, size = 'sm', className }) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      data-color={color}
      onClick={onClick}
      onPointerDown={onClick ? (e) => e.stopPropagation() : undefined}
      title={onClick ? (active ? `Showing only #${name}. Click to clear` : `Show only #${name}`) : undefined}
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded-full font-medium leading-none text-fg ring-1 ring-inset transition-colors',
        'ring-[color-mix(in_oklab,var(--col)_35%,transparent)] [background:color-mix(in_oklab,var(--col)_14%,transparent)]',
        size === 'sm' ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-6 px-2 text-[12px]',
        onClick && 'hover:[background:color-mix(in_oklab,var(--col)_24%,transparent)]',
        active && 'ring-2 ring-[var(--col)]',
        className
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-[var(--col)]" />
      <span className="truncate">{name}</span>
      {onRemove && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Remove tag ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-3" />
        </span>
      )}
    </Comp>
  );
}

/** A row of chips, collapsing extras into "+N". */
export function TagList({ tags, max = 3, onPick, activeNames = [] }) {
  const color = useTagColor();
  if (!tags?.length) return null;
  const shown = tags.slice(0, max);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((name) => (
        <TagChip key={name} name={name} color={color(name)} active={activeNames.includes(name.toLowerCase())} onClick={onPick && ((e) => (e.stopPropagation(), onPick(name)))} />
      ))}
      {tags.length > max && (
        <span className="text-[10.5px] text-faint" title={tags.slice(max).join(', ')}>
          +{tags.length - max}
        </span>
      )}
    </span>
  );
}

/**
 * Chips plus a text box. Enter, comma or Tab adds a tag; Backspace in an empty box removes
 * the last one. Known tags are suggested as you type.
 */
export function TagEditor({ value, onChange, placeholder = 'Add a tag…', autoFocus }) {
  const allTags = useBoard((s) => s.tags);
  const color = useTagColor();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef(null);

  const have = new Set(value.map((v) => v.toLowerCase()));
  const q = cleanTag(text).toLowerCase();
  const suggestions = allTags
    .filter((t) => !have.has(t.name.toLowerCase()) && (!q || t.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0) || b.tasks + b.projects - (a.tasks + a.projects))
    .slice(0, 6);
  const exact = allTags.find((t) => t.name.toLowerCase() === q);
  const options = [...suggestions.map((t) => t.name), ...(q && !exact && !have.has(q) ? [cleanTag(text)] : [])];
  const open = focused && options.length > 0 && (q || value.length < 20);

  const add = (raw) => {
    // reuse the existing spelling of a known tag
    const name = cleanTag(raw);
    if (!name) return;
    const known = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const final = known ? known.name : name;
    if (!have.has(final.toLowerCase())) onChange([...value, final]);
    setText('');
    setHi(0);
  };
  const remove = (name) => onChange(value.filter((v) => v !== name));

  return (
    <div className="relative">
      <div
        onClick={() => input.current?.focus()}
        className={cx('flex min-h-8 cursor-text flex-wrap items-center gap-1 rounded-lg border bg-bg/40 px-1.5 py-1', focused ? 'border-accent' : 'border-line hover:border-line-strong')}
      >
        {value.map((name) => (
          <TagChip key={name} name={name} color={color(name)} size="md" onRemove={() => remove(name)} />
        ))}
        <input
          ref={input}
          value={text}
          autoFocus={autoFocus}
          aria-label="Add a tag"
          placeholder={value.length ? '' : placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (cleanTag(text)) add(text);
          }}
          onChange={(e) => {
            const v = e.target.value;
            // typing or pasting a comma adds what came before it
            if (v.includes(',')) {
              const parts = v.split(',');
              parts.slice(0, -1).forEach(add);
              setText(parts.at(-1));
            } else setText(v);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || (e.key === 'Tab' && text.trim())) {
              e.preventDefault();
              add(open && options[hi] ? options[hi] : text);
            } else if (e.key === 'Backspace' && !text && value.length) {
              remove(value.at(-1));
            } else if (e.key === 'ArrowDown' && open) {
              e.preventDefault();
              setHi((h) => (h + 1) % options.length);
            } else if (e.key === 'ArrowUp' && open) {
              e.preventDefault();
              setHi((h) => (h - 1 + options.length) % options.length);
            } else if (e.key === 'Escape' && text) {
              e.stopPropagation();
              setText('');
            }
          }}
          className="h-6 min-w-[90px] flex-1 bg-transparent px-1 text-[13px] text-fg outline-none placeholder:text-faint"
        />
      </div>
      {open && (
        <ul role="listbox" aria-label="Tag suggestions" className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line bg-card py-1 shadow-pop">
          {options.map((name, i) => {
            const isNew = i === options.length - 1 && !suggestions.some((t) => t.name === name);
            return (
              <li
                key={name}
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => (e.preventDefault(), add(name))}
                onMouseEnter={() => setHi(i)}
                className={cx('flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px]', i === hi && 'bg-hover')}
              >
                {isNew ? (
                  <>
                    <Tag className="size-3.5 text-faint" /> <span className="text-muted">Create</span> <TagChip name={name} color={color(name)} />
                  </>
                ) : (
                  <TagChip name={name} color={color(name)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Filter by tags: a button that opens the list of tags in use. Shows items with ANY of the
 * selected tags. `names` are the tags present in the current view, so the list stays relevant.
 */
export function TagFilter({ names, selected, onToggle, onClear, onManage }) {
  const color = useTagColor();
  const count = selected.length;
  return (
    <Popover>
      <Tip label="Filter by tag">
        <PopoverTrigger asChild>
          <Button variant={count ? 'subtle' : 'ghost'} aria-label="Filter by tag" className={cx(count && 'text-fg')}>
            <TagsIcon className="size-4" />
            {count > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">{count}</span>}
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-64 p-2">
        <div className="mb-1 flex items-center px-1.5 pt-0.5">
          <span className="flex-1 text-[11px] font-medium uppercase tracking-wider text-faint">Filter by tag</span>
          {count > 0 && (
            <button type="button" onClick={onClear} className="text-[12px] text-muted hover:text-fg">
              Clear
            </button>
          )}
        </div>
        {names.length === 0 ? (
          <p className="px-1.5 py-3 text-[12.5px] leading-relaxed text-muted">No tags here yet. Add them from a card’s details, or type #tag when adding a task.</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {names.map(({ name, count: n }) => {
              const on = selected.includes(name.toLowerCase());
              return (
                <li key={name}>
                  <button type="button" onClick={() => onToggle(name)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover">
                    <span className={cx('flex size-4 items-center justify-center rounded border', on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                    <TagChip name={name} color={color(name)} />
                    <span className="ml-auto text-[11.5px] tabular-nums text-faint">{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {onManage && (
          <div className="mt-1 border-t border-line pt-1">
            <button type="button" onClick={onManage} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg">
              <Pencil className="size-3.5" /> Manage tags…
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Rename, recolour or delete tags. Changes apply everywhere the tag is used. */
export function ManageTagsDialog({ open, onClose }) {
  const tags = useBoard((s) => s.tags);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} title="Tags" description="Rename, recolour or delete a tag. Changes apply to every task and project that uses it." className="w-[min(92vw,480px)]">
      {tags.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">No tags yet.</p>
      ) : (
        <ul className="-mx-1 max-h-[60vh] divide-y divide-line overflow-y-auto">
          {tags.map((t) => (
            <ManageRow key={t.id} tag={t} />
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

function ManageRow({ tag }) {
  const { renameTag, recolorTag, deleteTag } = useBoard.getState();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [confirm, setConfirm] = useState(false);
  const uses = [tag.tasks && `${tag.tasks} task${tag.tasks === 1 ? '' : 's'}`, tag.projects && `${tag.projects} project${tag.projects === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'Only on archived items';

  const save = async () => {
    const next = cleanTag(name);
    setEditing(false);
    if (!next || next === tag.name) return setName(tag.name);
    try {
      await renameTag(tag.id, next);
    } catch {
      setName(tag.name);
    }
  };

  return (
    <li className="flex items-center gap-2 px-1 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`Colour of ${tag.name}`} data-color={tag.color} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover">
            <span className="size-3 rounded-full bg-[var(--col)]" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex gap-1 p-1.5">
          {TAG_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} data-color={c} onClick={() => recolorTag(tag.id, c)} className={cx('flex size-6 items-center justify-center rounded-md hover:bg-hover', c === tag.color && 'bg-hover')}>
              <span className="size-3 rounded-full bg-[var(--col)]" />
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={name}
            aria-label="Tag name"
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') (e.stopPropagation(), setName(tag.name), setEditing(false));
            }}
            className="h-7 w-full rounded-md border border-accent bg-bg/40 px-2 text-[13px] outline-none"
          />
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="block max-w-full truncate text-left text-[13px] text-fg hover:underline" title="Rename">
            {tag.name}
          </button>
        )}
        <div className="text-[11.5px] text-faint">{uses}</div>
      </div>
      {confirm ? (
        <span className="flex items-center gap-1">
          <Button size="sm" variant="danger" onClick={() => deleteTag(tag.id)}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <>
          <IconButton size="sm" label="Rename" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton size="sm" label="Delete tag" onClick={() => setConfirm(true)} className="hover:text-danger">
            <Trash2 className="size-3.5" />
          </IconButton>
        </>
      )}
    </li>
  );
}
