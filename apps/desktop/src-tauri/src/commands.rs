//! What the window can ask the Rust side to do. Every command that touches
//! git runs on a blocking thread, so the window never waits on the main
//! thread for a sync to finish.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use docsync::conflicts::find_conflicts;
use docsync::{PageWrite, SyncEngine, VersionLabel, Workspace};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::cloud::{self, CloudFolder, FolderPlace, FoundWorkspace};
use crate::database_pages::{self, DatabasePageInfo};
use crate::devlog::{self, Entry, Level};
use crate::github::{self, Access, DeviceCode, GitHubUser, RemoteWorkspace};
use crate::locations;
use crate::page_properties::{self, Kind, Properties, RowOf};
use crate::person;
use crate::search::{self, TextMatch};
use crate::session::{self, Session, WorkspaceInfo};
use crate::tree::{self, PageSummary};
use crate::worker::{Events, SyncState, SyncStatus};
use crate::workspaces::{self, AppSettings, WorkspaceEntry};

pub(crate) type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct AppState {
    session: Mutex<Option<Session>>,
    /// A check for a move by another device is running; see [`follow_move`].
    following: AtomicBool,
}

impl AppState {
    /// Signed in or out: new commits are by the new account.
    pub fn account_changed(&self) {
        if let Some(session) = self.session.lock().unwrap().as_ref() {
            session.refresh_person();
            // Signing in may be what the workspace was waiting for.
            session.worker.sync_now();
        }
    }

    pub fn window_focused(&self) {
        if let Some(session) = self.session.lock().unwrap().as_ref() {
            session.worker.focused();
        }
    }

    /// The engine and a way to tell the worker about edits, without holding
    /// the lock while git runs.
    pub(crate) fn engine(&self) -> CmdResult<(Arc<SyncEngine>, impl Fn() + Send + 'static)> {
        let guard = self.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        let engine = session.engine.clone();
        let notify = session.worker.edit_notifier();
        Ok((engine, notify))
    }
}

/// Sends worker events to the window.
struct WindowEvents(AppHandle);

impl Events for WindowEvents {
    fn status(&self, status: &SyncStatus) {
        let _ = self.0.emit("sync-status", status);
        // A sync may have brought a note that the workspace moved; offline
        // or refused too, since the old place may be gone once everyone has
        // moved.
        if matches!(
            status.state,
            SyncState::Synced | SyncState::Offline | SyncState::NoAccess
        ) {
            tauri::async_runtime::spawn(follow_move(self.0.clone()));
        }
    }
    fn workspace_changed(&self) {
        let _ = self.0.emit("workspace-changed", ());
    }
}

/// Run `f` on a blocking thread; a failure goes to the developer log too.
pub(crate) async fn blocking<T: Send + 'static>(
    command: &'static str,
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    let result = tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    if let Err(e) = &result {
        devlog::error("app", format!("{command} failed: {e}"));
    }
    result
}

pub(crate) fn text<E: ToString>(e: E) -> String {
    e.to_string()
}

// ---- app settings ------------------------------------------------------

/// Serialises reading and writing `settings.json`.
static SETTINGS: Mutex<()> = Mutex::new(());

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> AppSettings {
    let _guard = SETTINGS.lock().unwrap();
    settings_path(app)
        .map(|p| AppSettings::load(&p))
        .unwrap_or_default()
}

/// Change the settings and save them.
fn update_settings(app: &AppHandle, change: impl FnOnce(&mut AppSettings)) {
    let _guard = SETTINGS.lock().unwrap();
    let Some(path) = settings_path(app) else { return };
    let mut settings = AppSettings::load(&path);
    change(&mut settings);
    if let Err(e) = settings.save(&path) {
        devlog::warn("app", format!("Couldn't save {}: {e}", path.display()));
    }
}

/// At startup: the names the user chose for this device and themselves,
/// this install's person id (made on first start), and Git's own identity.
pub fn load_identity(app: &AppHandle) {
    let mut settings = load_settings(app);
    session::set_device_name(settings.device_name.as_deref());
    let local_id = match settings.person_id.clone() {
        Some(id) => id,
        None => {
            let id = person::new_local_id();
            update_settings(app, |s| s.person_id = Some(id.clone()));
            settings.person_id = Some(id.clone());
            id
        }
    };
    person::load(settings.person_name, local_id);
    if let Ok(git) = crate::git::find_git() {
        person::load_git_identity(git.binary());
    }
}

