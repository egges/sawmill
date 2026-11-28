import { useRef } from "react";
import {
  CircleArrowUp,
  Plus,
  Search,
  Settings,
  Sheet,
  SquareTerminal,
} from "lucide-react";
import type { PageSummary, SyncStatus, WorkspaceInfo } from "./api.ts";
import { ImportMenu } from "./ImportMenu.tsx";
import type { PageMove } from "./pageMoves.ts";
import { PageTree } from "./PageTree.tsx";
import type { SettingsSection } from "./Settings.tsx";
import { SHORTCUTS, keysLabel, tip } from "./shortcuts.ts";
import { SIDEBAR_WIDTH } from "./sidebarLayout.ts";
import { SyncStatusBar } from "./SyncStatusBar.tsx";
import { SidebarTitleBar } from "./TitleBar.tsx";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

interface SidebarProps {
  workspace: WorkspaceInfo;
  pages: PageSummary[];
  selected: string | null;
  status: SyncStatus | null;
  onSelect: (id: string) => void;
  onCreate: (parent: string | null) => void;
  /** Move a page dragged in the tree. */
  onMove: (id: string, move: PageMove) => void;
  /** A new page that shows a database. */
  onCreateDatabase: () => void;
  /** Import Markdown files and folders as pages. */
  onImport: (sources: string[]) => void;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  /** Saves the open page, then opens the workspace `open` returns. */
  onSwitch: (open: () => Promise<WorkspaceInfo | null>) => Promise<void>;
  onAddWorkspace: () => void;
  onError: (message: string) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onSearch: () => void;
  width: number;
  hidden: boolean;
  onResize: (width: number) => void;
  /** Set when the developer panel is available. */
  onOpenDevPanel?: () => void;
  /** A newer version installed in the background, waiting for a restart. */
  updateVersion: string | null;
  onRestartToUpdate: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { workspace, pages, selected, status } = props;
  return (
    // Hidden, it stays in the page (so it can slide closed and open) but
    // can't be clicked or tabbed into.
    <aside className="sidebar" inert={props.hidden} aria-hidden={props.hidden || undefined}>
      <div className="sidebar-clip">
        <div className="sidebar-content" style={{ width: props.width }}>
          <SidebarTitleBar />
          <button className="sidebar-search" title={tip("Search", "search")} onClick={props.onSearch}>
            <Search size={14} aria-hidden />
            <span>Search</span>
            <kbd>{keysLabel(SHORTCUTS.search.keys)}</kbd>
          </button>
          <div className="sidebar-header">
            <WorkspaceSwitcher
              workspace={workspace}
              onRenamed={props.onWorkspaceChange}
              onSwitch={props.onSwitch}
              onAdd={props.onAddWorkspace}
              onError={props.onError}
            />
            <button className="icon-button" title={tip("New page", "newPage")} aria-label="New page" onClick={() => props.onCreate(null)}>
              <Plus size={16} />
            </button>
          </div>
          <nav className="tree" aria-label="Pages">
            <PageTree
              pages={pages}
              selected={selected}
              onSelect={props.onSelect}
              onCreate={props.onCreate}
              onMove={props.onMove}
            />
            <button className="tree-new" onClick={() => props.onCreate(null)}>
              <Plus size={14} aria-hidden />
              <span>New page</span>
            </button>
            <button className="tree-new" onClick={props.onCreateDatabase}>
              <Sheet size={14} aria-hidden />
              <span>New database</span>
            </button>
            <ImportMenu onImport={props.onImport} />
          </nav>
          <div className="sidebar-footer">
            <SyncStatusBar
              workspace={workspace}
              status={status}
              onWorkspaceChange={props.onWorkspaceChange}
              onSwitch={props.onSwitch}
              onOpenSettings={() => props.onOpenSettings("workspace")}
            />
            {props.updateVersion && (
              <button
                className="icon-button update-ready"
                title={`Restart to update to version ${props.updateVersion}`}
                aria-label="Restart to update"
                onClick={props.onRestartToUpdate}
              >
                <CircleArrowUp size={15} />
              </button>
            )}
            <button
              className="icon-button"
              title={tip("Settings", "openSettings")}
              aria-label="Settings"
              onClick={() => props.onOpenSettings()}
            >
              <Settings size={15} />
            </button>
            {props.onOpenDevPanel && (
              <button
                className="icon-button"
                title={tip("Developer panel", "toggleDevPanel")}
                aria-label="Developer panel"
                onClick={props.onOpenDevPanel}
              >
                <SquareTerminal size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <Resizer width={props.width} onResize={props.onResize} />
    </aside>
  );
}

/** The sidebar's right edge: drag to resize, double-click for the default width, or arrow keys. */
function Resizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(drag.current.width + e.clientX - drag.current.x);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") onResize(width - step);
        else if (e.key === "ArrowRight") onResize(width + step);
        else return;
        e.preventDefault();
      }}
    />
  );
}
