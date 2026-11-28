import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type PageDisplay,
  type PageDisplayKey,
  type PageSummary,
  type SyncStatus,
  type WorkspaceInfo,
  api,
  errorText,
  events,
  updates,
} from "./api.ts";
import { DevPanel, useDevPanel } from "./DevPanel.tsx";
import { PagesArt } from "./Graphics.tsx";
import { importNotice } from "./importing.ts";
import { log } from "./devlog.ts";
import { PageView, type PageViewHandle } from "./PageView.tsx";
import { linkTarget } from "./links.ts";
import type { PageMove } from "./pageMoves.ts";
import { displayOrder, trail } from "./pageTree.ts";
import { Search } from "./Search.tsx";
import { Settings, type SettingsSection } from "./Settings.tsx";
import type { SearchAction } from "./search.ts";
import { inCodeBlock, useShortcuts } from "./shortcuts.ts";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useSidebarLayout } from "./sidebarLayout.ts";
import { PageTitleBar, SidebarToggle } from "./TitleBar.tsx";
import { Welcome } from "./Welcome.tsx";

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [starting, setStarting] = useState(true);
  // "Add workspace…": the welcome screen over the open workspace.
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api
      .restoreWorkspace()
      .then(setWorkspace)
      .finally(() => setStarting(false));
  }, []);

  if (starting) return <div className="splash" />;
  if (!workspace) return <Welcome onOpened={setWorkspace} />;
  return (
    <>
      <WorkspaceView
        key={workspace.path}
        workspace={workspace}
        covered={adding}
        onChange={setWorkspace}
        onAddWorkspace={() => setAdding(true)}
      />
      {adding && (
        <Welcome
          onOpened={(w) => {
            setAdding(false);
            setWorkspace(w);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </>
  );
}

function WorkspaceView({
  workspace,
  covered,
  onChange,
  onAddWorkspace,
}: {
  workspace: WorkspaceInfo;
  /** Another screen is shown over it: no shortcuts. */
  covered: boolean;
  onChange: (w: WorkspaceInfo | null) => void;
  onAddWorkspace: () => void;
}) {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // The open page's title while it's typed, for the title bar.
  const [draftTitle, setDraftTitle] = useState<{ id: string; title: string } | null>(null);
  // The open page's display options (text size, width), for the page and its menu.
  const [display, setDisplay] = useState<{ id: string; display: PageDisplay } | null>(null);
  // Text to select once the open page loads, when it was opened from a search.
  const [reveal, setReveal] = useState<string | null>(null);
  const sidebar = useSidebarLayout();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setErrorState] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"search" | "shortcuts" | "settings" | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>();
  const openSettings = (section?: SettingsSection) => {
    setSettingsSection(section);
    setDialog("settings");
  };
  const setError = useCallback((message: string | null) => {
    if (message) log("error", "ui", `Shown to the user: ${message}`);
    setErrorState(message);
  }, []);
  const dev = useDevPanel();
  // Who is reading: in a conflict block, their own versions say "You".
  const reader = {
    person: workspace.person,
    personId: workspace.personId,
    device: workspace.device,
    deviceId: workspace.deviceId,
  };
  // Signing in or out can change who that is.
  useEffect(() => {
    const unlisten = events.onAccountChanged(() => void api.workspaceInfo().then((w) => w && onChange(w)));
    return () => void unlisten.then((f) => f());
  }, [onChange]);
  // Bumped when files change on disk, so the open page rereads its file.
  const [diskVersion, setDiskVersion] = useState(0);
  const page = useRef<PageViewHandle>(null);
  const nameRef = useRef(workspace.name);
  nameRef.current = workspace.name;
  const pathRef = useRef(workspace.path);
  pathRef.current = workspace.path;

  const reload = useCallback(async () => {
    try {
      setPages(await api.listPages());
    } catch (e) {
      setError(errorText(e));
    }
  }, [setError]);

  useEffect(() => {
    void reload();
    const unlisten = [
      events.onSyncStatus(setStatus),
      events.onWorkspaceChanged(() => {
        log("debug", "ui", "Workspace changed on disk: reloading the page list and the open page");
        void reload();
        setDiskVersion((n) => n + 1);
        // Another device may have renamed the workspace.
        void api.workspaceInfo().then((w) => w && w.name !== nameRef.current && onChange(w));
      }),
      events.onWorkspaceInfo((w) => {
        log("info", "ui", w.movedTo ? `Moved to ${w.movedTo.label}; not followed yet` : `Kept in ${w.keptIn}`);
        if (w.path === pathRef.current) onChange(w);
      }),
    ];
    // The first sync may have reported before we listened.
    void Promise.all(unlisten).then(() => api.syncStatus().then((s) => s && setStatus((now) => now ?? s)));
    return () => unlisten.forEach((u) => void u.then((f) => f()));
  }, [reload, setError, onChange]);

  // A newer version installed in the background (release builds only).
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    void updates.ready().then(setUpdateVersion, () => {});
    const unlisten = events.onUpdateReady(setUpdateVersion);
    return () => void unlisten.then((f) => f());
  }, []);
  const restartToUpdate = async () => {
    await page.current?.flush();
    await updates.restart();
  };

  // Save before the window goes away or loses focus (and so before a sync on refocus).
  useEffect(() => {
    const flush = () => void page.current?.flush();
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  // If the open page disappears (deleted here or by a sync), close it.
  useEffect(() => {
    if (selected && pages.length && !pages.some((p) => p.id === selected)) setSelected(null);
  }, [pages, selected]);

  const select = async (id: string | null, find: string | null = null) => {
    await page.current?.flush();
    setReveal(find);
    setSelected(id);
  };

  const create = async (parent: string | null, title = "", kind: "page" | "database" = "page") => {
    try {
      await page.current?.flush();
      const id = kind === "database" ? await api.createDatabasePage(title, parent) : await api.createPage(title, parent);
      await reload();
      setReveal(null);
      setSelected(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const movePage = async (id: string, move: PageMove) => {
    try {
      await api.movePage(id, move.parent, move.positions);
      await reload();
    } catch (e) {
      setError(errorText(e));
      await reload();
    }
  };

  const importPages = async (sources: string[]) => {
    try {
      await page.current?.flush();
      const result = await api.importMarkdown(sources, null);
      await reload();
      if (result.pages.length) {
        setReveal(null);
        setSelected(result.pages[0]);
      }
      const notice = importNotice(result);
      if (notice) await message(notice, { title: "Import", kind: result.pageCount ? "info" : "warning" });
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Opening another workspace (or moving or deleting this one): save the
  // open page first, so its last edits land in this workspace. `open` may
  // return null for "no workspace open" (onboarding).
  const switchTo = async (open: () => Promise<WorkspaceInfo | null>) => {
    try {
      await page.current?.flush();
      onChange(await open());
    } catch (e) {
      setError(errorText(e));
      // A failed move reopens the workspace where it was, or leaves none open.
      const now = await api.workspaceInfo().catch(() => null);
      if (now?.path !== workspace.path) onChange(now);
    }
  };

  const onDisplay = useCallback((id: string, d: PageDisplay) => setDisplay({ id, display: d }), []);
  const changeDisplay = async <K extends PageDisplayKey>(key: K, value: PageDisplay[K]) => {
    if (!selected || display?.id !== selected) return;
    const before = display.display;
    setDisplay({ id: selected, display: { ...before, [key]: value } });
    try {
      await api.setPageDisplay(selected, key, value);
    } catch (e) {
      setDisplay((now) => (now?.id === selected ? { id: selected, display: before } : now));
      setError(errorText(e));
    }
  };
  const openDisplay = display && display.id === selected ? display.display : null;

  const step = (by: 1 | -1) => {
    const order = displayOrder(pages.filter((p) => p.kind !== "row"));
    if (!order.length) return;
    const at = order.findIndex((p) => p.id === selected);
    const next = at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + by));
    void select(order[next].id);
  };

  const runSearch = (action: SearchAction) => {
    setDialog(null);
    if (action.kind === "openPage") void select(action.id, action.reveal ?? null);
    else void create(null, action.title);
  };

  const openLink = (href: string) => {
    const target = linkTarget(href, pages);
    log("info", "ui", `Link clicked: ${href} (${target.kind})`);
    if (target.kind === "page") void select(target.id);
    else if (target.kind === "external") openUrl(target.url).catch((e) => setError(`Couldn't open ${target.url}: ${errorText(e)}`));
  };

  useShortcuts(covered ? {} : {
    search: () => setDialog((d) => (d === "search" ? null : "search")),
    toggleSidebar: sidebar.toggle,
    // In a code block, ⌘/ comments lines out, as in a code editor.
    showShortcuts: () => (inCodeBlock() ? false : setDialog((d) => (d === "shortcuts" ? null : "shortcuts"))),
    openSettings: () => (dialog === "settings" ? setDialog(null) : openSettings()),
    newPage: () => void create(null),
    newSubpage: selected ? () => void create(selected) : undefined,
    previousPage: () => step(-1),
    nextPage: () => step(1),
    deletePage: selected ? () => void page.current?.remove() : undefined,
    syncNow: () => {
      log("info", "ui", "Save and sync requested from the keyboard");
      void page.current?.flush().then(() => api.syncNow());
    },
    toggleDevPanel: dev.enabled ? dev.toggle : undefined,
    toggleDevPanelSize: dev.enabled ? dev.toggleSize : undefined,
  });

  return (
    <div
      inert={covered}
      className={"layout" + (sidebar.hidden ? " sidebar-hidden" : "")}
      style={{ gridTemplateColumns: `${sidebar.hidden ? 0 : sidebar.width}px 1fr` }}
    >
      <Sidebar
        workspace={workspace}
        pages={pages}
        selected={selected}
        status={status}
        onSelect={select}
        onCreate={create}
        onMove={(id, move) => void movePage(id, move)}
        onCreateDatabase={() => void create(null, "", "database")}
        onImport={(sources) => void importPages(sources)}
        onWorkspaceChange={onChange}
        onSwitch={switchTo}
        onAddWorkspace={() => void Promise.resolve(page.current?.flush()).then(onAddWorkspace)}
        onError={setError}
        onOpenSettings={openSettings}
        onSearch={() => setDialog("search")}
        width={sidebar.width}
        hidden={sidebar.hidden}
        onResize={sidebar.setWidth}
        onOpenDevPanel={dev.enabled ? dev.toggle : undefined}
        updateVersion={updateVersion}
        onRestartToUpdate={() => void restartToUpdate().catch((e) => setError(errorText(e)))}
      />
      <main className="main">
        <PageTitleBar
          trail={selected ? trail(pages, selected) : []}
          draftTitle={draftTitle && draftTitle.id === selected ? draftTitle.title : null}
          sidebarHidden={sidebar.hidden}
          onSearch={() => setDialog("search")}
          onSelect={(id) => id !== selected && void select(id)}
          onDelete={selected ? () => void page.current?.remove() : undefined}
          display={openDisplay}
          onDisplayChange={(key, value) => void changeDisplay(key, value)}
        />
        {error && (
          <div className="banner banner-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className="main-scroll">
          {selected ? (
            <PageView
              key={selected}
              ref={page}
              id={selected}
              diskVersion={diskVersion}
              reveal={reveal}
              onOpenLink={openLink}
              onRenamed={reload}
              onTitleChange={(title) => setDraftTitle({ id: selected, title })}
              display={openDisplay}
              onDisplay={(d) => onDisplay(selected, d)}
              onDeleted={async () => {
                setSelected(null);
                await reload();
              }}
              onError={setError}
              onOpenPage={(id) => void reload().then(() => select(id))}
              reader={reader}
            />
          ) : (
            <div className="empty">
              <PagesArt />
              <h2>{pages.length ? "Pick up where you left off" : "A fresh, empty workspace"}</h2>
              <p>{pages.length ? "Choose a page on the left, or start a new one." : "Start your first page: notes, plans, anything."}</p>
              <button className="button primary" onClick={() => void create(null)}>
                <Plus size={15} aria-hidden /> New page
              </button>
            </div>
          )}
        </div>
      </main>
      <SidebarToggle hidden={sidebar.hidden} onToggle={sidebar.toggle} />
      {dev.open && (
        <DevPanel
          maximized={dev.maximized}
          tab={dev.tab}
          onTab={dev.setTab}
          onToggleSize={dev.toggleSize}
          onClose={dev.toggle}
        />
      )}
      {dialog === "search" && <Search pages={pages} onAction={runSearch} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsHelp devPanel={dev.enabled} onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <Settings
          section={settingsSection}
          workspace={workspace}
          onWorkspaceChange={onChange}
          onSwitch={switchTo}
          onShowShortcuts={() => setDialog("shortcuts")}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