/// Choose the name new edits are by, on every workspace on this device. An
/// empty one goes back to the name from GitHub or Git.
#[tauri::command]
pub async fn set_person_name(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<WorkspaceInfo> {
    let kept = person::set_name(&name, github::user().as_ref());
    update_settings(&app, |s| s.person_name = kept);
    let guard = state.session.lock().unwrap();
    let session = guard.as_ref().ok_or("No workspace is open")?;
    session.refresh_person();
    Ok(session.info())
}

/// Rename this device, for every workspace on it: the name shown with the
/// person's in conflict blocks. An empty name goes back to the computer's.
#[tauri::command]
pub async fn set_device_name(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<WorkspaceInfo> {
    let kept = session::set_device_name(Some(&name));
    update_settings(&app, |s| s.device_name = kept);
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No workspace is open")?;
    session.device_renamed();
    Ok(session.info())
}

// ---- workspaces ----------------------------------------------------------

fn install(app: &AppHandle, state: &AppState, session: Session) -> WorkspaceInfo {
    let info = session.info();
    let old = state.session.lock().unwrap().replace(session);
    // Stopping the old worker waits for a running sync, which may be stuck on
    // a slow network. Don't make the window wait for it.
    if let Some(old) = old {
        std::thread::spawn(move || drop(old));
    }
    update_settings(app, |s| {
        s.opened(Path::new(&info.path), &info.name, workspaces::now_ms())
    });
    info
}

/// The workspace that was open last time, if it still opens.
#[tauri::command]
pub async fn restore_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<WorkspaceInfo>> {
    let Some(path) = load_settings(&app).last_workspace else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let events = WindowEvents(app.clone());
    match blocking("restore_workspace", move || {
        Session::open_or_create(&path, events)
    })
    .await
    {
        Ok(session) => Ok(Some(install(&app, &state, session))),
        Err(e) => {
            eprintln!("couldn't reopen the last workspace: {e}");
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let events = WindowEvents(app.clone());
    let session = blocking("open_workspace", move || Session::open_or_create(&path, events)).await?;
    Ok(install(&app, &state, session))
}

#[tauri::command]
pub async fn clone_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    path: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let events = WindowEvents(app.clone());
    let session = blocking("clone_workspace", move || {
        Session::clone_remote(url.trim(), &path, events)
    })
    .await?;
    Ok(install(&app, &state, session))
}

/// The folder new workspaces go in unless the user picks one; see `locations`.
fn workspaces_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("workspaces"))
        .map_err(|e| format!("Can't find the app's data folder: {e}"))
}

/// Run `make` on a new folder; remove the folder again if that fails, so a
/// failed attempt doesn't leave "My Notes" behind and push the next try to
/// "My Notes 2".
fn in_new_folder(
    path: PathBuf,
    make: impl FnOnce(&std::path::Path) -> CmdResult<Session>,
) -> CmdResult<Session> {
    let result = make(&path);
    if result.is_err() && path.exists() {
        let _ = std::fs::remove_dir_all(&path);
    }
    result
}

/// Create a workspace called `name` in the default location.
#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<WorkspaceInfo> {
    let session = new_local_workspace(&app, "create_workspace", name).await?;
    Ok(install(&app, &state, session))
}

async fn new_local_workspace(app: &AppHandle, command: &'static str, name: String) -> CmdResult<Session> {
    let path = locations::new_workspace_dir(&workspaces_dir(app)?, &name);
    let events = WindowEvents(app.clone());
    blocking(command, move || {
        in_new_folder(path, |p| {
            let session = Session::open_or_create(p, events)?;
            // The folder name is a cleaned-up version; keep what they typed.
            if !name.trim().is_empty() {
                session.rename(&name)?;
            }
            Ok(session)
        })
    })
    .await
}

/// Join the workspace at `url`, keeping this device's copy in the default
/// location.
#[tauri::command]
pub async fn join_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> CmdResult<WorkspaceInfo> {
    let url = url.trim().to_string();
    let path = locations::new_workspace_dir(&workspaces_dir(&app)?, &locations::name_from_url(&url));
    let events = WindowEvents(app.clone());
    let session = blocking("join_workspace", move || {
        in_new_folder(path, |p| Session::clone_remote(&url, p, events))
    })
    .await?;
    Ok(install(&app, &state, session))
}

/// The open workspace, read fresh: its name may have changed with a sync.
#[tauri::command]
pub async fn workspace_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<WorkspaceInfo>> {
    let info = state.session.lock().unwrap().as_ref().map(Session::info);
    if let Some(info) = &info {
        update_settings(&app, |s| s.renamed(Path::new(&info.path), &info.name));
    }
    Ok(info)
}

/// Rename the open workspace on every device. Folders and remotes keep their
/// names.
#[tauri::command]
pub async fn rename_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<WorkspaceInfo> {
    let info = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("No workspace is open")?.rename(&name)?
    };
    update_settings(&app, |s| s.renamed(Path::new(&info.path), &info.name));
    Ok(info)
}

/// Show the open workspace's folder in Finder, Explorer or the file manager.
#[tauri::command]
pub async fn show_workspace_folder(state: State<'_, AppState>) -> CmdResult<()> {
    let (engine, _) = state.engine()?;
    blocking("show_workspace_folder", move || {
        tauri_plugin_opener::reveal_item_in_dir(engine.root()).map_err(text)
    })
    .await
}

#[tauri::command]
pub async fn close_workspace(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(session) = state.session.lock().unwrap().take() {
        // Commits pending edits once a running sync is done; see `install`.
        std::thread::spawn(move || drop(session));
    }
    update_settings(&app, |s| s.last_workspace = None);
    Ok(())
}

/// The workspaces this device knows, most recently opened first.
#[tauri::command]
pub async fn list_workspaces(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<WorkspaceEntry>> {
    let current = state
        .session
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.engine.root().to_path_buf());
    let mut entries = load_settings(&app).entries();
    for entry in &mut entries {
        entry.current = current
            .as_deref()
            .is_some_and(|c| workspaces::same(c, Path::new(&entry.path)));
    }
    Ok(entries)
}

/// Take a workspace off the list. Its files stay where they are.
#[tauri::command]
pub async fn forget_workspace(app: AppHandle, path: PathBuf) -> CmdResult<()> {
    update_settings(&app, |s| s.forget(&path));
    devlog::info(
        "app",
        format!("Removed {} from the workspace list", path.display()),
    );
    Ok(())
}

/// The workspace listed at `from` is now in `to` (moved outside the app, or
/// on a drive that's mounted elsewhere): open it there.
#[tauri::command]
pub async fn locate_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    from: PathBuf,
    to: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    if !workspaces::is_workspace(&to) {
        return Err(format!("{} doesn't hold a workspace.", to.display()));
    }
    let events = WindowEvents(app.clone());
    let opened = to.clone();
    let session = blocking("locate_workspace", move || {
        Session::open_or_create(&opened, events)
    })
    .await?;
    devlog::info("app", format!("Located {} at {}", from.display(), to.display()));
    // Before `install`, which puts the new location first.
    update_settings(&app, |s| s.relocated(&from, &to));
    Ok(install(&app, &state, session))
}

