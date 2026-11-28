import { expect, test } from "vitest";
import type { PageSummary } from "./api.ts";
import { canMoveInto, planMove } from "./pageMoves.ts";

const page = (id: string, parent: string | null = null, position: number | null = null): PageSummary => ({
  id,
  title: id,
  parent,
  kind: "page",
  database: null,
  position,
});

// In sidebar order: a (with a1, a2 inside), b, c.
const pages = [page("a"), page("a1", "a"), page("a2", "a"), page("b"), page("c")];

test("dropping onto a page puts it inside, after the pages arranged by hand", () => {
  expect(planMove(pages, "c", { inside: "a" })).toEqual({ parent: "a", positions: { c: null } });
  // Already inside: nothing to do.
  expect(planMove(pages, "a1", { inside: "a" })).toBeNull();
});

test("a page can't go inside itself or a page inside it", () => {
  expect(canMoveInto(pages, "a", "a1")).toBe(false);
  expect(canMoveInto(pages, "a", "a")).toBe(false);
  expect(canMoveInto(pages, "a1", "b")).toBe(true);
  expect(planMove(pages, "a", { inside: "a1" })).toBeNull();
  expect(planMove(pages, "a", { parent: "a1", index: 0 })).toBeNull();
});

test("dropping between pages numbers a level nobody arranged yet", () => {
  // c between a and b: top level is a, b without positions.
  expect(planMove(pages, "c", { parent: null, index: 1 })).toEqual({
    parent: null,
    positions: { a: 0, c: 1, b: 2 },
  });
  // a1 out to the top level, last.
  expect(planMove(pages, "a1", { parent: null, index: 3 })).toEqual({
    parent: null,
    positions: { a: 0, b: 1, c: 2, a1: 3 },
  });
});

test("in an arranged level a move changes one position", () => {
  const arranged = [page("a", null, 1), page("b", null, 2), page("c", null, 3)];
  expect(planMove(arranged, "c", { parent: null, index: 0 })).toEqual({ parent: null, positions: { c: 0 } });
  expect(planMove(arranged, "a", { parent: null, index: 2 })).toEqual({ parent: null, positions: { a: 4 } });
  expect(planMove(arranged, "c", { parent: null, index: 1 })).toEqual({ parent: null, positions: { c: 1.5 } });
});

test("dropping a page where it already is changes nothing", () => {
  expect(planMove(pages, "b", { parent: null, index: 1 })).toBeNull();
  expect(planMove(pages, "a2", { parent: "a", index: 1 })).toBeNull();
});

test("a page moved into an empty level keeps its position", () => {
  expect(planMove(pages, "c", { parent: "b", index: 0 })).toEqual({ parent: "b", positions: {} });
});
