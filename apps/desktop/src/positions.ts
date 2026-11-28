// Ordering things by hand with one number each: board cards in a view,
// pages in the sidebar. A drop usually changes one number in one file.

/**
 * The positions, by id, that put `item` before the one at `index` of
 * `others` (the other items in order; `index` past the end: last). `key`
 * is an item's position, `Infinity` for one that has none. Nearly always
 * one position, halfway between its new neighbours; none when the item
 * sorts there already. Neighbours that leave no room between them (items
 * without a position, or after very many drops in one spot) get the list
 * numbered again.
 */
export function dropPositions<T extends { id: string }>(
  others: T[],
  index: number,
  item: T,
  key: (t: T) => number,
): Record<string, number> {
  const before = others[index - 1];
  const after = others[index];
  const low = before ? key(before) : -Infinity;
  const high = after ? key(after) : Infinity;
  const fits = (k: number) => Number.isFinite(k) && low < k && k < high;
  if (fits(key(item)) || (!before && !after)) return {};
  const k = !before ? high - 1 : !after ? low + 1 : (low + high) / 2;
  if (fits(k)) return { [item.id]: k };
  const start = others.map(key).find(Number.isFinite) ?? 0;
  const order = [...others.slice(0, index), item, ...others.slice(index)];
  return Object.fromEntries(order.map((t, i) => [t.id, start + i]));
}
