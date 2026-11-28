---
name: sawmill-guidelines
description: Standard working guidelines for the Sawmill codebase. Use for any development work in this repo — writing or changing code, adding dependencies, restructuring files, and merging PRs.
---

# Sawmill working guidelines

Follow these whenever you work in this repo.

## Keep it simple

- Build the simplest thing that solves the actual problem. Don't overengineer.
- No speculative abstractions, config options, or extension points "for later".
- Prefer a few clear lines over a clever general solution. Three similar lines beat a premature helper.

## Prefer existing dependencies

- Before adding a dependency, check what's already in use:
  - Rust: `Cargo.toml` (workspace) and the crate's own `Cargo.toml` (`crates/*`, `apps/desktop/src-tauri`).
  - Frontend: `apps/desktop/package.json`, `packages/*/package.json`.
- Use an existing dependency (or the standard library) when it can do the job reasonably.
- Only add a new dependency when nothing in place fits, and say why in your summary.

## Check the structure as you go

- During any development work, ask whether the folder/module/file layout still fits the work.
- If a file is getting too big, mixes unrelated concerns, or new code doesn't have a natural home, restructure (split a module, move a file, add a folder) as part of the change.
- Keep restructuring proportional: move things because it makes the code clearer now, not for hypothetical future needs.

## Capture lessons as skills

- When you learn something during development that would make the work go better next time (a gotcha, a working command, a pattern that fits this codebase, a mistake to avoid), record it as a skill in `.claude/skills/`.
- Add it to an existing skill when it fits one (including this file); otherwise create a new skill with a focused name and a clear `description` saying when to use it.
- Keep entries short and concrete. Update or remove ones that turn out to be wrong.

## Gotchas

- Tauri swallows files dropped on the window unless `dragDropEnabled` is
  `false` in the window config (both `tauri.conf.json` and
  `tauri.macos.conf.json`); it is, so HTML5 drops reach the editor. The
  catch: a file drop nobody cancels makes the webview open the file in
  place of the app. `refuseFileDrops` (windowChrome.ts) refuses those;
  anything that takes files must `preventDefault` its `dragover`.
- ProseMirror ignores DOM events that are already `defaultPrevented`. The
  editor's file drops (`react/FileDrop.tsx`) listen on the window in the
  capture phase, so they run first and the editor never also takes the drop
  as text.
- ProseMirror puts `img.ProseMirror-separator` elements next to inline
  nodes such as images: query `img[src]` in tests, and don't rely on
  `:only-child` in CSS.
- Run interactive-looking commands (`npx vitest`, `cat >`) with
  `</dev/null`, or a stray stdin read hangs the shell.

- Milkdown's presets are flat arrays of plugins, and `$nodeSchema` /
  `$useKeymap` / `$remark` return pairs. To replace a piece (as lists.ts
  replaces Milkdown's lists), leave its plugins out with `without()` in
  editor.ts rather than patching around them.
- Milkdown's serializer never runs remark transformers. To change the
  Markdown tree before it's written, wrap `serializerCtx` (see
  `joinListsOnSave` in lists.ts); the clipboard reads it lazily, so it
  gets the wrapper too.

- Milkdown's Markdown spelling is decided by remark-stringify's `join`
  rules (`configureHouseStyle` in markdown.ts). In a tight list item the
  blocks are joined with no blank line, so anything that can continue the
  block before it (paragraph, table) or turn it into a heading (a rule)
  needs a `join` rule of ours.

- Milkdown's `remarkHtmlTransformer` runs before our own remark plugins:
  by then a block of HTML at the top level, in a list item or a quote is
  a paragraph holding an `html` node. Match both shapes (`htmlOf` in
  toggles.ts).
- State that isn't part of the page (whether a toggle is open) lives in a
  plugin state shown through decorations, never in node attributes: those
  would make the page dirty and end up compared on save.

## Testing the editor

