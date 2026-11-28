import { useEffect, useRef, useState } from "react";
import { type Block, blockStartingAt, focusBlock, moveBlockStep } from "../blocks.ts";
import { formatState } from "../commands.ts";
import type { PageEditor } from "../editor.ts";
import { BLOCKS } from "./blocks.ts";
import { placeBeside, showRow } from "../placement.ts";
import { type Line, useMenuPlacement } from "./position.ts";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, CopyIcon, DuplicateIcon, TrashIcon, TurnIntoIcon } from "./icons.tsx";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl+";
const SHIFT = MAC ? "⇧" : "Shift+";

/** Blocks "Turn into" works on: ones made of text. */
const TURNABLE = new Set(["paragraph", "heading", "list_item", "toggle", "blockquote", "code_block"]);

interface Action {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/** What the grip's menu does to a block: turn into, duplicate, copy, move, delete. */
export function BlockMenu({ editor, block, anchor, onClose }: {
  editor: PageEditor;
  block: Block;
  /** Where the block's handle is, in window coordinates: the menu opens below it, or above. */
  anchor: () => Line;
  onClose: () => void;
}) {
  const { view, commands } = editor;
  const menu = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [turnInto, setTurnInto] = useState<number | null>(null); // active row in the submenu, when open

  const current = () => blockStartingAt(view.state.doc, block.pos) ?? block;
  const canTurn = TURNABLE.has(block.node.type.name) && (block.node.type.name !== "heading" || block.node.attrs.level <= 3);
  // The block's type as the menus name it: read as if the cursor were inside it.
  const inside = canTurn ? focusBlock(view.state, block) : null;
  const format = inside ? formatState(view.state.apply(inside)).block : null;
  const turnOptions = BLOCKS.filter((b) => b.turnInto);
  // The submenu opens on the block's own kind, as Notion's does.
  const currentOption = Math.max(0, turnOptions.findIndex((b) => b.format === format));

  const done = (run: () => void) => () => {
    run();
    onClose();
  };
  const actions: Action[] = [
    ...(canTurn
      ? [{ id: "turnInto", label: "Turn into", icon: <TurnIntoIcon />, run: () => setTurnInto(currentOption) }]
      : []),
    { id: "duplicate", label: "Duplicate", icon: <DuplicateIcon />, shortcut: `${MOD}D`, run: done(() => commands.duplicateBlock(current())) },
    { id: "copy", label: "Copy", icon: <CopyIcon />, shortcut: `${MOD}C`, run: done(() => copyBlock(editor, current())) },
    {
      id: "up",
      label: "Move up",
      icon: <ArrowUpIcon />,
      shortcut: `${MOD}${SHIFT}↑`,
      disabled: !moveBlockStep(view.state, block, -1),
      run: done(() => commands.moveBlock(current(), -1)),
    },
    {
      id: "down",
      label: "Move down",
      icon: <ArrowDownIcon />,
      shortcut: `${MOD}${SHIFT}↓`,
      disabled: !moveBlockStep(view.state, block, 1),
      run: done(() => commands.moveBlock(current(), 1)),
    },
    { id: "delete", label: "Delete", icon: <TrashIcon />, shortcut: "Del", danger: true, run: done(() => commands.deleteBlock(current())) },
  ];

  // Both inside the window. The submenu goes beside its row, on the side with room.
  useMenuPlacement(menu, anchor);
  useMenuPlacement(submenu, turnInto !== null ? () => submenu.current!.parentElement!.getBoundingClientRect() : null, placeBeside);

  useEffect(() => {
    // Placed already, so focusing it doesn't scroll the page.
    menu.current?.focus({ preventScroll: true });
  }, []);

  // Keep the active row in view: the submenu scrolls when it's taller than the window.
  useEffect(() => {
    const submenu = menu.current?.querySelector(".page-block-submenu");
    const row = submenu?.querySelector(".active") ?? submenu?.querySelector('[aria-checked="true"]');
    showRow(submenu, row);
  }, [turnInto]);

  // Clicking anywhere else closes it.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const turn = (index: number) => {
    const option = turnOptions[index];
    if (!option) return;
    commands.turnBlockInto(current(), option.format);
    onClose();
  };

