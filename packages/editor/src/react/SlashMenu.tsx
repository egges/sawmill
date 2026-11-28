import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { slashState } from "../commands.ts";
import type { PageEditor } from "../editor.ts";
import { matchBlocks } from "./blocks.ts";
import { showRow } from "../placement.ts";
import { useMenuPlacement } from "./position.ts";
import type { KeyHandler } from "./PageEditorView.tsx";

/** Block menu shown when "/" is typed at the start of an empty line. */
export function SlashMenu({ editor, container, keyHandler }: {
  editor: PageEditor;
  container: React.RefObject<HTMLDivElement | null>;
  keyHandler: React.RefObject<KeyHandler>;
}) {
  const { view, commands } = editor;
  const slash = view.hasFocus() ? slashState(view.state) : null;
  const items = slash ? matchBlocks(slash.query) : [];
  const [active, setActive] = useState(0);
  // Escape closes the menu until the "/" it was opened for is gone.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const open = slash !== null && items.length > 0 && dismissedAt !== slash.from;
  const query = slash?.query;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!slash) setDismissedAt(null);
  }, [slash === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    showRow(list.current, list.current?.querySelector(".active"));
  }, [active]);

  const choose = (index: number) => {
    const item = items[index];
    if (item) commands.runSlash(item.format);
  };

  // Take over the keys the menu needs while it's open.
  useLayoutEffect(() => {
    keyHandler.current = (event) => {
      if (!open) return false;
      switch (event.key) {
        case "ArrowDown":
          setActive((i) => (i + 1) % items.length);
          return true;
        case "ArrowUp":
          setActive((i) => (i - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab":
          choose(Math.min(active, items.length - 1));
          return true;
        case "Escape":
          setDismissedAt(slash!.from);
          return true;
        default:
          return false;
      }
    };
  });

  // Inside the window: above the line when there's no room below, and so on.
  useMenuPlacement(list, open ? () => view.coordsAtPos(slash.to) : null);

  if (!open || !container.current) return null;

  return (
    <div
      ref={list}
      className="page-menu page-slash-menu"
      role="listbox"
      aria-label="Insert block"
    >
      {items.map((item, index) => (
        <button
          key={item.format}
          type="button"
          role="option"
          aria-selected={index === active}
          className={index === active ? "active" : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(index)}
          onClick={() => choose(index)}
        >
          <span className="page-menu-icon">{item.icon}</span>
          <span className="page-menu-label">{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}
