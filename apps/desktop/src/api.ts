// Typed wrappers for the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkspaceInfo {
  path: string;
  name: string;
  /** This device's name, as it appears with the person's in conflict blocks. Set in Settings. */
  device: string;
  /** What tells this device apart from others with the same name: the app install's id. */
  deviceId: string;
  /** Who new edits here are by, if anyone yet: set in Settings, filled in from GitHub or Git. */
  person: string | null;
  /** Their id, as conflict blocks record it: whose versions are "You". */
  personId: string | null;
  remote: string | null;
  /** Where it's kept besides this device: "Dropbox › Work", "GitHub", ... */
  keptIn: string | null;
  /** The cloud folder the workspace's own folder is in, which damages it. */
  insideCloud: string | null;
  /** Another device moved the workspace somewhere this device can't follow yet. */
  movedTo: MovedTo | null;
}

/** Where another device moved the workspace. */
export interface MovedTo {
  /** "Dropbox › Work", "GitHub", ... */
  label: string;
  /** A folder (offer "Locate…") rather than a Git repository. */
  folder: boolean;
}

/** An installed cloud folder: iCloud Drive, Dropbox, OneDrive, ... */
export interface CloudFolder {
  name: string;
  path: string;
}

/** A workspace found in a cloud folder (a `*.docsync` folder), to join. */
export interface FoundWorkspace {
  name: string;
  path: string;
  /** The cloud folder's name. */
  cloud: string;
}

/** Where a folder is: "Dropbox › Work › Notes.docsync". */
export interface FolderPlace {
  /** The cloud folder it's in, if any. */
  cloud: string | null;
  label: string;
}

export interface CloudFolders {
  folders: CloudFolder[];
  workspaces: FoundWorkspace[];
}

/** A workspace this device knows, for the switcher. */
export interface WorkspaceEntry {
  path: string;
  /** Read fresh when the folder is there, else the name last seen. */
  name: string;
  /** The folder is gone or no longer holds a workspace: offer "Locate…". */
  missing: boolean;
  /** Open in the window now. */
  current: boolean;
  /** Milliseconds since the Unix epoch. */
  lastOpened: number;
}

export interface PageSummary {
  id: string;
  title: string;
  /** Never points at a missing page: orphans come back as top-level pages. */
  parent: string | null;
  /**
   * "database": the page shows a database as a table or board instead of
   * text. "row": a database's row, which is a page too; the sidebar leaves
   * them out, and their parent is the page that shows their database.
   */
  kind: "page" | "database" | "row";
  /** The database a database page shows, once chosen. */
  database: string | null;
  /** Where it was put by hand among the pages next to it; pages without one come after, by name. */
  position: number | null;
}

/** A place in a page's text where a search query appears. */
export interface TextMatch {
  page: string;
  before: string;
  matched: string;
  after: string;
  /** How many times the query appears in the page. */
  count: number;
}

export interface ConflictVersion {
  /** Who wrote it, as plain text: "Anna Smith (Laptop)". */
  label: string;
  /** The same in parts, when the block says: the person, if they were signed in, and their device. */
  person: string | null;
  /** Tells people with the same name apart (see `WorkspaceInfo.personId`). */
  personId: string | null;
  device: string | null;
  /** Tells devices with the same name apart: the app install's id (`WorkspaceInfo.deviceId`). */
  deviceId: string | null;
  text: string;
}

export interface Conflict {
  versions: ConflictVersion[];
}

export interface Page {
  id: string;
  title: string;
  body: string;
  conflicts: Conflict[];
  display: PageDisplay;
  /** Set for a page that shows a database instead of text. */
  database: DatabasePageInfo | null;
  /** Typed properties: a regular page's own, or a row's cells (all but the title). */
  properties: PageProperties;
  /** Set when the page is a row of a database. */
  row: { database: string; name: string } | null;
  /** Opening it moved front matter into the page's metadata, which may have changed its title. */
  metaChanged: boolean;
}

/** A page's properties: columns like a database's, and their values by column id. */
export interface PageProperties {
  columns: Column[];
  values: Record<string, unknown>;
}

/** What a database page shows; see docsync::database_page. */
export interface DatabasePageInfo {
  /** The database; null while the user is choosing one. */
  id: string | null;
  /** False when that database was deleted (here or on another device). */
  exists: boolean;
  /** In tab order; never empty. */
  views: View[];
}

