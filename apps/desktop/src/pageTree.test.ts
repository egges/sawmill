import { expect, test } from "vitest";
import { ancestry, displayOrder, insideText, pagesInside, search, trail } from "./pageTree.ts";

const pages = [
  { id: "a", title: "Alpha", parent: null, kind: "page" as const, database: null, position: null },
  { id: "b", title: "Beta plan", parent: null, kind: "page" as const, database: null, position: null },
  { id: "a1", title: "Plans", parent: "a", kind: "page" as const, database: null, position: null },
  { id: "a1x", title: "Launch", parent: "a1", kind: "page" as const, database: null, position: null },
];

test("pages inside a page are counted at any depth, without rows", () => {
  const withRow = [...pages, { id: "r", title: "Row", parent: "a", kind: "row" as const, database: "d", position: null }];
  expect(pagesInside(withRow, "a")).toEqual(["a1", "a1x"]);
  expect(pagesInside(withRow, "a1x")).toEqual([]);
  expect(insideText(0)).toBe("");
  expect(insideText(1)).toBe(" and the page inside it");
  expect(insideText(2)).toBe(" and the 2 pages inside it");
});

test("display order is depth first, like the sidebar", () => {
  expect(displayOrder(pages).map((p) => p.id)).toEqual(["a", "a1", "a1x", "b"]);
});

test("ancestry lists parents outermost first", () => {
  expect(ancestry(pages, "a1x")).toEqual(["Alpha", "Plans"]);
  expect(ancestry(pages, "a")).toEqual([]);
});

test("search ranks title starts, then word starts, then anywhere", () => {
  expect(search(pages, "pla").map((p) => p.id)).toEqual(["a1", "b"]);
  expect(search(pages, "unc").map((p) => p.id)).toEqual(["a1x"]);
  expect(search(pages, "").length).toBe(4);
});

test("the trail is the page with its ancestors, outermost first", () => {
  expect(trail(pages, "a1x").map((p) => p.id)).toEqual(["a", "a1", "a1x"]);
  expect(trail(pages, "b").map((p) => p.id)).toEqual(["b"]);
  expect(trail(pages, "missing")).toEqual([]);
});
