import { useEffect, useRef, useState } from "react";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { type InlineFormat, formatState } from "../commands.ts";
import type { PageEditor } from "../editor.ts";
import { BLOCKS } from "./blocks.ts";
import { type Line, placeToolbar, showRow } from "../placement.ts";
import { useMenuPlacement } from "./position.ts";

const INLINE: { format: InlineFormat; label: string; icon: string; shortcut?: string }[] = [
  { format: "bold", label: "Bold", icon: "B", shortcut: "⌘B" },
  { format: "italic", label: "Italic", icon: "I", shortcut: "⌘I" },
  { format: "strikethrough", label: "Strikethrough", icon: "S" },
  { format: "code", label: "Code", icon: "</>", shortcut: "⌘E" },
];

// Buttons must not take focus from the editor, or the selection disappears.
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

/** Formatting toolbar shown above a text selection. */
export function SelectionToolbar({ editor, container }: {
  editor: PageEditor;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const { view, commands } = editor;
  const { selection } = view.state;
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const turnIntoMenu = useRef<HTMLDivElement>(null);
  const format = formatState(view.state);

  const visible =
    !selection.empty &&
    selection instanceof TextSelection &&
    !format.inCode &&
    (view.hasFocus() || linkDraft !== null);

  // Close the sub-menus when the toolbar goes away or the selection moves.
  const selectionKey = `${selection.from}-${selection.to}`;
  useEffect(() => {
    setTurnIntoOpen(false);
  }, [selectionKey]);
  useEffect(() => {
    if (!visible) setLinkDraft(null);
  }, [visible]);
  // The block's own kind is marked in the menu: keep it in view when the menu scrolls.
  useEffect(() => {
    if (turnIntoOpen) showRow(turnIntoMenu.current, turnIntoMenu.current?.querySelector(".active"));
  }, [turnIntoOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (linkDraft !== null) linkInput.current?.focus();
  }, [linkDraft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inside the window: below the selection when there's no room above it,
  // and the Turn into menu above its button when there's none below.
  useMenuPlacement(toolbar, visible ? () => firstLine(view, selection.from, selection.to) : null, placeToolbar);
  useMenuPlacement(turnIntoMenu, turnIntoOpen ? () => turnIntoMenu.current!.previousElementSibling!.getBoundingClientRect() : null);

  if (!visible || !container.current) return null;
  const current = BLOCKS.find((b) => b.format === format.block);

  const applyLink = (href: string) => {
    commands.setLink(href.trim());
    setLinkDraft(null);
    view.focus();
  };

  return (
    <div ref={toolbar} className="page-toolbar" role="toolbar" aria-label="Formatting">
      {linkDraft !== null ? (
        <form
          className="page-toolbar-link"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink(linkDraft);
          }}
        >
          <input
            ref={linkInput}
            // Text, not type="url": that silently refuses "example.com" or a link to a page.
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="Paste or type a link"
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setLinkDraft(null);
                view.focus();
              }
            }}
          />
          <button type="submit">Apply</button>
          {format.link && (
            <button type="button" onClick={() => applyLink("")}>
              Remove
            </button>
          )}
        </form>
      ) : (
        <>
          <div className="page-toolbar-group">
            <button
              type="button"
              className="page-toolbar-turn-into"
              aria-haspopup="menu"
              aria-expanded={turnIntoOpen}
              onMouseDown={keepFocus}
              onClick={() => setTurnIntoOpen((open) => !open)}
            >
              {current?.label ?? "Turn into"} <span aria-hidden>▾</span>
            </button>
            {turnIntoOpen && (
              <div ref={turnIntoMenu} className="page-menu page-toolbar-menu" role="menu">
                {BLOCKS.filter((b) => b.turnInto).map((block) => (
                  <button
                    key={block.format}
                    type="button"
                    role="menuitem"
                    className={block.format === format.block ? "active" : undefined}
                    onMouseDown={keepFocus}
                    onClick={() => {
                      commands.setBlock(block.format);
                      setTurnIntoOpen(false);
                    }}
                  >
                    <span className="page-menu-icon">{block.icon}</span>
                    {block.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="page-toolbar-separator" />
          {INLINE.map(({ format: f, label, icon, shortcut }) => (
            <button
              key={f}
              type="button"
              className={`page-toolbar-${f}${format.inline.has(f) ? " active" : ""}`}
              aria-label={label}
              aria-pressed={format.inline.has(f)}
              title={shortcut ? `${label} (${shortcut})` : label}
              onMouseDown={keepFocus}
              onClick={() => commands.toggle(f)}
            >
              {icon}
            </button>
          ))}
          <button
            type="button"
            className={format.link ? "active" : undefined}
            aria-label="Link"
            title="Link"
            onMouseDown={keepFocus}
            onClick={() => setLinkDraft(format.link ?? "")}
          >
            Link
          </button>
        </>
      )}
    </div>
  );
}

/** The selection's first line, from where it starts to where it ends on that line. */
function firstLine(view: EditorView, from: number, to: number): Line {
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  const sameLine = Math.abs(start.top - end.top) < 4;
  return { left: start.left, right: sameLine ? end.left : start.left, top: Math.min(start.top, end.top), bottom: start.bottom };
}
