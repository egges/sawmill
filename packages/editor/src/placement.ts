// Placing menus inside the window: below or above the line they belong
// to, or beside a menu row, shifted and shortened as needed. Pure
// functions in window coordinates, so they can be tested without layout.

/** A box in window coordinates: the line (or button) a menu belongs to. */
export interface Line {
  left: number;
  right?: number;
  top: number;
  bottom: number;
}

type Size = { width: number; height: number };

/** Where a menu goes in the window, and how tall it may be (null: as tall as it likes). */
export interface Placement {
  left: number;
  top: number;
  maxHeight: number | null;
}

/** Space kept between a menu and the line it belongs to. */
export const MENU_GAP = 6;
/** Space kept between a menu and the window's edges. */
export const WINDOW_MARGIN = 8;

/**
 * Places a menu of `size` for `line`, inside a window of `window`: below
 * the line when it fits, else above when there's more room there, else
 * below and shorter (the menu scrolls). It shifts left when it would run
 * past the right edge. All in window coordinates.
 */
export function placeMenu(line: Line, size: Size, window: Size): Placement {
  const roomBelow = window.height - WINDOW_MARGIN - (line.bottom + MENU_GAP);
  const roomAbove = line.top - MENU_GAP - WINDOW_MARGIN;
  const left = Math.max(WINDOW_MARGIN, Math.min(line.left, window.width - WINDOW_MARGIN - size.width));
  if (size.height <= roomBelow) return { left, top: line.bottom + MENU_GAP, maxHeight: null };
  if (roomAbove > roomBelow) {
    const height = Math.min(size.height, roomAbove);
    return { left, top: line.top - MENU_GAP - height, maxHeight: size.height > roomAbove ? roomAbove : null };
  }
  return { left, top: line.bottom + MENU_GAP, maxHeight: Math.max(roomBelow, 0) };
}

/**
 * Places a submenu of `size` beside the menu row `row`, inside the window:
 * to its right, or to its left when only that fits. Its top lines up with
 * the row's, moved up as far as needed to fit, and it gets shorter (and
 * scrolls) in a window lower than it.
 */
export function placeBeside(row: Line, size: Size, window: Size): Placement {
  const right = (row.right ?? row.left) + MENU_GAP;
  const left = row.left - MENU_GAP - size.width;
  const x =
    right + size.width <= window.width - WINDOW_MARGIN
      ? right
      : left >= WINDOW_MARGIN
        ? left
        : Math.max(WINDOW_MARGIN, window.width - WINDOW_MARGIN - size.width);
  const room = window.height - 2 * WINDOW_MARGIN;
  const height = Math.min(size.height, room);
  // A little above the row, so the row and the submenu's first option line up.
  const top = Math.max(WINDOW_MARGIN, Math.min(row.top - 4, window.height - WINDOW_MARGIN - height));
  return { left: x, top, maxHeight: size.height > room ? room : null };
}

/**
 * Places the formatting toolbar for a selection whose first line is
 * `line` (from its start to its end on that line): centred above it, or
 * below it when there's no room above, and shifted to stay inside the
 * window's sides.
 */
export function placeToolbar(line: Line, size: Size, window: Size): Placement {
  const centre = (line.left + (line.right ?? line.left)) / 2;
  const left = Math.max(WINDOW_MARGIN, Math.min(centre - size.width / 2, window.width - WINDOW_MARGIN - size.width));
  const above = line.top - TOOLBAR_GAP - size.height;
  return { left, top: above >= WINDOW_MARGIN ? above : line.bottom + TOOLBAR_GAP, maxHeight: null };
}

/** Space kept between the toolbar and the selection. */
const TOOLBAR_GAP = 8;

/** One of the functions above. */
export type Place = (line: Line, size: Size, window: Size) => Placement;

/** The window's size, without scroll bars. */
export function windowSize(doc: Document = document): Size {
  return { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
}

/**
 * Scrolls the menu `list` so `row` is in view. Unlike `scrollIntoView`,
 * it never scrolls the page as well: that would move the menu away from
 * where it was placed.
 */
export function showRow(list: Element | null | undefined, row: Element | null | undefined) {
  if (!list || !row) return;
  const r = row.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  if (r.top < box.top) list.scrollTop -= box.top - r.top;
  else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
}
