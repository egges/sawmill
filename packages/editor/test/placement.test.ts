import { describe, expect, test } from "vitest";
import { MENU_GAP, WINDOW_MARGIN, placeBeside, placeMenu, placeToolbar } from "../src/placement.ts";

const window = { width: 1000, height: 800 };
const menu = { width: 220, height: 320 };
const lineAt = (top: number, left = 100) => ({ left, top, bottom: top + 20 });

describe("placing a menu inside the window", () => {
  test("below the line when it fits", () => {
    expect(placeMenu(lineAt(100), menu, window)).toEqual({ left: 100, top: 120 + MENU_GAP, maxHeight: null });
  });

  test("above the line near the bottom of the window", () => {
    const place = placeMenu(lineAt(700), menu, window);
    expect(place).toEqual({ left: 100, top: 700 - MENU_GAP - 320, maxHeight: null });
  });

  test("shifted left near the right edge", () => {
    expect(placeMenu(lineAt(100, 900), menu, window).left).toBe(1000 - WINDOW_MARGIN - 220);
  });

  test("never off the left edge, even in a window narrower than the menu", () => {
    expect(placeMenu(lineAt(100, 50), menu, { width: 200, height: 800 }).left).toBe(WINDOW_MARGIN);
  });

  test("shorter, where there is more room, when it fits neither below nor above", () => {
    const small = { width: 1000, height: 400 };
    // More room below: below, as tall as that room.
    expect(placeMenu(lineAt(100), menu, small)).toEqual({
      left: 100,
      top: 120 + MENU_GAP,
      maxHeight: 400 - WINDOW_MARGIN - 120 - MENU_GAP,
    });
    // More room above: above, from the window's top margin down to the line.
    expect(placeMenu(lineAt(250), menu, small)).toEqual({ left: 100, top: WINDOW_MARGIN, maxHeight: 250 - MENU_GAP - WINDOW_MARGIN });
  });
});

describe("placing a submenu beside its row", () => {
  const row = (top: number, left = 100) => ({ left, right: left + 230, top, bottom: top + 30 });

  test("to the right, lined up with the row", () => {
    expect(placeBeside(row(100), menu, window)).toEqual({ left: 330 + MENU_GAP, top: 96, maxHeight: null });
  });

  test("to the left when there's no room on the right", () => {
    expect(placeBeside(row(100, 600), menu, window).left).toBe(600 - MENU_GAP - 220);
  });

  test("over the menu when there's room on neither side", () => {
    expect(placeBeside(row(100, 100), menu, { width: 500, height: 800 }).left).toBe(500 - WINDOW_MARGIN - 220);
  });

  test("moved up to fit near the bottom of the window", () => {
    expect(placeBeside(row(700), menu, window).top).toBe(800 - WINDOW_MARGIN - 320);
  });

  test("shorter in a window lower than it", () => {
    expect(placeBeside(row(100), menu, { width: 1000, height: 300 })).toEqual({
      left: 330 + MENU_GAP,
      top: WINDOW_MARGIN,
      maxHeight: 300 - 2 * WINDOW_MARGIN,
    });
  });
});

describe("placing the formatting toolbar", () => {
  const toolbar = { width: 400, height: 36 };
  const selection = (top: number, left: number, right = left + 100) => ({ left, right, top, bottom: top + 20 });

  test("centred above the selection", () => {
    expect(placeToolbar(selection(300, 400), toolbar, window)).toEqual({ left: 250, top: 300 - 8 - 36, maxHeight: null });
  });

  test("below the selection at the top of the window", () => {
    expect(placeToolbar(selection(30, 400), toolbar, window).top).toBe(50 + 8);
  });

  test("inside the window's sides", () => {
    expect(placeToolbar(selection(300, 10), toolbar, window).left).toBe(WINDOW_MARGIN);
    expect(placeToolbar(selection(300, 900, 990), toolbar, window).left).toBe(1000 - WINDOW_MARGIN - 400);
  });
});
