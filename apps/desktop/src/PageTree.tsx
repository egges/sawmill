// The pages in the sidebar, as a tree. Clicking a page opens it and shows
// the pages inside it; clicking the open page again shows or hides them. Drag a page to move it: onto
// another page to put it inside, between two to put it there, or below the
// tree to move it to the top level. Esc puts it back.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronRight, FileText, Files, Plus, Sheet } from "lucide-react";
import type { PageSummary } from "./api.ts";
import { planMove, type PageDrop, type PageMove } from "./pageMoves.ts";
import { childrenOf } from "./pageTree.ts";

/** How far the pointer moves before a press on a page becomes a drag. */
const DRAG_DISTANCE = 4;

/** Within this distance of the tree's top or bottom, a drag scrolls it. */
const SCROLL_EDGE = 32;

/** The indent of each level, and of the first. */
const INDENT = 14;
const PAD = 8;

interface Drag {
  id: string;
  title: string;
  x: number;
  y: number;
  /** Where it would land, and what that changes; null for nowhere. */
  drop: PageDrop | null;
  move: PageMove | null;
  /** Where the line showing a drop between pages goes, in the tree's coordinates. */
  line: { top: number; left: number } | null;
}

export function PageTree({
  pages,
  selected,
  onSelect,
  onCreate,
  onMove,
}: {
  pages: PageSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: (parent: string | null) => void;
  onMove: (id: string, move: PageMove) => void;
}) {
  // Rows are pages too, but they're shown in their database, not here.
  const shown = useMemo(() => pages.filter((p) => p.kind !== "row"), [pages]);
  const children = useMemo(() => childrenOf(shown), [shown]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ id: string; title: string; x: number; y: number } | null>(null);
  const dragging = useRef<Drag | null>(null);
  const tree = useRef<HTMLUListElement>(null);

  const toggle = (id: string) =>
    setClosed((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const expand = (id: string) => setClosed((now) => (now.has(id) ? new Set([...now].filter((c) => c !== id)) : now));

  /** The drop at (x, y) for page `id`, and where its line goes. */
  const dropAt = (id: string, x: number, y: number): Pick<Drag, "drop" | "line"> => {
    const list = tree.current;
    const nav = list?.parentElement;
    const box = nav?.getBoundingClientRect();
    if (!list || !nav || !box || x < box.left || x > box.right || y > box.bottom) return { drop: null, line: null };
    const origin = box.top - nav.scrollTop;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-page]")];
    const between = (parent: string | null, before: string | null, edge: number, depth: number) => {
      const others = (children.get(parent) ?? []).filter((p) => p.id !== id);
      const at = before === null ? others.length : others.findIndex((p) => p.id === before);
      return { drop: { parent, index: at }, line: { top: edge - origin, left: PAD + depth * INDENT } };
    };
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (y < rect.top || y >= rect.bottom) continue;
      const page = row.dataset.page!;
      const parent = row.dataset.parent || null;
      const depth = Number(row.dataset.depth);
      const part = (y - rect.top) / rect.height;
      if (part < 0.25) return between(parent, page, rect.top, depth);
      if (part <= 0.75) return { drop: { inside: page }, line: null };
      // Below an open page with pages inside: first among those.
      const kids = (children.get(page) ?? []).filter((p) => p.id !== id);
      if (row.dataset.open === "true" && kids.length) return between(page, kids[0].id, rect.bottom, depth + 1);
      const others = (children.get(parent) ?? []).filter((p) => p.id !== id);
      const next = others[others.findIndex((p) => p.id === page) + 1];
      return between(parent, next?.id ?? null, rect.bottom, depth);
    }
    // Above the first page: first; below the last: last at the top level.
    const first = rows[0]?.getBoundingClientRect();
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    if (first && y < first.top) return between(null, rows[0].dataset.page!, first.top, 0);
    if (last && y >= last.bottom) return between(null, null, last.bottom, 0);
    return { drop: null, line: null };
  };

  const dragTo = (base: Pick<Drag, "id" | "title">, x: number, y: number) => {
    const { drop, line } = dropAt(base.id, x, y);
    const move = drop && planMove(pages, base.id, drop);
    // A drop that changes nothing, or isn't allowed, shows nothing.
    const next: Drag = { ...base, x, y, drop: move ? drop : null, move, line: move ? line : null };
    dragging.current = next;
    setDrag(next);
  };

  const stopDrag = () => {
    press.current = null;
    dragging.current = null;
    setDrag(null);
  };

  // While dragging: scroll the tree when the pointer is near its top or
  // bottom, and Esc puts the page back.
  const active = drag !== null;
  useEffect(() => {
    if (!active) return;
    let frame = requestAnimationFrame(function step() {
      const d = dragging.current;
      const nav = tree.current?.parentElement;
      if (d && nav) {
        const rect = nav.getBoundingClientRect();
        const by = d.y < rect.top + SCROLL_EDGE ? -6 : d.y > rect.bottom - SCROLL_EDGE ? 6 : 0;
        const before = nav.scrollTop;
        nav.scrollTop += by;
        if (nav.scrollTop !== before) dragTo(d, d.x, d.y);
      }
      frame = requestAnimationFrame(step);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stopDrag();
    };
    window.addEventListener("keydown", onKey, true);
    document.body.classList.add("dragging-page");
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      document.body.classList.remove("dragging-page");
    };
  }, [active]);

  const pointer = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>, page: PageSummary) => {
      // The buttons on a row do their own thing.
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      // No text selection: it would follow the pointer over the sidebar.
      e.preventDefault();
      press.current = { id: page.id, title: page.title || "Untitled", x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p) return;
      if (!dragging.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_DISTANCE) return;
      dragTo(p, e.clientX, e.clientY);
    },
    onPointerUp: () => {
      const p = press.current;
      const d = dragging.current;
      stopDrag();
      if (!p) return;
      if (!d) {
        // A click opens the page and shows the pages inside it; clicking
        // the open page again shows or hides them.
        if (children.get(p.id)?.length) {
          if (p.id === selected) toggle(p.id);
          else expand(p.id);
        }
        return onSelect(p.id);
      }
      if (!d.move || !d.drop) return;
      // Open the page it went into, so it can be seen there.
      const into = "inside" in d.drop ? d.drop.inside : d.drop.parent;
      if (into) expand(into);
      onMove(d.id, d.move);
    },
    onLostPointerCapture: () => {
      // Pointer up has already run when the drag ended normally.
      if (press.current) stopDrag();
    },
  };

  return (
    <>
      <ul className="tree-level" role="tree" ref={tree}>
        {(children.get(null) ?? []).map((page) => (
          <TreeItem
            key={page.id}
            page={page}
            children={children}
            depth={0}
            selected={selected}
            closed={closed}
            drag={drag}
            pointer={pointer}
            onToggle={toggle}
            onCreate={onCreate}
          />
        ))}
      </ul>
      {drag?.line && <div className="tree-drop" style={{ top: Math.max(1, drag.line.top), left: drag.line.left + 6 }} aria-hidden />}
      {drag && (
        <div className="tree-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }} aria-hidden>
          {drag.title}
        </div>
      )}
    </>
  );
}