/// Move the open workspace into a new folder inside `parent`, named after
/// the workspace. Its history and sync settings move with it. If the move
/// fails, the workspace reopens where it was; either way the window should
/// ask `workspace_info` what's open afterwards.
#[tauri::command]
pub async fn move_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    parent: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    relocate(&app, &state, &parent).await
}

async fn relocate(app: &AppHandle, state: &AppState, parent: &Path) -> CmdResult<WorkspaceInfo> {
    let (from, name) = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        (session.engine.root().to_path_buf(), session.info().name)
    };
    let target = workspaces::move_target(&from, parent, &name)?;
    let session = state
        .session
        .lock()
        .unwrap()
        .take()
        .ok_or("No workspace is open")?;
    let events = WindowEvents(app.clone());
    let (old, new) = (from.clone(), target.clone());
    let (moved, reopened) = blocking("move_workspace", move || {
        // Stop syncing and watching first. This waits for a running sync
        // and commits pending edits, so nothing writes while files move.
        drop(session);
        devlog::info(
            "app",
            format!("Moving {} to {}", from.display(), target.display()),
        );
        let moved = workspaces::move_dir(&from, &target).map_err(text);
        let reopened = Session::open_or_create(if moved.is_ok() { &target } else { &from }, events);
        Ok((moved, reopened))
    })
    .await?;
    if moved.is_ok() {
        devlog::info("app", format!("Moved the workspace to {}", new.display()));
        update_settings(app, |s| s.relocated(&old, &new));
    }
    let info = reopened.map(|session| install(app, state, session));
    match moved {
        Ok(()) => info,
        Err(e) => {
            let message = format!("Couldn't move the workspace: {e}");
            devlog::error("app", &message);
            Err(message)
        }
    }
}

// ---- cloud folders ----------------------------------------------------------

/// The cloud folders on this device, and the workspaces already in them.
#[derive(Debug, Serialize)]
pub struct CloudFolders {
    folders: Vec<CloudFolder>,
    workspaces: Vec<FoundWorkspace>,
}

#[tauri::command]
pub async fn cloud_folders() -> CmdResult<CloudFolders> {
    blocking("cloud_folders", || {
        let folders = cloud::detect();
        let workspaces = cloud::find_workspaces(&folders);
        Ok(CloudFolders { folders, workspaces })
    })
    .await
}

/// Where a new folder remote for `name` in `folder` would go, to show
/// before making it: "Dropbox › Work › My Notes.docsync".
#[tauri::command]
pub async fn folder_remote_place(folder: PathBuf, name: String) -> CmdResult<FolderPlace> {
    blocking("folder_remote_place", move || {
        let remote = cloud::new_remote_path(&folder, &display_name(&name));
        Ok(cloud::place(&remote, &cloud::detect()))
    })
    .await
}

/// Where a folder is, for "Kept in Dropbox › Work".
#[tauri::command]
pub async fn folder_place(folder: PathBuf) -> CmdResult<FolderPlace> {
    blocking("folder_place", move || {
        Ok(cloud::place(&folder, &cloud::detect()))
    })
    .await
}

/// The workspaces to join at a folder the user chose: the folder itself
/// when it's a `*.docsync` folder, otherwise the ones below it.
#[tauri::command]
pub async fn workspaces_in_folder(folder: PathBuf) -> CmdResult<Vec<FoundWorkspace>> {
    blocking("workspaces_in_folder", move || {
        Ok(cloud::workspaces_in(&folder, &cloud::detect()))
    })
    .await
}

fn display_name(name: &str) -> String {
    if name.trim().is_empty() {
        locations::DEFAULT_NAME.to_string()
    } else {
        name.trim().to_string()
    }
}

/// Whether a folder remote can go in `folder`: an existing folder that
/// isn't a workspace, inside one, or inside another folder remote.
fn check_sync_folder(app: &AppHandle, folder: &Path) -> CmdResult<()> {
    if !folder.is_dir() {
        return Err(format!("{} isn't a folder.", folder.display()));
    }
    let real = folder.canonicalize().unwrap_or_else(|_| folder.to_path_buf());
    let own = workspaces_dir(app)?;
    let own = own.canonicalize().unwrap_or(own);
    if real.starts_with(&own) {
        return Err(
            "That's the app's own folder for workspaces. Choose a folder that syncs, like one in Dropbox."
                .into(),
        );
    }
    for dir in real.ancestors() {
        if dir.extension().is_some_and(|e| e == cloud::EXTENSION) {
            return Err(format!(
                "That's inside “{}”, which a workspace syncs through. Choose the folder around it.",
                cloud::workspace_name(dir)
            ));
        }
        if dir.join(".docsync").is_dir() {
            return Err("That's inside a workspace. Choose a folder outside it.".into());
        }
    }
    Ok(())
}

/// Make an empty folder remote for a workspace called `name` in `folder`.
async fn new_folder_remote(app: &AppHandle, folder: PathBuf, name: String) -> CmdResult<PathBuf> {
    check_sync_folder(app, &folder)?;
    blocking("new_folder_remote", move || {
        let remote = cloud::new_remote_path(&folder, &name);
        let git = crate::git::find_git()?;
        SyncEngine::create_folder_remote(&git, &remote).map_err(text)?;
        devlog::info("cloud", format!("Created {}", remote.display()));
        Ok(remote)
    })
    .await
}

/// A new workspace called `name` that syncs through a new folder remote in
/// `folder`, e.g. `~/Dropbox/Work/My Notes.docsync`. The workspace's own
/// files go in the app's data folder.
#[tauri::command]
pub async fn create_folder_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    folder: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let remote = new_folder_remote(&app, folder, display_name(&name)).await?;
    let mut session = match new_local_workspace(&app, "create_folder_workspace", name).await {
        Ok(session) => session,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&remote);
            return Err(e);
        }
    };
    session.set_remote(Some(remote.display().to_string()))?;
    session.worker.sync_now();
    Ok(install(&app, &state, session))
}