  const step = (from: number, by: number, length: number, skip: (i: number) => boolean) => {
    let i = from;
    for (let n = 0; n < length; n++) {
      i = (i + by + length) % length;
      if (!skip(i)) return i;
    }
    return from;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const inSub = turnInto !== null;
    const length = inSub ? turnOptions.length : actions.length;
    const skip = (i: number) => !inSub && !!actions[i].disabled;
    const at = inSub ? turnInto : active;
    const set = inSub ? setTurnInto : setActive;
    switch (event.key) {
      case "ArrowDown":
        set(step(at, 1, length, skip));
        break;
      case "ArrowUp":
        set(step(at, -1, length, skip));
        break;
      case "ArrowRight":
        if (!inSub && actions[active]?.id === "turnInto") setTurnInto(currentOption);
        break;
      case "ArrowLeft":
        if (inSub) setTurnInto(null);
        break;
      case "Enter":
      case " ":
        if (inSub) turn(turnInto);
        else if (!actions[active].disabled) actions[active].run();
        break;
      case "Escape":
        if (inSub) setTurnInto(null);
        else onClose();
        break;
      case "Backspace":
      case "Delete":
        if (!inSub) actions.find((a) => a.id === "delete")!.run();
        break;
      default:
        // ⌘D and ⌘C work here too.
        if ((MAC ? event.metaKey : event.ctrlKey) && (event.key === "d" || event.key === "c")) {
          actions.find((a) => a.id === (event.key === "d" ? "duplicate" : "copy"))!.run();
          break;
        }
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={menu}
      className="page-menu page-block-menu"
      role="menu"
      aria-label="Block"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {actions.map((action, index) => (
        <div key={action.id} className="page-block-menu-row">
          <button
            type="button"
            role="menuitem"
            className={[index === active && turnInto === null ? "active" : "", action.danger ? "danger" : ""].join(" ").trim() || undefined}
            disabled={action.disabled}
            aria-haspopup={action.id === "turnInto" ? "menu" : undefined}
            aria-expanded={action.id === "turnInto" ? turnInto !== null : undefined}
            onMouseEnter={() => {
              setActive(index);
              setTurnInto(action.id === "turnInto" ? (turnInto ?? -1) : null);
            }}
            onClick={action.run}
          >
            <span className="page-block-menu-icon">{action.icon}</span>
            <span className="page-menu-label">{action.label}</span>
            {action.shortcut && <kbd>{action.shortcut}</kbd>}
            {action.id === "turnInto" && <ChevronRightIcon size={14} />}
          </button>
          {action.id === "turnInto" && turnInto !== null && (
            <div ref={submenu} className="page-menu page-block-submenu" role="menu" aria-label="Turn into">
              {turnOptions.map((option, i) => (
                <button
                  key={option.format}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.format === format}
                  className={i === turnInto ? "active" : undefined}
                  onMouseEnter={() => setTurnInto(i)}
                  onClick={() => turn(i)}
                >
                  <span className="page-menu-icon">{option.icon}</span>
                  <span className="page-menu-label">{option.label}</span>
                  {option.format === format && <span className="page-block-menu-current">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Copies the block: as the editor copies a selection (so pasting it into a
 * page keeps its formatting), with its Markdown as the plain text.
 */
function copyBlock(editor: PageEditor, block: Block) {
  const { view, commands } = editor;
  const markdown = commands.blockMarkdown(block);
  commands.selectBlock(block);
  view.focus();
  // Runs after the editor's own copy handler, and replaces its plain text.
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", markdown);
    event.preventDefault();
  };
  window.addEventListener("copy", onCopy);
  try {
    if (!document.execCommand("copy")) void navigator.clipboard?.writeText(markdown);
  } finally {
    window.removeEventListener("copy", onCopy);
  }
}
