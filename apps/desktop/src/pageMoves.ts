// Moving pages in the sidebar by dragging, kept apart from React so it can
// be tested: what a drop does to a page's parent and position.
import type { PageSummary } from "./api.ts";
import { childrenOf, pagesInside } from "./pageTree.ts";
import { dropPositions } from "./positions.ts";

/**
 * Where a dragged page would land: inside another page (last, among the
 * pages nobody arranged), or in a level (under `parent`, null for the top)
 * before the page at `index` of the pages there other than itself.
 */
export type PageDrop = { inside: string } | { parent: string | null; index: number };

/** What a drop changes: the page's parent, and positions by page id (null removes one). */
export interface PageMove {
  parent: string | null;
  positions: Record<string, number | null>;
}

const key = (p: PageSummary) => p.position ?? Infinity;

/** Whether `id` may go under `parent`: not into itself or a page inside it. */
export function canMoveInto(pages: PageSummary[], id: string, parent: string | null): boolean {
  return parent === null || (parent !== id && !pagesInside(pages, id).includes(parent));
}

/** What dropping page `id` at `drop` changes, or null when it changes nothing or isn't allowed. `pages` are in sidebar order. */
export function planMove(pages: PageSummary[], id: string, drop: PageDrop): PageMove | null {
  const shown = pages.filter((p) => p.kind !== "row");
  const page = shown.find((p) => p.id === id);
  if (!page) return null;
  if ("inside" in drop) {
    if (drop.inside === page.parent || !canMoveInto(shown, id, drop.inside)) return null;
    return { parent: drop.inside, positions: { [id]: null } };
  }
  if (!canMoveInto(shown, id, drop.parent)) return null;
  const others = (childrenOf(shown).get(drop.parent) ?? []).filter((p) => p.id !== id);
  if (page.parent === drop.parent) {
    const at = (childrenOf(shown).get(drop.parent) ?? []).findIndex((p) => p.id === id);
    if (at === drop.index) return null;
  }
  return { parent: drop.parent, positions: dropPositions(others, drop.index, page, key) };
}
