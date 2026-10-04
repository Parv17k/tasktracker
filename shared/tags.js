// Tag colours, shared by the server and the web UI so a new tag shows its colour
// immediately, before the server has answered.

export const TAG_COLORS = ['slate', 'blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet'];

/** A stable colour for a tag name (same name, same colour). */
export function tagColor(name) {
  let h = 0;
  for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

const key = (t) => String(t).trim().replace(/^#+/, '').toLowerCase();

/** `current` with `add` appended and `remove` taken out, ignoring case and a leading #. */
export function changeTags(current = [], { add = [], remove = [] } = {}) {
  const drop = new Set(remove.map(key));
  const out = current.filter((t) => !drop.has(key(t)));
  for (const t of add) if (!drop.has(key(t)) && !out.some((x) => key(x) === key(t))) out.push(String(t).trim().replace(/^#+/, ''));
  return out;
}
