import { expect, test } from "vitest";
import { linkTarget } from "./links.ts";

const pages = [
  { id: "p1a2b3", title: "Plans", parent: null, kind: "page" as const, database: null, position: null },
  { id: "q9z8y7", title: "Launch", parent: null, kind: "page" as const, database: null, position: null },
];

test("web and mail addresses open outside the app", () => {
  expect(linkTarget("https://example.com/a?b#c", pages)).toEqual({ kind: "external", url: "https://example.com/a?b#c" });
  expect(linkTarget("HTTP://example.com", pages)).toEqual({ kind: "external", url: "HTTP://example.com" });
  expect(linkTarget("mailto:someone@example.com", pages)).toEqual({ kind: "external", url: "mailto:someone@example.com" });
});

test("an address without a scheme gets https", () => {
  expect(linkTarget("example.com", pages)).toEqual({ kind: "external", url: "https://example.com" });
  expect(linkTarget("docs.example.com/guide", pages)).toEqual({ kind: "external", url: "https://docs.example.com/guide" });
});

test("links to other pages open them here", () => {
  expect(linkTarget("../q9z8y7/page.md", pages)).toEqual({ kind: "page", id: "q9z8y7" });
  expect(linkTarget("pages/p1a2b3/page.md#intro", pages)).toEqual({ kind: "page", id: "p1a2b3" });
  expect(linkTarget("/pages/p1a2b3", pages)).toEqual({ kind: "page", id: "p1a2b3" });
});

test("anything else does nothing", () => {
  expect(linkTarget("#section", pages)).toEqual({ kind: "none" });
  expect(linkTarget("javascript:alert(1)", pages)).toEqual({ kind: "none" });
  expect(linkTarget("file:///etc/passwd", pages)).toEqual({ kind: "none" });
  expect(linkTarget("../missing/page.md", pages)).toEqual({ kind: "none" });
  expect(linkTarget("notes.md", pages)).toEqual({ kind: "none" });
  expect(linkTarget("", pages)).toEqual({ kind: "none" });
});