- `test/dragging.test.ts` drops every block at every offered place on
  random pages (`test/randomPages.ts`, fast-check) and checks content,
  nesting, save-and-reopen and undo. For a deeper search before merging
  editor changes: `RUNS=3000 npx vitest run test/dragging.test.ts </dev/null`.
- `test/keyboard.test.ts` does the same for random sequences of keys, "turn
  into" and typing: valid page, text kept, save-and-reopen, undo all.
  `RUNS=3000` works there too; run it a few times, as each run has a new seed.
- When either finds a bug, fast-check prints a small Markdown page (and the
  steps): fix it, then add that case as an example test next to the
  feature's other tests.
- jsdom has no layout, so menu placement is checked in a real browser:
  run the editor demo (`npx vite demo --port 5191` in `packages/editor`)
  and drive it with `playwright-core@1.49.1` installed in the scratchpad.
  That version matches the WebKit already in `~/Library/Caches/ms-playwright`
  (`webkit-2104`), so nothing needs downloading. Keep placement logic in
  pure functions (`placement.ts`) so it can be unit-tested.
- The desktop app has no browser mock, so to try one of its components
  (drag and drop, layout) mount it alone: a scratchpad `index.html` +
  `main.tsx` importing it and `app.css` by absolute path, served with
  `npx vite <dir> --config <dir>/vite.config.mjs` run from `apps/desktop`;
  that config imports `@vitejs/plugin-react` from `apps/desktop/node_modules`
  by path, aliases `react`, `react-dom` and `lucide-react` there, and sets
  `server.fs.strict: false`. The first load reloads once while Vite
  optimizes dependencies: load again if `evaluate` says the context was
  destroyed.
- Menus scroll their active row with `showRow` (placement.ts), never
  `scrollIntoView`: that also scrolls the page, which moves the menu away
  from where it was just placed. And a `DOMRect`'s fields are getters, so
  `{ ...rect }` copies nothing.
- Milkdown writes an empty paragraph as `<br />`, an HTML block that runs
  until a blank line. An empty item's line is written that way too (a bare
  `-` under a line reads as a heading underline, and `- [ ]` as text), so
  what's nested under it needs a blank line before it (lists.ts).

## Tracking work in GitHub issues

Bugs, features and chores are tracked as issues on `egges/sawmill`.
`docs/roadmap.md` stays the plan: the order of the work and the decisions
behind it. Issues hold the concrete work.

- **Before starting work**, look for its issue (`gh issue list --search
  "<words>"`, or `--state all`). If there is none, open one, unless the
  change is trivial (a typo, a one-line fix). Link the issue to the thread
  (`link_issue`) when that tool is available.
- **One label per issue for its kind:** `bug` (something broken),
  `enhancement` (a feature or a change in behaviour), `chore` (upkeep:
  dependencies, CI, refactoring, tests, tooling) or `documentation`. Add
  `accessibility` where it applies.
- **Keep issues short:** what and why in a few lines, then "Done when" with
  what has to be true. For a bug: the steps, what happens, what should
  happen. A failing property-test case goes in as the steps.
- **Found something you won't fix now?** A bug the tests turned up that is
  out of scope, a follow-up, a "still to do" in a PR: open an issue for it
  instead of leaving it only in a PR description, and mention its number
  in the PR.
- **PRs close their issue:** put `Closes #N` in the PR description (one
  line per issue) so merging closes it.
- **Roadmap items and issues:** when an issue is opened for a roadmap item,
  add its number to the item (`- [ ] **Trash.** (#61) …`). Tick the item
  when the issue closes. Only open issues for roadmap items that are about
  to be worked on, not the whole list in advance.
- **The repository is public.** Issues must not contain private details:
  no real email contents, names of customers, tokens or paths with personal
  data. Describe the case in general terms instead.

## Merging PRs

- After merging a PR, switch the checkout back to `main` (and pull) **before** settling/organizing the thread.