export type ViewType = "table" | "board";

/** One way of looking at a database page's rows. Syncs with the page, so everyone sees the same. */
export interface View {
  id: string;
  name: string;
  type: ViewType;
  position: number | null;
  sort: { column: string; direction: "asc" | "desc" } | null;
  /** The column a board groups its cards by. */
  groupBy: string | null;
}

/** What importing Markdown files and folders created. */
export interface ImportResult {
  /** The pages made for what was chosen; their subpages are inside them. */
  pages: string[];
  pageCount: number;
  /** Images and other files copied into the pages. */
  assetCount: number;
  /** Names of files that couldn't be imported. */
  skipped: string[];
}

/** How a page is shown; null is the default. Syncs with the page. */
export interface PageDisplay {
  /** "full": as wide as the window. */
  width: "full" | null;
  textSize: "small" | "large" | null;
}

export type PageDisplayKey = keyof PageDisplay;

export type WriteResult =
  | { status: "written"; conflicts: Conflict[] }
  | { status: "merged"; page: Page }
  | { status: "gone" };

export type SyncState = "localOnly" | "syncing" | "synced" | "offline" | "noAccess" | "error";

export interface SyncStatus {
  state: SyncState;
  message: string | null;
  /** Milliseconds since the Unix epoch. */
  lastSynced: number | null;
  /** Conflicts the last sync kept both versions of. */
  conflicts: number;
}

/** The GitHub account this device is signed in to. */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** A sign-in code to enter at `verificationUri`. */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
}

/** Where the GitHub App is installed. */
export interface GitHubAccess {
  installed: boolean;
  allRepositories: boolean;
  /** Install it, or choose its repositories. */
  manageUrl: string;
}

/** A workspace on GitHub this device could join. */
export interface RemoteWorkspace {
  /** "ada/My-Notes". */
  fullName: string;
  name: string;
  cloneUrl: string;
}

export interface NewGitHubWorkspace {
  workspace: WorkspaceInfo;
  fullName: string | null;
  /** Why the repo wasn't created; the workspace is then only on this device. */
  problem: string | null;
  reachable: boolean;
  manageUrl: string | null;
}

/** What deleting the open workspace would mean. */
export interface DeletionInfo {
  name: string;
  path: string;
  remote: string | null;
  /** "owner/repo" when the remote is a GitHub repo the app could delete. */
  githubRepo: string | null;
  /** Work that isn't on the remote (or no remote): deleting would lose it. */
  unsynced: boolean;
}

export interface CreatedRepo {
  workspace: WorkspaceInfo;
  /** "ada/My-Notes". */
  fullName: string;
  /** False when the app can only reach chosen repositories and this isn't one yet. */
  reachable: boolean;
  manageUrl: string;
}

