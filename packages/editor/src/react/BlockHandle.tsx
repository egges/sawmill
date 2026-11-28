import { useEffect, useRef, useState } from "react";
import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { type Block, type DropTarget, blockStartingAt, setDragging } from "../blocks.ts";
import type { PageEditor } from "../editor.ts";
import { imageBlock } from "../images.ts";
import { BlockMenu } from "./BlockMenu.tsx";
import { DropLine } from "./DropLine.tsx";
import { GUTTER, MARKER, blockElement, blockFromPoint, dropTargetAt } from "./geometry.ts";
import { GripIcon, PlusIcon } from "./icons.tsx";

/** Width of "+" and the grip together, and the gap to the block. */
const HANDLE_WIDTH = 44;
const HANDLE_HEIGHT = 24;
/** Pixels the pointer moves before a press on the grip (or an image) becomes a drag. */
const DRAG_THRESHOLD = 4;

interface Drag {
  block: Block;
  startX: number;
  startY: number;
  pointerId: number;
  started: boolean;
  /** What a press that never became a drag does. */
  onClick: () => void;
}

/** Vertical middle of the block's first line, in client coordinates. */
function firstLineMiddle(element: HTMLElement): number {
  const text = element.matches("p, h1, h2, h3, h4, h5, h6, pre")
    ? element
    : element.querySelector<HTMLElement>("p, h1, h2, h3, h4, h5, h6, pre, th, td");
  const box = element.getBoundingClientRect();
  if (!text) return box.top + box.height / 2;
  const style = getComputedStyle(text);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6 || HANDLE_HEIGHT;
  return text.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + lineHeight / 2;
}

/** Where the handle goes for `block`, relative to the container. */
function handlePosition(view: EditorView, container: HTMLElement, block: Block) {
  const element = blockElement(view, block);
  if (!element) return null;
  const box = container.getBoundingClientRect();
  const isItem = block.node.type.name === "list_item";
  const left = isItem ? element.getBoundingClientRect().left - MARKER : view.dom.getBoundingClientRect().left;
  return { left: left - HANDLE_WIDTH - box.left, top: firstLineMiddle(element) - HANDLE_HEIGHT / 2 - box.top };
}

/** A copy of a block that follows the pointer while it's dragged, as in Notion. */
interface Ghost {
  element: HTMLElement;
  /** Where the pointer is from the copy's top left. */
  dx: number;
  dy: number;
}

/** Copies the block's element into a faded box that follows the pointer, inside the editor's container so the page's styles apply. */
function createGhost(view: EditorView, container: HTMLElement, block: Block, x: number, y: number): Ghost | null {
  const element = blockElement(view, block);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const copy = element.cloneNode(true) as HTMLElement;
  copy.classList.remove("page-block-dragging", "ProseMirror-selectednode");
  const content = document.createElement("div");
  content.className = "ProseMirror";
  content.append(copy);
  const ghost = document.createElement("div");
  ghost.className = "page-block-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${rect.width}px`;
  ghost.append(content);
  container.append(ghost);
  const result = { element: ghost, dx: x - rect.left, dy: y - rect.top };
  moveGhost(result, x, y);
  return result;
}

function moveGhost(ghost: Ghost, x: number, y: number) {
  ghost.element.style.transform = `translate(${x - ghost.dx}px, ${y - ghost.dy}px)`;
}

/** The element that scrolls the page, for scrolling while dragging near its edges. */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let el: HTMLElement | null = element.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * The "+" and grip shown left of the block under the pointer, as in Notion.
 * "+" adds a block below (⌥: above) and opens the block menu; dragging the
 * grip moves the block; clicking it selects the block and opens its menu.
 * An image on its own line moves the same way when it's dragged itself.
 */