/// Sync the open workspace through a new folder remote in `folder`,
/// instead of wherever it synced before. The whole history goes along.
#[tauri::command]
pub async fn sync_through_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: PathBuf,
) -> CmdResult<WorkspaceInfo> {
    let name = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("No workspace is open")?.info().name
    };
    let remote = new_folder_remote(&app, folder, name).await?;
    switch_remote(&state, Some(remote.display().to_string())).await
}

/// The open workspace's sync folder moved (Dropbox moved its folder, a
/// drive came back under another name): sync with it at `folder`, the
/// `.docsync` folder itself or one above it. A different workspace's
/// folder is refused.
#[tauri::command]
pub async fn locate_sync_folder(state: State<'_, AppState>, folder: PathBuf) -> CmdResult<WorkspaceInfo> {
    let found = blocking("locate_sync_folder", move || {
        Ok(cloud::workspaces_in(&folder, &cloud::detect()))
    })
    .await?;
    let remote = match found.as_slice() {
        [one] => one.path.clone(),
        [] => return Err("There's no sync folder there: look for a folder ending in “.docsync”.".into()),
        _ => return Err("There are several sync folders there: choose the one ending in “.docsync”.".into()),
    };
    switch_remote(&state, Some(remote.display().to_string())).await
}

/// Point the open workspace at `url` (or no remote), refusing one that
/// holds a different workspace, and leave a note so the other devices
/// follow (`session::prepare_move`). That fetches and syncs, so it runs
/// without holding the session: other commands carry on meanwhile.
async fn switch_remote(state: &State<'_, AppState>, url: Option<String>) -> CmdResult<WorkspaceInfo> {
    let (engine, plan, old) = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        (
            session.engine.clone(),
            session.plan_remote(url),
            session.info().remote,
        )
    };
    let plan = if plan.url.is_some() {
        let mut plan = plan;
        let checked = engine.clone();
        blocking("switch_remote", move || {
            session::prepare_move(&checked, old.as_deref(), &mut plan)?;
            let url = plan.url.as_deref().unwrap_or_default();
            checked
                .switch_remote(url, plan.layout.clone())
                .map_err(|e| e.to_string())?;
            Ok(plan)
        })
        .await?
    } else {
        plan
    };
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No workspace is open")?;
    if !Arc::ptr_eq(&session.engine, &engine) {
        return Err("Another workspace was opened meanwhile.".into());
    }
    session.remote_switched(plan)?;
    session.worker.sync_now();
    Ok(session.info())
}

/// After a sync: if another device moved the workspace, follow it there
/// once this device can reach the new place, and tell the window either
/// way. One check at a time; the next sync tries again.
async fn follow_move(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.following.swap(true, Ordering::SeqCst) {
        return;
    }
    let result = follow_move_now(&app, &state).await;
    state.following.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        devlog::warn("sync", format!("Couldn't follow the workspace: {e}"));
    }
}

async fn follow_move_now(app: &AppHandle, state: &AppState) -> CmdResult<()> {
    let (engine, note, current, was_moved) = {
        let mut guard = state.session.lock().unwrap();
        let Some(session) = guard.as_mut() else {
            return Ok(());
        };
        let was_moved = session.info().moved_to.is_some();
        let Some(note) = session.pending_move() else {
            if was_moved {
                let _ = app.emit("workspace-info", session.info());
            }
            return Ok(());
        };
        (session.engine.clone(), note, session.info().remote, was_moved)
    };
    let found = {
        let (engine, note) = (engine.clone(), note.clone());
        blocking("follow_move", move || {
            Ok(session::follow(&engine, &note, current.as_deref()))
        })
        .await?
    };
    let mut guard = state.session.lock().unwrap();
    let Some(session) = guard.as_mut() else {
        return Ok(());
    };
    if !Arc::ptr_eq(&session.engine, &engine) {
        return Ok(());
    }
    if session.moved(&note, found)? || was_moved != session.info().moved_to.is_some() {
        let _ = app.emit("workspace-info", session.info());
    }
    Ok(())
}

/// For a workspace whose folder is inside a cloud folder, which damages it:
/// move it to the default location, and if it doesn't sync yet, sync it
/// through a folder remote where it was instead.
#[tauri::command]
pub async fn move_out_of_cloud(app: AppHandle, state: State<'_, AppState>) -> CmdResult<WorkspaceInfo> {
    let (root, name, remote) = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        let info = session.info();
        (session.engine.root().to_path_buf(), info.name, info.remote)
    };
    let was_in = root
        .parent()
        .map(Path::to_path_buf)
        .ok_or("The workspace has no parent folder")?;
    let info = relocate(&app, &state, &workspaces_dir(&app)?).await?;
    if remote.is_some() {
        return Ok(info);
    }
    let remote = new_folder_remote(&app, was_in, name).await?;
    switch_remote(&state, Some(remote.display().to_string())).await
}

/// What deleting the open workspace would mean, for the confirmation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionInfo {
    name: String,
    path: String,
    remote: Option<String>,
    /// "owner/repo" when the remote is a GitHub repository the app can reach
    /// (and so could delete).
    github_repo: Option<String>,
    /// Changes that aren't on the remote, or no remote at all: deleting the
    /// folder would lose them.
    unsynced: bool,
}