export const api = {
  restoreWorkspace: () => invoke<WorkspaceInfo | null>("restore_workspace"),
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  cloneWorkspace: (url: string, path: string) => invoke<WorkspaceInfo>("clone_workspace", { url, path }),
  /** A new workspace in the app's own data folder. */
  createWorkspace: (name: string) => invoke<WorkspaceInfo>("create_workspace", { name }),
  /** Join from `url`, keeping this device's copy in the app's own data folder. */
  joinWorkspace: (url: string) => invoke<WorkspaceInfo>("join_workspace", { url }),
  showWorkspaceFolder: () => invoke<void>("show_workspace_folder"),
  /** The open workspace, read fresh: a sync may have renamed it. */
  workspaceInfo: () => invoke<WorkspaceInfo | null>("workspace_info"),
  /** Rename the workspace on every device; folders and remotes keep their names. */
  renameWorkspace: (name: string) => invoke<WorkspaceInfo>("rename_workspace", { name }),
  /**
   * Rename this device, in every workspace on it. An empty name goes back
   * to the computer's own. The open workspace comes back with the name in use.
   */
  setDeviceName: (name: string) => invoke<WorkspaceInfo>("set_device_name", { name }),
  /**
   * The name new edits are by, on every workspace on this device. An empty
   * one goes back to the name from GitHub or Git.
   */
  setPersonName: (name: string) => invoke<WorkspaceInfo>("set_person_name", { name }),
  closeWorkspace: () => invoke<void>("close_workspace"),
  /** Known workspaces, most recently opened first. */
  listWorkspaces: () => invoke<WorkspaceEntry[]>("list_workspaces"),
  /** Take a workspace off the list; its files stay where they are. */
  forgetWorkspace: (path: string) => invoke<void>("forget_workspace", { path }),
  /** The workspace listed at `from` is now in `to`: open it there. */
  locateWorkspace: (from: string, to: string) => invoke<WorkspaceInfo>("locate_workspace", { from, to }),
  /**
   * Move the open workspace into a new folder inside `parent`. On failure
   * it reopens where it was (or nothing is open): ask `workspaceInfo`.
   */
  moveWorkspace: (parent: string) => invoke<WorkspaceInfo>("move_workspace", { parent }),
  workspaceDeletionInfo: () => invoke<DeletionInfo>("workspace_deletion_info"),
  /**
   * Move the open workspace's folder to the Trash (and with `deleteRepo`,
   * delete its GitHub repo first), then open the most recent other one;
   * null when there's none.
   */
  deleteWorkspace: (deleteRepo: boolean) => invoke<WorkspaceInfo | null>("delete_workspace", { deleteRepo }),
  setRemote: (url: string | null) => invoke<WorkspaceInfo>("set_remote", { url }),
  /** Installed cloud folders and the workspaces in them. */
  cloudFolders: () => invoke<CloudFolders>("cloud_folders"),
  /** Where a new `<name>.docsync` folder in `folder` would go. */
  folderRemotePlace: (folder: string, name: string) => invoke<FolderPlace>("folder_remote_place", { folder, name }),
  /** Where a folder is: "Dropbox › Work". */
  folderPlace: (folder: string) => invoke<FolderPlace>("folder_place", { folder }),
  /** The `.docsync` folders to join at a chosen folder: itself, or those below it. */
  workspacesInFolder: (folder: string) => invoke<FoundWorkspace[]>("workspaces_in_folder", { folder }),
  /** A new workspace that syncs through `<folder>/<name>.docsync`. */
  createFolderWorkspace: (name: string, folder: string) =>
    invoke<WorkspaceInfo>("create_folder_workspace", { name, folder }),
  /** Sync the open workspace through a new `.docsync` folder in `folder`, instead of where it synced. */
  syncThroughFolder: (folder: string) => invoke<WorkspaceInfo>("sync_through_folder", { folder }),
  /** The sync folder moved: sync with it at `folder` (the `.docsync` folder or one above it). */
  locateSyncFolder: (folder: string) => invoke<WorkspaceInfo>("locate_sync_folder", { folder }),
  /** Move a workspace out of the cloud folder it's in, syncing through it instead. */
  moveOutOfCloud: () => invoke<WorkspaceInfo>("move_out_of_cloud"),
  githubAccount: () => invoke<GitHubUser | null>("github_account"),
  /** `attempt` is any number new to this run; pass it to finish and cancel too. */
  /** "browser" when this build signs in through the browser, "code" for the device flow. */
  githubSignInMode: () => invoke<"browser" | "code">("github_sign_in_mode"),
  /** Sign in through the browser, then install the app if needed; null when cancelled. */
  githubSignInBrowser: (attempt: number) => invoke<GitHubUser | null>("github_sign_in_browser", { attempt }),
  githubWorkspaces: () => invoke<RemoteWorkspace[]>("github_workspaces"),
  /** A new workspace that syncs with a new private repo. */
  createGitHubWorkspace: (name: string) => invoke<NewGitHubWorkspace>("create_github_workspace", { name }),
  githubSignInStart: (attempt: number) => invoke<DeviceCode>("github_sign_in_start", { attempt }),
  /** Waits until the code is approved on GitHub; null when cancelled. */
  githubSignInFinish: (attempt: number) => invoke<GitHubUser | null>("github_sign_in_finish", { attempt }),
  githubSignInCancel: (attempt: number) => invoke<void>("github_sign_in_cancel", { attempt }),
  githubSignOut: () => invoke<void>("github_sign_out"),
  githubAccess: () => invoke<GitHubAccess>("github_access"),
  /** A private repo for the open workspace, which then syncs with it instead of where it synced. */
  githubCreateRepo: () => invoke<CreatedRepo>("github_create_repo"),
  syncStatus: () => invoke<SyncStatus | null>("sync_status"),
  syncNow: () => invoke<void>("sync_now"),
  listPages: () => invoke<PageSummary[]>("list_pages"),
  readPage: (id: string) => invoke<Page>("read_page", { id }),
  searchText: (query: string) => invoke<TextMatch[]>("search_text", { query }),
  writePage: (id: string, base: string, body: string) => invoke<WriteResult>("write_page", { id, base, body }),
  /** Save a pasted or dropped file in the page's `assets/`; returns the link to it for the page's text. */
  addPageAsset: async (page: string, file: File) =>
    invoke<string>("add_page_asset", new Uint8Array(await file.arrayBuffer()), {
      headers: { page, name: encodeURIComponent(file.name || "image") },
    }),
  createPage: (title: string, parent: string | null) => invoke<string>("create_page", { title, parent }),
  /** Put a page under `parent` (null: the top level) with these positions; null removes one. */
  movePage: (id: string, parent: string | null, positions: Record<string, number | null>) =>
    invoke<void>("move_page", { id, parent, positions }),
  importMarkdown: (sources: string[], parent: string | null) =>
    invoke<ImportResult>("import_markdown", { sources, parent }),
  /** A page that shows a database. With no databases yet in the workspace it gets a new one; otherwise it asks. */
  createDatabasePage: (title: string, parent: string | null) =>
    invoke<string>("create_database_page", { title, parent }),
  setPageDatabase: (id: string, database: string) => invoke<void>("set_page_database", { id, database }),
  /** Add or change a database page's view, or remove it with null. */
  setPageView: (id: string, viewId: string, view: View | null) => invoke<void>("set_page_view", { id, viewId, view }),
  /**
   * A page's properties, the same for a regular page and a row. On a row
   * they're its database's columns: adding or deleting one does it for
   * every row.
   */
  addProperty: (id: string, name: string, type: ColumnType) => invoke<string>("add_page_property", { id, name, kind: type }),
  updateProperty: (id: string, key: string, change: ColumnChange) =>
    invoke<void>("update_page_property", {
      id,
      key,
      name: change.name ?? null,
      kind: change.type ?? null,
      position: change.position ?? null,
      options: change.options ?? null,
    }),
  deleteProperty: (id: string, key: string) => invoke<void>("delete_page_property", { id, key }),
  /** null empties it. A select value that isn't a choice yet becomes one. */
  setProperty: (id: string, key: string, value: CellValue | null) =>
    invoke<void>("set_page_property_value", { id, key, value }),
  /** Renames a page, or sets a row's title cell. */
  renamePage: (id: string, title: string) => invoke<void>("rename_page", { id, title }),
  setPageDisplay: <K extends PageDisplayKey>(id: string, key: K, value: PageDisplay[K]) =>
    invoke<void>("set_page_display", { id, key, value }),
  /** A database page takes its database along, unless another page shows it too. A row is deleted from its database. */
  deletePage: (id: string) => invoke<void>("delete_page", { id }),
  resolveConflict: (id: string, index: number, keep: number) =>
    invoke<Page>("resolve_conflict", { id, index, keep }),
};

