import { type RefObject, useLayoutEffect } from "react";
import { type Line, type Place, placeBeside, placeMenu, windowSize } from "../placement.ts";

export type { Line };

/**
 * Keeps `menu` inside the window, next to the line `anchor()` gives, as
 * `place` puts it (`placeMenu`, `placeBeside` or `placeToolbar`). Call on
 * every render, with a null anchor while the menu is closed. It sets the menu's position
 * itself, relative to the element it's positioned in, so don't also give
 * the menu `left` or `top`.
 */
export function useMenuPlacement(menu: RefObject<HTMLElement | null>, anchor: (() => Line) | null, place: Place = placeMenu) {
  useLayoutEffect(() => {
    const el = menu.current;
    const parent = el?.offsetParent;
    if (!el || !parent || !anchor) return;
    // Its natural size: offsetWidth and offsetHeight ignore the opening animation's transform.
    el.style.maxHeight = "";
    const line = anchor();
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    // Not `{ ...line }`: a DOMRect's fields are getters, which spreading leaves out.
    const row = { left: line.left, right: line.right ?? line.left, top: line.top, bottom: line.bottom };
    const at = place(row, size, windowSize());
    const box = parent.getBoundingClientRect();
    el.style.left = `${at.left - box.left}px`;
    el.style.top = `${at.top - box.top}px`;
    el.style.maxHeight = at.maxHeight === null ? "" : `${at.maxHeight}px`;
    // A submenu on the left of its row slides in from the right.
    if (place === placeBeside) el.style.setProperty("--page-menu-from", at.left < row.left ? "translateX(4px)" : "");
  });
}