#[tauri::command]
pub async fn workspace_deletion_info(state: State<'_, AppState>) -> CmdResult<DeletionInfo> {
    let info = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("No workspace is open")?.info()
    };
    blocking("workspace_deletion_info", move || {
        let git = crate::git::find_git()?;
        let unsynced = workspaces::unsynced(git.binary(), Path::new(&info.path));
        let github_repo = info
            .remote
            .as_deref()
            .and_then(github::repo_from_url)
            .filter(|repo| github::user().is_some() && github::can_reach(repo).unwrap_or(false));
        Ok(DeletionInfo {
            name: info.name,
            path: info.path,
            remote: info.remote,
            github_repo,
            unsynced,
        })
    })
    .await
}

/// Delete the open workspace from this device: its folder goes to the
/// Trash and it leaves the list. With `delete_repo`, its GitHub repository
/// is deleted first (if that fails, nothing else happens). Then the most
/// recently opened other workspace opens; `None` when there's none.
#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    delete_repo: bool,
) -> CmdResult<Option<WorkspaceInfo>> {
    let (root, remote) = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        (session.engine.root().to_path_buf(), session.info().remote)
    };
    if delete_repo {
        let repo = remote
            .as_deref()
            .and_then(github::repo_from_url)
            .ok_or("This workspace doesn't sync with a GitHub repository.")?;
        blocking("delete_workspace", move || github::delete_repo(&repo)).await?;
    }
    let session = state
        .session
        .lock()
        .unwrap()
        .take()
        .ok_or("No workspace is open")?;
    let events = WindowEvents(app.clone());
    let folder = root.clone();
    let trashed = blocking("delete_workspace", move || {
        // Stop syncing and watching before the files go.
        drop(session);
        match trash::delete(&folder) {
            Ok(()) => Ok(Ok(())),
            // Keep it open rather than leave the window with nothing.
            Err(e) => Ok(Err((
                format!("Couldn't move {} to the Trash: {e}", folder.display()),
                Session::open_or_create(&folder, events),
            ))),
        }
    })
    .await?;
    if let Err((message, reopened)) = trashed {
        if let Ok(session) = reopened {
            install(&app, &state, session);
        }
        return Err(message);
    }
    devlog::info("app", format!("Moved {} to the Trash", root.display()));
    update_settings(&app, |s| s.forget(&root));

    // Open the most recent other workspace that's still there.
    let next = load_settings(&app)
        .entries()
        .into_iter()
        .find(|e| !e.missing)
        .map(|e| PathBuf::from(e.path));
    let Some(next) = next else { return Ok(None) };
    let events = WindowEvents(app.clone());
    match blocking("delete_workspace", move || Session::open_or_create(&next, events)).await {
        Ok(session) => Ok(Some(install(&app, &state, session))),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn set_remote(state: State<'_, AppState>, url: Option<String>) -> CmdResult<WorkspaceInfo> {
    switch_remote(&state, url).await
}

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> CmdResult<Option<SyncStatus>> {
    let guard = state.session.lock().unwrap();
    Ok(guard.as_ref().and_then(|s| s.worker.last_status()))
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CmdResult<()> {
    let guard = state.session.lock().unwrap();
    guard.as_ref().ok_or("No workspace is open")?.worker.sync_now();
    Ok(())
}

// ---- GitHub -------------------------------------------------------------

/// The signed-in GitHub account, if any.
#[tauri::command]
pub async fn github_account() -> CmdResult<Option<GitHubUser>> {
    blocking("github_account", || Ok(github::user())).await
}

/// The sign-in the window is showing, by an id the window picks, and its
/// code once GitHub has sent it. Starting again, or cancelling, moves
/// `current` on, which stops an earlier attempt's wait.
struct SignIn {
    current: Option<u64>,
    code: Option<(u64, DeviceCode)>,
}

static SIGN_IN: Mutex<SignIn> = Mutex::new(SignIn {
    current: None,
    code: None,
});

fn is_current(attempt: u64) -> bool {
    SIGN_IN.lock().unwrap().current == Some(attempt)
}

/// Start signing in: a code for the user to enter on GitHub.
#[tauri::command]
pub async fn github_sign_in_start(attempt: u64) -> CmdResult<DeviceCode> {
    SIGN_IN.lock().unwrap().current = Some(attempt);
    let code = blocking("github_sign_in_start", github::start_device_flow).await?;
    let mut sign_in = SIGN_IN.lock().unwrap();
    if sign_in.current != Some(attempt) {
        return Err("Signing in was cancelled".into());
    }
    sign_in.code = Some((attempt, code.clone()));
    Ok(code)
}

/// Wait until the user approves the code `attempt` got. `None` when
/// signing in was cancelled or started again.
#[tauri::command]
pub async fn github_sign_in_finish(
    state: State<'_, AppState>,
    attempt: u64,
) -> CmdResult<Option<GitHubUser>> {
    let code = match &SIGN_IN.lock().unwrap().code {
        Some((a, code)) if *a == attempt => code.clone(),
        _ => return Ok(None),
    };
    let user = blocking("github_sign_in_finish", move || {
        github::finish_device_flow(&code, || !is_current(attempt))
    })
    .await?;
    if user.is_some() {
        state.account_changed();
    }
    Ok(user)
}

#[tauri::command]
pub async fn github_sign_in_cancel(attempt: u64) -> CmdResult<()> {
    let mut sign_in = SIGN_IN.lock().unwrap();
    if sign_in.current == Some(attempt) {
        sign_in.current = None;
        sign_in.code = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn github_sign_out(state: State<'_, AppState>) -> CmdResult<()> {
    blocking("github_sign_out", || {
        github::sign_out();
        Ok(())
    })
    .await?;
    state.account_changed();
    Ok(())
}

/// "browser" when this build signs in through the browser, "code" when it
/// uses the device flow (no client secret built in).
#[tauri::command]
pub async fn github_sign_in_mode() -> CmdResult<&'static str> {
    Ok(if github::browser_sign_in() {
        "browser"
    } else {
        "code"
    })
}

/// Sign in through the browser, then install the App if needed; emits
/// `github-sign-in-step` with "install" when the install page opens. `None`
/// when cancelled (with `github_sign_in_cancel(attempt)`).
#[tauri::command]
pub async fn github_sign_in_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    attempt: u64,
) -> CmdResult<Option<GitHubUser>> {
    SIGN_IN.lock().unwrap().current = Some(attempt);
    let emitter = app.clone();
    let user = blocking("github_sign_in_browser", move || {
        github::sign_in_with_browser(
            |url| tauri_plugin_opener::open_url(url, None::<&str>).map_err(text),
            || {
                let _ = emitter.emit("github-sign-in-step", "install");
            },
            || !is_current(attempt),
        )
    })
    .await?;
    if user.is_some() {
        state.account_changed();
        // Back from the browser.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    Ok(user)
}

/// Workspaces in the repositories the App can reach, to join.
#[tauri::command]
pub async fn github_workspaces() -> CmdResult<Vec<RemoteWorkspace>> {
    blocking("github_workspaces", github::workspaces).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewGitHubWorkspace {
    workspace: WorkspaceInfo,
    /// The repository, unless creating it failed (then `problem` says why
    /// and the workspace is only on this device for now).
    full_name: Option<String>,
    problem: Option<String>,
    reachable: bool,
    manage_url: Option<String>,
}

/// A new workspace that syncs with a new private repository.
#[tauri::command]
pub async fn create_github_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CmdResult<NewGitHubWorkspace> {
    let session = new_local_workspace(&app, "create_github_workspace", name).await?;
    let workspace_name = session.info().name;
    install(&app, &state, session);
    let created = blocking("create_github_workspace", move || {
        let repo = github::create_private_repo(&workspace_name)?;
        let reachable = github::can_reach(&repo.full_name).unwrap_or(true);
        let manage_url = github::access().ok().map(|a| a.manage_url);
        Ok((repo, reachable, manage_url))
    })
    .await;
    Ok(match created {
        Ok((repo, reachable, manage_url)) => NewGitHubWorkspace {
            workspace: switch_remote(&state, Some(repo.clone_url.clone())).await?,
            full_name: Some(repo.full_name),
            problem: None,
            reachable,
            manage_url,
        },
        Err(problem) => {
            let guard = state.session.lock().unwrap();
            let session = guard.as_ref().ok_or("No workspace is open")?;
            NewGitHubWorkspace {
                workspace: session.info(),
                full_name: None,
                problem: Some(problem),
                reachable: false,
                manage_url: None,
            }
        }
    })
}

/// Whether the GitHub App is installed on the user's account.
#[tauri::command]
pub async fn github_access() -> CmdResult<Access> {
    blocking("github_access", github::access).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRepo {
    workspace: WorkspaceInfo,
    /// "ada/My-Notes".
    full_name: String,
    /// False when the App can't reach the new repository (it's installed on
    /// chosen repositories only): syncing waits until the user adds it.
    reachable: bool,
    manage_url: String,
}

/// Create a private GitHub repository for the open workspace and sync with
/// it, instead of wherever it synced before.
#[tauri::command]
pub async fn github_create_repo(state: State<'_, AppState>) -> CmdResult<CreatedRepo> {
    let name = {
        let guard = state.session.lock().unwrap();
        let session = guard.as_ref().ok_or("No workspace is open")?;
        session.info().name
    };
    let (repo, reachable, manage_url) = blocking("github_create_repo", move || {
        let repo = github::create_private_repo(&name)?;
        let reachable = github::can_reach(&repo.full_name).unwrap_or(true);
        let manage_url = github::access()
            .map(|a| a.manage_url)
            .unwrap_or_else(|_| github::install_url());
        Ok((repo, reachable, manage_url))
    })
    .await?;
    Ok(CreatedRepo {
        workspace: switch_remote(&state, Some(repo.clone_url.clone())).await?,
        full_name: repo.full_name,
        reachable,
        manage_url,
    })
}

// ---- pages ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    id: String,
    title: String,
    body: String,
    conflicts: Vec<Conflict>,
    display: PageDisplay,
    /// Set for a page that shows a database instead of text.
    database: Option<DatabasePageInfo>,
    /// Typed properties: a regular page's own, or a row's cells.
    properties: Properties,
    /// Set when the page is a row of a database.
    row: Option<RowOf>,
    /// Opening it moved front matter into meta.json, which may have changed
    /// the title: the page list should be reread.
    meta_changed: bool,
}

/// How a page is shown; `None` is the default. Kept in its meta.json, so it
/// syncs with the page.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDisplay {
    /// "full": as wide as the window.
    width: Option<String>,
    /// "small" or "large".
    text_size: Option<String>,
}

/// The values each display option may take (anything else reads as the default).
const DISPLAY_OPTIONS: &[(&str, &[&str])] = &[("width", &["full"]), ("textSize", &["small", "large"])];

fn display_option(meta: &serde_json::Value, key: &str) -> Option<String> {
    let value = meta["display"][key].as_str()?;
    let allowed = DISPLAY_OPTIONS.iter().find(|(k, _)| *k == key)?.1;
    allowed.contains(&value).then(|| value.to_string())
}

#[derive(Debug, Serialize)]
pub struct Conflict {
    versions: Vec<ConflictVersion>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersion {
    /// Who wrote it, as plain text: "Anna Smith (Laptop)".
    label: String,
    /// The same in parts, when the block says: the person, if they were
    /// signed in, and their device, each with an id where it's known
    /// (`github:<id>` for a person, the app install's for a device), to
    /// match the reader by rather than by name.
    person: Option<String>,
    person_id: Option<String>,
    device: Option<String>,
    device_id: Option<String>,
    text: String,
}

fn conflicts_in(body: &str) -> Vec<Conflict> {
    find_conflicts(body)
        .into_iter()
        .map(|block| Conflict {
            versions: block
                .versions
                .into_iter()
                .map(|v| {
                    let ids = match &v.label {
                        VersionLabel::By(w) => (w.person_id.clone(), w.device_id.clone()),
                        VersionLabel::Text(_) => (None, None),
                    };
                    ConflictVersion {
                        label: v.label.to_string(),
                        person: v.label.person().map(String::from),
                        person_id: ids.0,
                        device: v.label.device().map(String::from),
                        device_id: ids.1,
                        text: v.text,
                    }
                })
                .collect(),
        })
        .collect()
}

/// A page, or a database row as a page.
fn read_page_from(ws: &Workspace, id: &str) -> CmdResult<Page> {
    let (title, meta, properties, row) = match page_properties::kind(ws, id)? {
        Kind::Page => {
            let meta = ws.read_page_meta(id).unwrap_or_default();
            let title = docsync::workspace::page_name(&meta).to_string();
            let properties = page_properties::page_properties(&meta);
            (title, meta, properties, None)
        }
        Kind::Row { database } => {
            let (title, json, properties, row) = page_properties::row_parts(ws, &database, id)?;
            (title, json, properties, Some(row))
        }
    };
    let body = ws.read_body(id).unwrap_or_default();
    Ok(Page {
        id: id.to_string(),
        title,
        conflicts: conflicts_in(&body),
        body,
        display: PageDisplay {
            width: display_option(&meta, "width"),
            text_size: display_option(&meta, "textSize"),
        },
        database: if row.is_some() {
            None
        } else {
            database_pages::info(ws, &meta)
        },
        properties,
        row,
        meta_changed: false,
    })
}

#[tauri::command]
pub async fn list_pages(state: State<'_, AppState>) -> CmdResult<Vec<PageSummary>> {
    let (engine, _) = state.engine()?;
    blocking("list_pages", move || {
        tree::list_pages(&Workspace::new(engine.root())).map_err(text)
    })
    .await
}

#[tauri::command]
pub async fn read_page(state: State<'_, AppState>, id: String) -> CmdResult<Page> {
    let (engine, edited) = state.engine()?;
    blocking("read_page", move || {
        // Front matter written by another tool or an agent: the editor can't
        // show it, so it moves into meta.json before the page reaches it.
        let lifted = match engine.lift_front_matter(&id) {
            Ok(lifted) => lifted,
            Err(e) => {
                devlog::warn("app", format!("Couldn't move front matter of page {id}: {e}"));
                false
            }
        };
        if lifted {
            devlog::info("app", format!("Moved front matter of page {id} into meta.json"));
            edited();
        }
        let mut page = read_page_from(&Workspace::new(engine.root()), &id)?;
        page.meta_changed = lifted;
        Ok(page)
    })
    .await
}

/// What an import created, for the window.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// The pages made for what was chosen; the first is opened.
    pages: Vec<String>,
    page_count: usize,
    asset_count: usize,
    /// Names of the files that couldn't be imported.
    skipped: Vec<String>,
}

/// Import Markdown files and folders as pages under `parent`.
#[tauri::command]
pub async fn import_markdown(
    state: State<'_, AppState>,
    sources: Vec<PathBuf>,
    parent: Option<String>,
) -> CmdResult<ImportResult> {
    let (engine, edited) = state.engine()?;
    blocking("import_markdown", move || {
        let report = engine
            .import_markdown(&sources, parent.as_deref())
            .map_err(text)?;
        devlog::info(
            "app",
            format!(
                "Imported {} pages and {} files from {} places ({} skipped)",
                report.page_count,
                report.asset_count,
                sources.len(),
                report.skipped.len()
            ),
        );
        if report.page_count > 0 {
            edited();
        }
        Ok(ImportResult {
            pages: report.pages,
            page_count: report.page_count,
            asset_count: report.asset_count,
            skipped: report
                .skipped
                .iter()
                .map(|p| {
                    p.file_name()
                        .unwrap_or(p.as_os_str())
                        .to_string_lossy()
                        .into_owned()
                })
                .collect(),
        })
    })
    .await
}

/// Pages whose text contains `query`, for the search palette.
#[tauri::command]
pub async fn search_text(state: State<'_, AppState>, query: String) -> CmdResult<Vec<TextMatch>> {
    let (engine, _) = state.engine()?;
    blocking("search_text", move || {
        search::search_text(&Workspace::new(engine.root()), &query, 50).map_err(text)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteResult {
    /// Written as given. `conflicts` are the blocks still in the page.
    Written {
        conflicts: Vec<Conflict>,
    },
    /// The page changed on disk meanwhile and was merged; reload `page`.
    Merged {
        page: Box<Page>,
    },
    Gone,
}

/// Save a page edited from `base` (the body as the editor loaded it).
#[tauri::command]
pub async fn write_page(
    state: State<'_, AppState>,
    id: String,
    base: String,
    body: String,
) -> CmdResult<WriteResult> {
    let (engine, edited) = state.engine()?;
    blocking("write_page", move || {
        let write = engine.write_page_body(&id, &base, &body).map_err(text)?;
        edited();
        match &write {
            PageWrite::Written => devlog::debug("save", format!("Wrote page {id} ({} chars)", body.len())),
            PageWrite::Merged { conflicts, .. } => devlog::info(
                "save",
                format!("Page {id} changed on disk since it was opened: merged both ({conflicts} conflicts)"),
            ),
            PageWrite::PageGone => {
                devlog::warn("save", format!("Page {id} was deleted elsewhere; not written"))
            }
        }
        Ok(match write {
            PageWrite::Written => WriteResult::Written {
                conflicts: conflicts_in(&body),
            },
            PageWrite::Merged { .. } => WriteResult::Merged {
                page: Box::new(read_page_from(&Workspace::new(engine.root()), &id)?),
            },
            PageWrite::PageGone => WriteResult::Gone,
        })
    })
    .await
}

#[tauri::command]
pub async fn create_page(
    state: State<'_, AppState>,
    title: String,
    parent: Option<String>,
) -> CmdResult<String> {
    let (engine, edited) = state.engine()?;
    blocking("create_page", move || {
        let id = Workspace::new(engine.root())
            .create_page(&title, parent.as_deref())
            .map_err(text)?;
        devlog::info("app", format!("Created page {id}"));
        edited();
        Ok(id)
    })
    .await
}

/// Move a page in the sidebar: under `parent` (null: the top level), with
/// the positions that put it in its place (see `tree::move_page`).
#[tauri::command]
pub async fn move_page(
    state: State<'_, AppState>,
    id: String,
    parent: Option<String>,
    positions: std::collections::BTreeMap<String, Option<f64>>,
) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("move_page", move || {
        tree::move_page(&Workspace::new(engine.root()), &id, parent.as_deref(), &positions)?;
        devlog::info("app", format!("Moved page {id}"));
        edited();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn rename_page(state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("rename_page", move || {
        page_properties::set_title(&Workspace::new(engine.root()), &id, &title)?;
        devlog::debug("app", format!("Renamed page {id}"));
        edited();
        Ok(())
    })
    .await
}

/// Change how a page is shown: `key` is "width" or "textSize", and `value`
/// null puts it back to the default.
#[tauri::command]
pub async fn set_page_display(
    state: State<'_, AppState>,
    id: String,
    key: String,
    value: Option<String>,
) -> CmdResult<()> {
    let Some((_, allowed)) = DISPLAY_OPTIONS.iter().find(|(k, _)| *k == key) else {
        return Err(format!("Unknown page option “{key}”."));
    };
    if value.as_deref().is_some_and(|v| !allowed.contains(&v)) {
        return Err(format!(
            "“{}” isn't a choice for {key}.",
            value.unwrap_or_default()
        ));
    }
    let (engine, edited) = state.engine()?;
    blocking("set_page_display", move || {
        Workspace::new(engine.root())
            .set_page_display(&id, &key, value.clone().map(serde_json::Value::from))
            .map_err(text)?;
        devlog::debug(
            "app",
            format!("Page {id}: {key} = {}", value.as_deref().unwrap_or("default")),
        );
        edited();
        Ok(())
    })
    .await
}

/// Delete a page with the pages inside it. A database page takes its
/// database with it, unless a page that stays shows it too.
#[tauri::command]
pub async fn delete_page(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let (engine, edited) = state.engine()?;
    blocking("delete_page", move || {
        let ws = Workspace::new(engine.root());
        if let Kind::Row { database } = page_properties::kind(&ws, &id)? {
            ws.delete_row(&database, &id).map_err(text)?;
            devlog::info("app", format!("Deleted row {id} of database {database}"));
            edited();
            return Ok(());
        }
        let (pages, databases) = tree::delete_page_tree(&ws, &id).map_err(text)?;
        devlog::info(
            "app",
            format!(
                "Deleted page {id} with {} pages inside it and {} databases",
                pages.len() - 1,
                databases.len()
            ),
        );
        edited();
        Ok(())
    })
    .await
}

/// Keep version `keep` of conflict block `index`, and return the page.
#[tauri::command]
pub async fn resolve_conflict(
    state: State<'_, AppState>,
    id: String,
    index: usize,
    keep: usize,
) -> CmdResult<Page> {
    let (engine, edited) = state.engine()?;
    blocking("resolve_conflict", move || {
        engine.resolve_page_conflict(&id, index, keep).map_err(text)?;
        devlog::info(
            "app",
            format!("Resolved conflict {index} on page {id}: kept version {keep}"),
        );
        edited();
        read_page_from(&Workspace::new(engine.root()), &id)
    })
    .await
}

// ---- developer panel ---------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevInfo {
    /// Whether the developer panel is available (debug builds, or DOCSYNC_DEV=1).
    enabled: bool,
    version: String,
    debug_build: bool,
    os: String,
    git: Option<String>,
    workspace: Option<WorkspaceInfo>,
}

#[tauri::command]
pub async fn dev_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<DevInfo> {
    let workspace = state.session.lock().unwrap().as_ref().map(Session::info);
    Ok(DevInfo {
        enabled: devlog::enabled(),
        version: app.package_info().version.to_string(),
        debug_build: cfg!(debug_assertions),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        git: crate::git::description(),
        workspace,
    })
}

#[tauri::command]
pub async fn dev_log_entries() -> CmdResult<Vec<Entry>> {
    Ok(devlog::entries())
}

#[tauri::command]
pub async fn dev_log_clear() -> CmdResult<()> {
    devlog::clear();
    Ok(())
}

/// Show the log file in Finder (or the system's file manager).
#[tauri::command]
pub async fn show_log_file() -> CmdResult<()> {
    let path = devlog::file_path().ok_or_else(|| "There is no log file.".to_string())?;
    blocking("show_log_file", move || {
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(text)
    })
    .await
}

/// An entry from the window (saves, reloads, errors it showed).
#[tauri::command]
pub async fn dev_log_add(level: Level, source: String, message: String) -> CmdResult<()> {
    devlog::log(level, &source, message);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::display_option;
    use serde_json::json;

    #[test]
    fn display_options_outside_the_known_choices_read_as_the_default() {
        let meta = json!({"display": {"width": "full", "textSize": "huge"}});
        assert_eq!(display_option(&meta, "width").as_deref(), Some("full"));
        assert_eq!(display_option(&meta, "textSize"), None);
        assert_eq!(display_option(&json!({"title": "x"}), "width"), None);
    }
}