/** What a database column holds; see docsync::database. */
/** "title" is a database's title column: one per database, whose cell is the row page's title. */
export type ColumnType = "title" | "text" | "number" | "checkbox" | "select" | "date" | "url";

/** A cell's stored value: a string (text, url, select, "YYYY-MM-DD" date), number or boolean. */
export type CellValue = string | number | boolean;

export interface DatabaseSummary {
  id: string;
  name: string;
  columns: number;
  rows: number;
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  /** Sort key for the column order; null sorts last. */
  position: number | null;
  /** The choices of a select column. */
  options: string[];
}

export interface Row {
  id: string;
  /** Sort key for the row order (the order a database's `rows` are in); null sorts last. */
  position: number | null;
  /** Sort keys in views ordered by hand (a board's cards), by view id; see boards.ts. */
  positions: Record<string, number>;
  /**
   * Keyed by column id; an empty cell has no key. May hold cells of removed
   * columns, or a value of another type than its column's after a type change.
   */
  cells: Record<string, unknown>;
}

export interface Database {
  id: string;
  name: string;
  /** In display order. */
  columns: Column[];
  /** In display order. */
  rows: Row[];
  /** The database's folder on disk. */
  path: string;
}

export interface ColumnChange {
  name?: string;
  type?: ColumnType;
  position?: number;
  options?: string[];
}