type Pointer = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, page: PageSummary) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onLostPointerCapture: () => void;
};

function TreeItem({
  page,
  children,
  depth,
  selected,
  closed,
  drag,
  pointer,
  onToggle,
  onCreate,
}: {
  page: PageSummary;
  children: Map<string | null, PageSummary[]>;
  depth: number;
  selected: string | null;
  closed: Set<string>;
  drag: Drag | null;
  pointer: Pointer;
  onToggle: (id: string) => void;
  onCreate: (parent: string | null) => void;
}) {
  const open = !closed.has(page.id);
  const kids = children.get(page.id) ?? [];
  const target = drag?.drop && "inside" in drag.drop && drag.drop.inside === page.id;
  return (
    <li role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={page.id === selected}>
      <div
        className={
          "tree-row" +
          (page.id === selected ? " selected" : "") +
          (drag?.id === page.id ? " dragging" : "") +
          (target ? " drop-target" : "")
        }
        style={{ paddingLeft: PAD + depth * INDENT }}
        data-page={page.id}
        data-parent={page.parent ?? ""}
        data-depth={depth}
        data-open={open}
        onPointerDown={(e) => pointer.onPointerDown(e, page)}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onLostPointerCapture={pointer.onLostPointerCapture}
      >
        <button
          className="disclosure"
          aria-label={open ? "Collapse" : "Expand"}
          style={{ visibility: kids.length ? "visible" : "hidden" }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(page.id);
          }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="tree-icon" aria-hidden>
          {page.kind === "database" ? <Sheet size={15} /> : kids.length ? <Files size={15} /> : <FileText size={15} />}
        </span>
        <span className={"tree-title" + (page.title ? "" : " untitled")}>{page.title || "Untitled"}</span>
        <button
          className="icon-button add-child"
          title="Add a page inside"
          aria-label="Add a page inside"
          onClick={(e) => {
            e.stopPropagation();
            onCreate(page.id);
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul className="tree-level" role="group">
          {kids.map((kid) => (
            <TreeItem
              key={kid.id}
              page={kid}
              children={children}
              depth={depth + 1}
              selected={selected}
              closed={closed}
              drag={drag}
              pointer={pointer}
              onToggle={onToggle}
              onCreate={onCreate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