export function BlockHandle({ editor, container }: {
  editor: PageEditor;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const { view, commands } = editor;
  const [hovered, setHovered] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const handle = useRef<HTMLDivElement>(null);
  const [drop, setDropState] = useState<DropTarget | null>(null);
  // For the window's pointer listeners, which outlive a render.
  const dropRef = useRef<DropTarget | null>(null);
  const setDrop = (target: DropTarget | null) => {
    dropRef.current = target;
    setDropState(target);
  };
  const [dragging, setDraggingState] = useState(false);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const ghost = useRef<Ghost | null>(null);
  // Never leave a copy behind (the page closed mid-drag).
  useEffect(() => () => ghost.current?.element.remove(), []);
  const frozen = menuOpen || dragging;
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  // Follow the pointer over the page and its gutter.
  useEffect(() => {
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (frozenRef.current || frame || !view.dom.isConnected) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const { x, y } = pointer.current;
        const box = view.dom.getBoundingClientRect();
        const near = y >= box.top - 8 && y <= box.bottom + 8 && x >= box.left - GUTTER && x <= box.right + 24;
        const block = near ? blockFromPoint(view, x, y) : null;
        // Not on a conflict block's bars: they aren't blocks to move or add after.
        const bar = block && blockElement(view, block)?.classList.contains("page-conflict-bar");
        setHovered(block && !bar ? block.pos : null);
      });
    };
    // Typing hides it until the pointer moves again.
    const onKey = () => !frozenRef.current && setHovered(null);
    window.addEventListener("mousemove", onMove);
    view.dom.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      view.dom.removeEventListener("keydown", onKey);
    };
  }, [view]);

  const block = hovered === null ? null : blockStartingAt(view.state.doc, hovered);
  // The doc changed under a remembered block (or it's gone): close the menu.
  useEffect(() => {
    if (!block && menuOpen) setMenuOpen(false);
  }, [block === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll while dragging near the top or bottom of the page.
  useEffect(() => {
    if (!dragging) return;
    const scroller = scrollParent(view.dom);
    let frame = requestAnimationFrame(function step() {
      const { y } = pointer.current;
      const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const edge = 48;
      const speed = y < box.top + edge ? -(box.top + edge - y) / 3 : y > box.bottom - edge ? (y - (box.bottom - edge)) / 3 : 0;
      if (speed) {
        scroller.scrollTop += Math.max(-20, Math.min(20, speed));
        updateDrop();
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }); // re-armed each render while dragging; cheap

  // Esc cancels a drag.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const updateDrop = () => {
    const current = drag.current;
    if (!current?.started) return;
    const { x, y } = pointer.current;
    setDrop(dropTargetAt(view, x, y, current.block));
  };

  const endDrag = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    ghost.current?.element.remove();
    ghost.current = null;
    if (current.started) {
      view.dispatch(setDragging(view.state.tr, null));
      setDraggingState(false);
      const target = dropRef.current;
      setDrop(null);
      if (commit && target) {
        // Positions may have shifted if the page changed during the drag.
        const now = blockStartingAt(view.state.doc, current.block.pos);
        if (now && now.node.eq(current.block.node)) commands.moveBlockTo(now, target.pos);
      }
      view.focus();
    }
  };

  const startPress = (block: Block, event: { clientX: number; clientY: number; pointerId: number }, onClick: () => void) => {
    drag.current = { block, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, started: false, onClick };
  };

  const onPressMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (!current.started) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return;
      current.started = true;
      // Copy it before it's faded.
      if (container.current) ghost.current = createGhost(view, container.current, current.block, event.clientX, event.clientY);
      setMenuOpen(false);
      setDraggingState(true);
      view.dispatch(setDragging(view.state.tr, current.block.pos));
    }
    if (ghost.current) moveGhost(ghost.current, event.clientX, event.clientY);
    updateDrop();
  };

  const onPressUp = (event: PointerEvent) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.started) return endDrag(true);
    drag.current = null;
    current.onClick();
  };

  // A press is followed on the window, so it works wherever it started (the
  // grip, an image) and wherever the pointer goes.
  const press = useRef({ move: onPressMove, up: onPressUp, cancel: () => endDrag(false) });
  press.current = { move: onPressMove, up: onPressUp, cancel: () => endDrag(false) };
  useEffect(() => {
    const move = (e: PointerEvent) => press.current.move(e);
    const up = (e: PointerEvent) => press.current.up(e);
    const cancel = () => press.current.cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  // Dragging an image on its own line moves its block; clicking selects it.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const found = event.button === 0 ? imageBlock(view, event.target) : null;
      if (!found) return;
      // No text selection, no native drag of the image.
      event.preventDefault();
      startPress(found.block, event, () => {
        const now = imageBlock(view, event.target);
        if (now) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, now.pos)));
        view.focus();
      });
    };
    view.dom.addEventListener("pointerdown", onDown);
    return () => view.dom.removeEventListener("pointerdown", onDown);
  }, [view]);

  const onGripDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !block) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startPress(block, event, () => openMenu());
  };

  const openMenu = () => {
    if (!block) return;
    commands.selectBlock(block);
    setMenuOpen(true);
  };

  const add = (event: React.MouseEvent) => {
    if (!block) return;
    commands.insertBlock(block, { above: event.altKey, text: "/" });
    view.focus();
  };

  if (!container.current) return null;
  const position = block && handlePosition(view, container.current, block);

  return (
    <>
      {block && position && (<div
        ref={handle}
        className={`page-block-handle${frozen ? " active" : ""}`}
        style={{ left: position.left, top: position.top }}
        // Never take focus or the selection from the editor.
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          className="page-block-add"
          aria-label="Add a block below"
          title={"Click to add a block below\n⌥-click to add one above"}
          onClick={add}
        >
          <PlusIcon size={16} />
        </button>
        <button
          type="button"
          className="page-block-grip"
          aria-label="Block menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={"Drag to move\nClick for options"}
          onPointerDown={onGripDown}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openMenu();
            }
          }}
        >
          <GripIcon size={16} />
        </button>
      </div>)}
      {drop && <DropLine view={view} container={container.current} target={drop} />}
      {block && position && menuOpen && (
        <BlockMenu
          editor={editor}
          block={block}
          anchor={() => handle.current!.getBoundingClientRect()}
          onClose={() => {
            setMenuOpen(false);
            view.focus();
          }}
        />
      )}
    </>
  );
}