export const dbApi = {
  list: () => invoke<DatabaseSummary[]>("list_databases"),
  read: (id: string) => invoke<Database>("read_database", { id }),
  /** A new database with one text column, "Name". */
  create: (name: string) => invoke<string>("create_database", { name }),
  rename: (id: string, name: string) => invoke<void>("rename_database", { id, name }),
  remove: (id: string) => invoke<void>("delete_database", { id }),
  addColumn: (db: string, name: string, type: ColumnType) => invoke<string>("add_column", { db, name, kind: type }),
  updateColumn: (db: string, column: string, change: ColumnChange) =>
    invoke<void>("update_column", {
      db,
      column,
      name: change.name ?? null,
      kind: change.type ?? null,
      position: change.position ?? null,
      options: change.options ?? null,
    }),
  deleteColumn: (db: string, column: string) => invoke<void>("delete_column", { db, column }),
  addRow: (db: string) => invoke<string>("add_row", { db }),
  /** null empties the cell. A select value that isn't a choice yet becomes one. */
  setCell: (db: string, row: string, column: string, value: CellValue | null) =>
    invoke<void>("set_cell", { db, row, column, value }),
  /** Put rows at positions in a view ordered by hand, by row id. */
  setRowPositions: (db: string, view: string, positions: Record<string, number>) =>
    invoke<void>("set_row_positions", { db, view, positions }),
  deleteRow: (db: string, row: string) => invoke<void>("delete_row", { db, row }),
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  /** Milliseconds since the Unix epoch. */
  time: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface DevInfo {
  /** Whether the developer panel is available (debug builds, or DOCSYNC_DEV=1). */
  enabled: boolean;
  version: string;
  debugBuild: boolean;
  os: string;
  git: string | null;
  workspace: WorkspaceInfo | null;
}

export const devApi = {
  info: () => invoke<DevInfo>("dev_info"),
  entries: () => invoke<LogEntry[]>("dev_log_entries"),
  clear: () => invoke<void>("dev_log_clear"),
  add: (level: LogLevel, source: string, message: string) => invoke<void>("dev_log_add", { level, source, message }),
  /** Show the log file, which every build writes, in Finder. */
  showLogFile: () => invoke<void>("show_log_file"),
};

/** Release builds update themselves in the background: see src-tauri/src/updater.rs. */
export const updates = {
  /** The version installed and waiting for a restart, if any. */
  ready: () => invoke<string | null>("update_ready"),
  /** Restart into it. Save the open page first. */
  restart: () => invoke<void>("restart_to_update"),
};

export const events = {
  onSyncStatus: (handler: (status: SyncStatus) => void): Promise<UnlistenFn> =>
    listen<SyncStatus>("sync-status", (e) => handler(e.payload)),
  /** Files changed on disk: a sync pulled changes in, or another program edited them. */
  onWorkspaceChanged: (handler: () => void): Promise<UnlistenFn> => listen("workspace-changed", () => handler()),
  /** Where the workspace is kept changed: this device followed a move, or can't yet. */
  onWorkspaceInfo: (handler: (info: WorkspaceInfo) => void): Promise<UnlistenFn> =>
    listen<WorkspaceInfo>("workspace-info", (e) => handler(e.payload)),
  /** Signed out without asking, e.g. the sign-in was revoked on GitHub. */
  onAccountChanged: (handler: () => void): Promise<UnlistenFn> => listen("account-changed", () => handler()),
  /** The browser sign-in moved on to GitHub's install page. */
  onGitHubSignInStep: (handler: (step: "install") => void): Promise<UnlistenFn> =>
    listen<"install">("github-sign-in-step", (e) => handler(e.payload)),
  /** A newer version was installed and runs from the next start. */
  onUpdateReady: (handler: (version: string) => void): Promise<UnlistenFn> =>
    listen<string>("update-ready", (e) => handler(e.payload)),
  onDevLog: (handler: (entry: LogEntry) => void): Promise<UnlistenFn> =>
    listen<LogEntry>("dev-log", (e) => handler(e.payload)),
};

/** Tauri rejects with the Rust error string. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
