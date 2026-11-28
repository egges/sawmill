import { useEffect, useRef, useState } from "react";
import type { LinkRange } from "../commands.ts";
import type { PageEditor } from "../editor.ts";
import { CheckIcon, CopyIcon, LinkIcon, PencilIcon, UnlinkIcon } from "./icons.tsx";
import { useMenuPlacement } from "./position.ts";

/** How long the pointer rests on a link before the box shows, and how long it stays after leaving. */
const SHOW_DELAY = 350;
const HIDE_DELAY = 250;

/**
 * Shown when the pointer rests on a link: its address (click to open), with
 * Copy and Edit. Editing changes the text and the address, or removes the link.
 */
export function LinkPopover({
  editor,
  container,
  onOpen,
}: {
  editor: PageEditor;
  container: React.RefObject<HTMLDivElement | null>;
  onOpen: (href: string) => void;
}) {
  const { view, commands } = editor;
  const [link, setLink] = useState<LinkRange | null>(null);
  const [draft, setDraft] = useState<{ text: string; href: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editing = draft !== null;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const later = (f: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(f, ms);
  };
  const close = () => {
    clearTimeout(timer.current);
    setLink(null);
    setDraft(null);
    setCopied(false);
  };

  // Follow the pointer over links in the page.
  useEffect(() => {
    const dom = view.dom;
    const over = (event: MouseEvent) => {
      if (editingRef.current) return;
      const anchor = (event.target as HTMLElement).closest?.("a[href]");
      if (!anchor || !dom.contains(anchor)) return;
      later(() => {
        if (!anchor.isConnected) return;
        const found = commands.linkAt(view.posAtDOM(anchor, 0));
        setLink(found);
        setCopied(false);
      }, SHOW_DELAY);
    };
    const out = (event: MouseEvent) => {
      if (editingRef.current) return;
      const from = (event.target as HTMLElement).closest?.("a[href]");
      const to = (event.relatedTarget as HTMLElement | null)?.closest?.("a[href]");
      if (from && from !== to) later(() => setLink(null), HIDE_DELAY);
    };
    dom.addEventListener("mouseover", over);
    dom.addEventListener("mouseout", out);
    return () => {
      dom.removeEventListener("mouseover", over);
      dom.removeEventListener("mouseout", out);
      clearTimeout(timer.current);
    };
  }, [view, commands]);

  // The page changed under the box (typing, a sync): positions may be stale.
  const doc = view.state.doc;
  const shownFor = useRef(doc);
  useEffect(() => {
    if (shownFor.current !== doc && !editingRef.current) setLink(null);
    shownFor.current = doc;
  }, [doc]);

  const input = useRef<HTMLInputElement>(null); // the address field, focused when editing starts
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) return;
    input.current?.select();
    // A click anywhere else cancels the edit.
    const outside = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", outside, true);
    return () => document.removeEventListener("mousedown", outside, true);
  }, [editing]);

  // Inside the window: above the link when there's no room below it.
  useMenuPlacement(box, link ? () => view.coordsAtPos(link.from) : null);

  if (!link || !container.current) return null;
  // Check it's still a link where we think it is.
  const current = commands.linkAt(link.from);
  if (!current) return null;

  const apply = (href: string, text?: string) => {
    commands.updateLinkAt(current.from, href.trim(), text);
    close();
    view.focus();
  };
  const cancel = () => {
    close();
    view.focus();
  };
  const onFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div
      ref={box}
      className="page-link-popover"
      role="dialog"
      aria-label="Link"
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={() => !editing && later(close, HIDE_DELAY)}
    >
      {editing ? (
        <form
          className="page-link-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft.href, draft.text);
          }}
        >
          <label>
            <span>Text</span>
            <input
              aria-label="Link text"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onKeyDown={onFieldKey}
            />
          </label>
          <label>
            <span>Link</span>
            <input
              ref={input}
              // Text, not type="url": that silently refuses "example.com" or a link to a page.
              type="text"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              aria-label="Link address"
              placeholder="Paste or type a link"
              value={draft.href}
              onChange={(e) => setDraft({ ...draft, href: e.target.value })}
              onKeyDown={onFieldKey}
            />
          </label>
          <div className="page-link-form-actions">
            <button type="button" className="page-link-remove" title="Remove link" onClick={() => apply("")}>
              <UnlinkIcon />
              Remove link
            </button>
            <button type="submit" className="page-link-save">
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <a
            className="page-link-address"
            href={current.href}
            title={`Open ${current.href}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen(current.href);
              close();
            }}
          >
            <LinkIcon size={13} />
            <span>{current.href}</span>
          </a>
          <span className="page-toolbar-separator" />
          <button
            type="button"
            className="page-link-icon"
            aria-label={copied ? "Copied" : "Copy link"}
            title={copied ? "Copied" : "Copy link"}
            onClick={() => {
              void navigator.clipboard?.writeText(current.href).then(() => setCopied(true));
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            type="button"
            className="page-link-icon"
            aria-label="Edit link"
            title="Edit link"
            onClick={() => setDraft({ text: view.state.doc.textBetween(current.from, current.to), href: current.href })}
          >
            <PencilIcon />
          </button>
        </>
      )}
    </div>
  );
}
