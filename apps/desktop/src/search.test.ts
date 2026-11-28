import { expect, test } from "vitest";
import { highlight, searchSections } from "./search.ts";

const pages = [
  { id: "a", title: "Alpha", parent: null, kind: "page" as const, database: null, position: null },
  { id: "b", title: "Beta plan", parent: null, kind: "page" as const, database: null, position: null },
  { id: "a1", title: "Plans", parent: "a", kind: "page" as const, database: null, position: null },
];
const match = (page: string) => ({ page, before: "the ", matched: "plan", after: " is", count: 2 });

const summary = (sections: ReturnType<typeof searchSections>) =>
  sections.map((s) => [s.label, s.results.map((r) => r.key)]);

test("an empty query lists every page", () => {
  expect(summary(searchSections(pages, "", []))).toEqual([["All pages", ["page:a", "page:a1", "page:b"]]]);
});

test("titles first, then text matches, then creating a page", () => {
  const sections = searchSections(pages, "plan", [match("a"), match("gone")]);
  expect(summary(sections)).toEqual([
    ["Pages", ["page:a1", "page:b"]],
    ["In pages", ["text:a"]],
    ["Create", ["create"]],
  ]);
  const text = sections[1].results[0];
  expect(text.action).toEqual({ kind: "openPage", id: "a", reveal: "plan" });
  expect(text.detail).toBe("2 matches");
  expect(sections[0].results[0].detail).toBe("Alpha");
});

test("no create option when a page has exactly that title", () => {
  expect(summary(searchSections(pages, "plans", [])).map(([label]) => label)).toEqual(["Pages"]);
});

test("highlight splits around the match", () => {
  expect(highlight("Beta plan", "PLAN")).toEqual(["Beta ", "plan", ""]);
  expect(highlight("Beta", "x")).toBeNull();
});
