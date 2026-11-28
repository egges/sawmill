// What the board view does with rows, kept apart from React so it can be
// tested: which columns a board can group by, the lanes, the order of the
// cards and where a dropped one goes, and what a card shows.
import type { CellValue, Column, Database, Row, View } from "./api.ts";
import { cellText, fits, optionTone } from "./databases.ts";
import { dropPositions as placeBetween } from "./positions.ts";

/** Columns a board can group by: one lane per choice, or checked and not. */
export function groupableColumns(columns: Column[]): Column[] {
  return columns.filter((c) => c.type === "select" || c.type === "checkbox");
}

/** The column the board groups by: the view's, else the first that can. */
export function boardColumn(database: Database, view: View): Column | null {
  const groupable = groupableColumns(database.columns);
  return groupable.find((c) => c.id === view.groupBy) ?? groupable[0] ?? null;
}

export interface Lane {
  /** Stable across renders: "" for the empty lane. */
  key: string;
  /** What a card dropped in this lane gets; null empties the cell. */
  value: CellValue | null;
  label: string;
  /** The choice's colour, for select lanes. */
  tone: number | null;
  rows: Row[];
}

/**
 * The board's lanes, cards in row order. A select column gets a lane per
 * choice, and one per value that isn't a choice (a hand edit), so no card
 * is hidden; cards without a value (or with a value of another type) go in
 * a "No <column>" lane first, shown only when it has cards, like Notion. A
 * checkbox column gets "Not checked" and "Checked".
 */
export function lanes(rows: Row[], column: Column): Lane[] {
  if (column.type === "checkbox") {
    const checked = (r: Row) => r.cells[column.id] === true;
    return [
      { key: "", value: null, label: "Not checked", tone: null, rows: rows.filter((r) => !checked(r)) },
      { key: "true", value: true, label: "Checked", tone: null, rows: rows.filter(checked) },
    ];
  }
  const empty: Lane = { key: "", value: null, label: `No ${column.name}`, tone: null, rows: [] };
  const byValue = new Map<string, Lane>();
  const lane = (value: string) => ({
    key: `=${value}`,
    value,
    label: value,
    tone: optionTone(value, column.options),
    rows: [] as Row[],
  });
  for (const option of column.options) byValue.set(option, lane(option));
  for (const row of rows) {
    const value = row.cells[column.id];
    if (typeof value !== "string" || value === "") {
      empty.rows.push(row);
      continue;
    }
    if (!byValue.has(value)) byValue.set(value, lane(value));
    byValue.get(value)!.rows.push(row);
  }
  return [...(empty.rows.length ? [empty] : []), ...byValue.values()];
}

/**
 * A row's sort key in a view ordered by hand: where it was last dropped in
 * that view, else its place in the database (the time it was added), so a
 * card that was never dragged sits where its row does, and a new one comes
 * last.
 */
function orderKey(row: Row, view: string): number {
  return row.positions[view] ?? row.position ?? Infinity;
}

/** Rows in a view's own order. `rows` are in the database's order, which settles ties. */
export function viewOrder(rows: Row[], view: string): Row[] {
  const key = new Map(rows.map((r) => [r.id, orderKey(r, view)]));
  return [...rows].sort((a, b) => {
    const [ka, kb] = [key.get(a.id)!, key.get(b.id)!];
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** The positions that put `row` before the card at `index` of a lane's other `cards` (see positions.ts). */
export function dropPositions(cards: Row[], index: number, row: Row, view: string): Record<string, number> {
  return placeBetween(cards, index, row, (r) => orderKey(r, view));
}

/** The column whose cell is a card's title: the title column, which every database has. */
export function titleColumn(columns: Column[]): Column | null {
  return columns.find((c) => c.type === "title") ?? null;
}

/** What a card shows besides its title: the other columns that have a value, in order. */
export function cardFields(row: Row, columns: Column[], hide: (string | undefined)[]): { column: Column; value: unknown }[] {
  return columns
    .filter((c) => !hide.includes(c.id))
    .map((column) => ({ column, value: row.cells[column.id] }))
    .filter(({ column, value }) => {
      if (value === undefined || value === null || value === "") return false;
      // An unticked box is the default: nothing to show.
      return !(column.type === "checkbox" && value === false);
    });
}

/** A card field as text: dates the way this device writes them, everything else as stored. */
export function fieldText(column: Column, value: unknown): string {
  if (column.type === "date" && typeof value === "string" && fits("date", value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  if (column.type === "number" && typeof value === "number") return value.toLocaleString();
  return cellText(value);
}

/** A name for a new view that no other view has: "Board", "Board 2", ... */
export function newViewName(views: View[], base: string): string {
  const taken = new Set(views.map((v) => v.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A position after every view. */
export function nextViewPosition(views: View[]): number {
  return Math.floor(Math.max(-1, ...views.map((v) => v.position ?? -1))) + 1;
}
