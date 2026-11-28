// How a code block is drawn: the code, with a language menu (searchable) and
// a copy button that show when you point at it.
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import { chooseLanguage } from "./auto.ts";
import { detected } from "./highlight.ts";
import { LANGUAGES, findLanguage } from "./languages.ts";
import { placeMenu, showRow, windowSize } from "../placement.ts";

const svg = (body: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const COPY_ICON = svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>');
const CHECK_ICON = svg('<path d="M20 6 9 17l-5-5"/>');
const CHEVRON_ICON = svg('<path d="m6 9 6 6 6-6"/>', 12);
const SEARCH_ICON = svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 13);

/** One row in the language menu. */
interface Choice {
  value: string;
  label: string;
  hint?: string;
  /** Lowercase names to search: label, id and fence aliases. */
  names: string[];
}

/**
 * The choices matching `query`, best first: names that start with it, then
 * names that contain it. An empty query lists everything in menu order.
 */
export function filterChoices(choices: Choice[], query: string): Choice[] {
  const q = query.trim().toLowerCase();
  if (!q) return choices;
  const rank = (c: Choice) => {
    if (c.names.some((n) => n === q)) return 0;
    if (c.names.some((n) => n.startsWith(q))) return 1;
    if (c.names.some((n) => n.includes(q))) return 2;
    return -1;
  };
  return choices
    .map((choice, i) => ({ choice, i, r: rank(choice) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.choice);
}

export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private pre: HTMLElement;
  private header: HTMLElement;
  private button: HTMLButtonElement;
  private menu: HTMLElement | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private node: Node,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement("div");
    this.dom.className = "page-code-block";

    this.header = doc.createElement("div");
    this.header.className = "page-code-header";
    this.header.contentEditable = "false";

    this.button = doc.createElement("button");
    this.button.type = "button";
    this.button.className = "page-code-language";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.addEventListener("mousedown", (e) => e.preventDefault());
    this.button.addEventListener("click", () => (this.menu ? this.closeMenu() : this.openMenu()));

    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "page-code-copy";
    copy.title = "Copy code";
    copy.setAttribute("aria-label", "Copy code");
    copy.innerHTML = COPY_ICON;
    copy.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor where it is
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(this.node.textContent).catch(() => {});
      copy.innerHTML = CHECK_ICON;
      copy.classList.add("done");
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        copy.innerHTML = COPY_ICON;
        copy.classList.remove("done");
      }, 1500);
    });

    this.header.append(this.button, copy);
    this.pre = doc.createElement("pre");
    this.contentDOM = doc.createElement("code");
    this.pre.append(this.contentDOM);
    this.dom.append(this.header, this.pre);
    this.render();
  }

  /** The menu's rows: Auto-detect, every language, and the block's own if we don't know it. */
  private choices(): Choice[] {
    const name = this.node.attrs.language as string;
    const guess = name ? null : detected(this.node.textContent);
    const choices: Choice[] = [
      {
        value: "",
        label: "Auto-detect",
        hint: guess ? findLanguage(guess)!.label : undefined,
        names: ["auto-detect", "auto", "detect"],
      },
      ...LANGUAGES.map((l) => ({ value: l.id, label: l.label, names: [l.label.toLowerCase(), l.id, ...l.aliases] })),
    ];
    if (name && !findLanguage(name)) choices.push({ value: name, label: name, names: [name.toLowerCase()] });
    return choices;
  }

  /** The value of the menu row for the block's language. */
  private current(): string {
    const name = this.node.attrs.language as string;
    return name ? (findLanguage(name)?.id ?? name) : "";
  }

  private openMenu() {
    const doc = this.dom.ownerDocument;
    const menu = doc.createElement("div");
    menu.className = "page-code-menu";
    const search = doc.createElement("label");
    search.className = "page-code-search";
    search.innerHTML = SEARCH_ICON;
    const input = doc.createElement("input");
    input.placeholder = "Search languages";
    input.setAttribute("aria-label", "Search languages");
    input.spellcheck = false;
    input.autocomplete = "off";
    search.append(input);
    const list = doc.createElement("div");
    list.className = "page-code-options";
    list.setAttribute("role", "listbox");
    menu.append(search, list);

    const all = this.choices();
    const current = this.current();
    let shown = all;
    let active = Math.max(0, all.findIndex((c) => c.value === current));

    const draw = () => {
      list.replaceChildren(
        ...shown.map((choice, i) => {
          const row = doc.createElement("div");
          row.className = "page-code-option" + (i === active ? " active" : "") + (choice.value === current ? " selected" : "");
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", String(choice.value === current));
          row.dataset.value = choice.value;
          const label = doc.createElement("span");
          label.textContent = choice.label;
          row.append(label);
          if (choice.hint) {
            const hint = doc.createElement("span");
            hint.className = "page-code-hint";
            hint.textContent = choice.hint;
            row.append(hint);
          }
          if (choice.value === current) row.insertAdjacentHTML("beforeend", CHECK_ICON);
          row.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
          row.addEventListener("mousemove", () => {
            if (active !== i) {
              active = i;
              draw();
            }
          });
          row.addEventListener("click", () => this.choose(choice.value));
          return row;
        }),
      );
      if (!shown.length) {
        const empty = doc.createElement("div");
        empty.className = "page-code-empty";
        empty.textContent = "No language found";
        list.append(empty);
      }
      showRow(list, list.querySelector(".active"));
    };

    input.addEventListener("input", () => {
      shown = filterChoices(all, input.value);
      active = 0;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (shown.length) active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
        draw();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (shown[active]) this.choose(shown[active].value);
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        this.closeMenu();
        this.view.focus();
      }
    });
    input.addEventListener("blur", () => this.closeMenu());

    this.menu = menu;
    this.header.append(menu);
    this.dom.classList.add("menu-open");
    this.button.setAttribute("aria-expanded", "true");
    draw();
    placeLanguageMenu(menu, list, this.header);
    input.focus({ preventScroll: true });
  }

  private closeMenu() {
    if (!this.menu) return;
    const menu = this.menu;
    this.menu = null;
    menu.remove();
    this.dom.classList.remove("menu-open");
    this.button.setAttribute("aria-expanded", "false");
  }

  private choose(language: string) {
    this.closeMenu();
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(chooseLanguage(this.view.state.tr, pos, language));
    this.view.focus();
  }

  /** Shows the block's language on the button (and on the element, for styling). */
  private render() {
    const name = this.node.attrs.language as string;
    const known = name ? findLanguage(name) : undefined;
    const guess = name ? null : detected(this.node.textContent);
    const label = known?.label ?? (name || (guess ? findLanguage(guess)!.label : "Auto-detect"));
    this.button.innerHTML = "";
    const text = this.dom.ownerDocument.createElement("span");
    text.textContent = label;
    this.button.append(text);
    if (!name && guess) {
      const auto = this.dom.ownerDocument.createElement("span");
      auto.className = "page-code-hint";
      auto.textContent = "auto";
      this.button.append(auto);
    }
    this.button.insertAdjacentHTML("beforeend", CHEVRON_ICON);
    this.button.title = "Change language";
    this.button.setAttribute("aria-label", `Language: ${label}`);
    if (name) this.pre.dataset.language = name;
    else delete this.pre.dataset.language;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.header.contains(event.target as HTMLElement);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    if (mutation.type === "selection") return false;
    return this.header.contains(mutation.target) || (mutation.type === "attributes" && (mutation.target === this.pre || mutation.target === this.dom));
  }

  destroy() {
    clearTimeout(this.copyTimer);
    this.closeMenu();
  }
}

export const codeBlockView = $view(codeBlockSchema.node, () => (node, view, getPos) => new CodeBlockView(node, view, getPos));

/**
 * Keeps the language menu inside the window: below the header when it
 * fits, else above it (growing upwards as the search narrows the list),
 * else shorter. Decided once, with every language listed.
 */
function placeLanguageMenu(menu: HTMLElement, list: HTMLElement, header: HTMLElement) {
  const line = header.getBoundingClientRect();
  const place = placeMenu(line, { width: menu.offsetWidth, height: menu.offsetHeight }, windowSize(header.ownerDocument));
  menu.classList.toggle("above", place.top < line.top);
  if (place.maxHeight !== null) {
    // The search field stays; the list gets what's left.
    list.style.maxHeight = `${Math.max(place.maxHeight - (menu.offsetHeight - list.offsetHeight), 60)}px`;
  }
}
