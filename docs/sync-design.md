# Sync design

The `docsync` crate (`crates/docsync`) keeps a workspace of plain files in sync
between devices through any git remote. Users never see commits, branches or
conflict markers.

A **workspace**, here and in the code, is one git repository. In the product
a company has several of them, called **spaces**
([product-design.md](product-design.md#spaces)); the engine syncs each one on
its own.

## On-disk format

```text
workspace.json                      workspace settings: {"format", "name"}
pages/<page-id>/meta.json           {"id", "name", "parent", "position"?, "properties": {...}, "display": {...}, "row"?: {...}}
pages/<page-id>/page.md             page body (Markdown)
pages/<page-id>/assets/...          attachments
databases/<db-id>/schema.json       {"id", "name", "columns": {"<col-id>": {"name", "type", "position", "options"}}}
.docsync/                           per-device state (search index, caches), git-ignored
```

The format is designed so most concurrent edits never conflict:

- **One file per page and per database row.** Edits to different pages or rows
  touch different files.
- **Paths come from random ids, never titles.** Renaming or moving a page
  changes a JSON field, not a path. Rename detection is turned off entirely.
- **Canonical JSON.** Keys are sorted, one field per line, so git merges edits
  to different fields line by line.
- **No central index.** The hierarchy lives in each page's `parent` field, so
  there is no single file everyone edits.

Everything stays readable and editable without the app.

**The format has a version:** the `"format"` field of `workspace.json`
(`docsync::WORKSPACE_FORMAT`, now 3; a workspace without the field is
format 1). Format 2 made database rows pages of their own; format 1 kept
them in `databases/<db-id>/rows/`. Format 3 renamed a page's `title` field
to `name` and gave every database a title column, whose cell is the row
page's `name`. The engine moves a
workspace's files to the current format when it opens, joins or syncs it,
and moves rows in the old layout that arrive from a device not yet updated
(`Workspace::move_rows_into_pages`, `Workspace::rename_title_fields`,
`Workspace::give_databases_titles`). A page that still says `title` (a
hand edit, an agent) reads as its name until then. A change that older versions of the app would misread raises it
and comes with a migration. A version that finds a newer format than it
knows changes nothing: it won't open the workspace, join it, or take in
changes from a device that has moved it on (`Error::NewerFormat`), and the
app says to update. Its own edits stay committed locally until it is
updated. This matters as soon as two versions of the app share a
workspace, such as an installed release and a development build, or two
devices updated at different times (`tests/format.rs`).

Database columns are an object keyed by column id, so adding, renaming or
retyping different columns on two devices touches different fields. Their
order is each column's `position` and a row's is its own `position` (the
time it was added), so moving one changes one number. Cells are keyed by
column id, so renaming a column never touches the rows; removing one leaves
its cells in the rows, ignored. Types are `text`, `number`, `checkbox`,
`select` (with `options`), `date` (`YYYY-MM-DD`) and `url`; an empty cell
has no key. Reading is lenient: an unknown type reads as text, and the first
format (`"columns": ["name", ...]`) still reads and is rewritten on the next
column change (`docsync::database`).

Every database row is a page, as in Notion: a page like any other in
`pages/`, with its text, attachments and display options, whose `row` field
says which database it's in: `{"database": "<db-id>", "position": <n>}`.
A view whose rows are ordered by hand (a board whose cards were dragged)
keeps its own order there too, in `"positions": {"<view-id>": <n>}`: a row
without a position in a view sits where its own `position` puts it, so
dropping a card between two others writes one number in one row, and two
devices moving different cards, or one card in different views, merge.
Positions of a view that was deleted stay behind, unused.
Its cells are its `properties`, keyed by column id, with the database's
columns as their types. Its name is its page's `name`, like any page's,
shown in the database's title column (type `"title"`, called "Name" when
it's made): one per database, which can be renamed and moved but not
deleted or retyped, as in Notion. Rows don't
show in the page tree. A row is its own entity for sync, but a database and
its rows are restored together: deleting a database (which deletes its
rows) on one device while one of its rows is edited or added on another
brings back the database with every row it had. Any page can have typed
properties too: `meta.json` keeps their values in `properties` and their
types in `property_schema`, in the format of a database's `columns`. A
value without a type (front matter, an agent) reads as a text property
named by its key.

A database page is a page whose `meta.json` has a `database` field:
`{"id": "<db-id>", "views": {"<view-id>": {"name", "type", "position",
"sort", "groupBy"}}}`. Views are keyed by id like columns, so two devices
changing different views, or different settings of one view, merge
cleanly (`docsync::database_page`).

Metadata lives in `meta.json`, never in YAML front matter at the top of
`page.md`, since the editor can't show it. Front matter written by another
tool or an AI agent moves into `meta.json` when the page is opened
(`Workspace::lift_front_matter`): `title` (or else `name`) becomes the
page's name and every other
field a property, replacing what was there, since the front matter is newer.
Two devices doing this at once make the same change, which merges cleanly.
Importing Markdown files and folders does the same for each file
(`docsync::import`).

Planned additions to the format: `agents/`
([agents-design.md](agents-design.md#the-format-draft)), and people, threads
and tasks ([roadmap step 7](roadmap.md#7-spaces-people-and-the-inbox)).

A page or database exists only if its `meta.json` or `schema.json` exists.
Git doesn't track folders, so an emptied folder can stay on disk after its
files were synced away. Readers must ignore such folders.

## The sync loop

`SyncEngine::sync()` does the following:

1. Takes an exclusive lock (`.git/docsync.lock`). The app, an MCP server and a
   CLI can share one workspace safely.
2. Removes stale git lock files left by a crashed process.
3. Commits all local edits.
4. Fetches. If the remote is unreachable, it stops here with `offline: true`.
   Edits are committed locally and go out on the next sync. When git's
   message says the remote refused this device (no or wrong credentials, no
   access, "repository not found"), `docsync::git::is_access_denied` tells
   the app, which asks the user to sign in instead of showing "Offline".
5. Then one of four cases:
   - **Up to date:** nothing to do.
   - **Local is ahead:** push.
   - **Remote is ahead:** fast-forward the working tree.
   - **Both changed:** merge (below), then push.
6. If the push is rejected because another device pushed in between, it goes
   back to step 4, up to `max_attempts` times.

The merge runs entirely in git's object database (`git merge-tree
--write-tree`). The working tree is only touched once the final merged commit
exists. That step uses `git read-tree -m -u`, which refuses to overwrite files
the user changed in the meantime. In that case the engine commits those edits
and retries, so typing during a sync is safe.

The working tree is updated *before* the branch ref. If the process dies in
between, the next sync records the new files as local edits on the old commit,
and that merges cleanly. The reverse order would make the next commit undo the
other device's changes. The crash tests catch exactly that bug.

## Conflict rules

| Situation | Resolution |
|---|---|
| Different lines of a page edited | Normal line merge |
| Same lines of a page edited | Both versions kept in a conflict block (below) |
| Different JSON fields edited | Field-by-field merge |
| Same JSON field edited | Most recent edit wins (a tie goes to the version already on the remote) |
| Field removed on one side, changed on the other | The change wins |
| File edited on one side, deleted on the other | The edit wins |
| Page or database deleted on one side, anything in it changed on the other | The whole page or database is restored |
| Database deleted on one side, one of its rows changed or added on the other | The database is restored with all its rows |
| Attachment changed on both sides | Newest keeps the path, the other is saved as `name.conflict-<device>-<id>.ext` |
| JSON invalid on one side (hand-edited) | The valid version wins; the broken one is kept as a conflict copy |

"Most recent" means the commit time of the commit that last set that particular
field, so the app should call `commit_local()` shortly after each edit. Commit
times come from the device clocks, so a device with a badly wrong clock can win
ties it shouldn't. The losing value always remains in history.

Column widths of a table, which GFM can't express, are an HTML comment on
the line above it: `<!-- table-widths: 120px 200px -->` for fixed widths, or
`<!-- table-widths: 40% 60% -->` for a table as wide as the page, or
`<!-- table-widths: full -->` for one as wide as the page with its columns
shared by content. A table that follows its content has none. Changing widths changes only that line.

Conflict blocks are HTML comments, so a page is still valid Markdown:

```markdown
<!-- sync-conflict:start -->
<!-- sync-conflict:version person="Anna Smith" person-id="5e6d7f803f9a1c2b" device="Laptop" device-id="3f9a1c2b" -->
Anna's version, written on her laptop.
<!-- sync-conflict:version device="Desktop" device-id="7c01e5aa" -->
The version from a desktop nobody was signed in on.
<!-- sync-conflict:end -->
```

Each version says who wrote it: the person, when the device was signed in,
and the device (`text_merge::VersionLabel`). Both come from the newest
commit that changed the page on that side of the merge: its author is the
person, or the device when nobody was signed in, and its committer is always
the device (`<slug>+<device id>@devices.invalid`). So the label is right even when the
device was renamed or signed out between the edit and the sync, and with a
folder remote, where one side of a merge can hold another device's edits.
Commits from before devices were recorded name only the person.

Each name comes with an id where one is known, and "You" is decided by id,
so two people or devices with the same name are never mixed up. A person's
id is ours, not a Git host's, and each commit records it in a `Person-Id:`
trailer (`docsync::Person`), which merges read back. The desktop app decides
it (`apps/desktop/src-tauri/src/person.rs`):

- Signed in (to GitHub, for now), we know who you are: the id is derived
  from the account's no-reply address, in every workspace, whether it's
  kept in a Git repository or synced through a cloud folder.
- Otherwise, in a workspace kept in a Git repository (any URL), it's
  derived from Git's own `user.email`, the email commits go by there.
- Otherwise, as through a cloud folder such as Dropbox, persons aren't
  linked: the id is the app install's own, made once, and commits carry a
  placeholder email (`<id>@people.invalid`).

The same email gives the same id on every device, so a person's devices are
linked, without the email itself appearing in pages.

The person's name is a setting (Settings › Account), filled in from the
GitHub account or Git's `user.name` until changed. With no name at all,
commits are by the device, as before. A device's id is the desktop
app's id for its install, recorded in the committer email
(`SyncConfig::device_id`), so it survives renaming the device. Names are
only compared for versions without ids, in blocks written before ids were
recorded. A marker may
also hold plain text: "Changed elsewhere" for the file's side when a save
merges with it (`SyncEngine::write_page_body`), or a device name in a block
written by an older version.

The editor draws a block as one frame, with a bar over each version that
names the person ("You" for whoever is reading) and the device, and buttons
to keep one version or both (`packages/editor/src/conflicts.ts`). A device
is named after the computer until the user renames it in Settings; the name
is kept in the app's `settings.json`, for every workspace on that device.
Every resolution is listed in `SyncReport::conflicts` and in the merge commit
message.

## Git binary

`CliGit` runs a specific `git` executable. The desktop app ships its own copy,
so users never install git and every machine behaves the same. Git 2.43 or
newer is required (`CliGit::check_version`). Global and system git
configuration are ignored. Settings the app needs, such as an auth header, go
in through `CliGit::with_config`, which passes them via environment variables
so tokens don't show up in process listings.

The engine only talks to git through the `GitBackend` trait, which has about
20 small operations. An embedded backend such as gitoxide could replace
`CliGit` later and be verified by the same test suite.

## Where workspaces live and what they sync with

### The local copy

Each device keeps its own working copy of a workspace. Unless the user picks
a folder, it goes in the app's local data folder:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/<app>/workspaces/<name>` |
| Windows | `%LOCALAPPDATA%\<app>\workspaces\<name>` |
| Linux | `~/.local/share/<app>/workspaces/<name>` |

Not `~/Documents`: on many Macs iCloud syncs it ("Desktop & Documents
Folders"), and on Windows OneDrive often does, which would put a working copy
with `.git` inside a cloud folder (see below). The app's data folder is never
synced, never triggers a macOS permission prompt, and Time Machine and File
History still back it up. Not Windows' Roaming folder either: roaming profiles
copy it between machines.

The files stay one click away: "Show in Finder" (Explorer, Files) in the sync
panel, and the folder path there opens it too. Users who want control can
choose a location when creating or joining a workspace, or open any folder
that holds one. Folder names come from the workspace name, made safe for every
platform; a name that's taken gets a number ("My Notes 2"). The code is in
`apps/desktop/src-tauri/src/locations.rs`.

### Renaming

The workspace's name is the `name` field in `workspace.json`, so it syncs like
any other field: every device and every collaborator sees the same name, and
if two people rename at once the newest edit wins. A new workspace stores its
name when it's created; one made before names were stored shows its folder
name until someone renames it.

Renaming never touches folders or remotes. The local folder is an internal
detail like a page id: renaming it would disturb the file watcher, the sync
lock and the remembered last workspace, fails on Windows while a file is open,
and may be a folder the user chose and named. Renaming a `.docsync` folder in
iCloud would break every other device's remote path. "Move…" can later suggest
the current name as the new folder name. Discovery of `*.docsync` workspaces
should read the name with `git show HEAD:workspace.json`, not use the folder
name.

In the app, clicking the name in the sidebar header edits it in place: Enter
or leaving the field saves, Escape cancels, an empty name keeps the old one. A
rename from another device shows up after the next sync.

Still to build: a check that offers a safe setup when the chosen location
is inside a cloud folder.

### The workspace list

Each device keeps a list of the workspaces it has opened in the app's
`settings.json` (never synced), with each one's name as last seen, so a
workspace whose folder has gone (moved in Finder, a drive that isn't
plugged in) still shows by name. Clicking the workspace name in the sidebar
opens the list to switch; the welcome screen shows it too. A missing folder
offers "Locate…" (pick where it is now) and "Remove from list", which never
deletes files. Paths are compared through their real location, so the same
folder is never listed twice. The code is in
`apps/desktop/src-tauri/src/workspaces.rs`.

"Move…" in the sync panel moves the open workspace into a new folder, named
after it, inside a folder the user picks. It first stops the worker and the
file watcher, which waits for a running sync and commits pending edits, so
nothing writes while files move. Moving is a rename on the same disk and a
copy followed by removing the original across disks; if the copy fails, the
partial copy is removed and the workspace reopens where it was. Everything
moves together: history, the per-device remote in `.docsync/app.json` and
the search index. Other devices don't notice, since remotes never point at a
working copy.

"Delete workspace…" in the workspace menu deletes the open workspace from
this device: the worker and watcher stop, the folder goes to the Trash (so
it can be put back) and it leaves the list, then the most recently opened
other workspace opens, or onboarding when there's none. The confirmation
says what would be lost: changes that haven't synced, or a workspace that
syncs nowhere, would only be in the Trash. Deleting the GitHub repository
too is a separate checkbox, off by default and only offered when the app
can reach the repository; it's deleted first, and if GitHub refuses (only
an owner or admin can), nothing else happens. GitHub keeps a deleted
repository restorable for 90 days. Every other device then fails to sync
and keeps its copy.

### Never a working copy inside a cloud folder

Putting the workspace in Dropbox, iCloud Drive or OneDrive looks like the
obvious way to sync, and it breaks:

- Those services copy files one by one, in no particular order. Git expects
  its index, refs and objects to change together. A half-copied index, or a
  ref that arrives before its objects, corrupts the repository; two devices
  writing at once leave files like `index (conflicted copy)`.
- Two sync systems edit the same files. Dropbox replaces `page.md` while the
  engine merges it, and the conflict rules above stop applying.
- iCloud's "Optimize Mac Storage" removes local copies of files it thinks are
  unused, so git and the file watcher see files go missing.
- `.docsync/`, which must stay on one device, would sync too.

### Signing in with GitHub

The app signs in through a GitHub App ("Sawmill Desktop", the working
title). The App asks for Contents, Metadata, Administration (to create
repos) and Pages on repositories only; it can reach only the repositories
the user installs it on, unlike an OAuth app's `repo` scope. Signing in and
installing are two steps on GitHub: signing in lets the app act as the
user, installing picks the repositories.

- **One button for everyone.** "Continue with GitHub" opens GitHub's
  sign-in page with PKCE, sending the browser back to a listener on a
  random port of 127.0.0.1. Someone who authorized the App before comes
  straight back without a click. Then, if the App isn't installed on the
  user's account, the app opens the install page for that account
  (`installations/new/permissions?target_id=<id>`), and the dialog says so.
  The install page always returns to the callback URL as registered,
  `http://127.0.0.1:48159/callback` (GitHub ignores the port of 127.0.0.1
  callbacks for the sign-in page, so one URL serves both); if that port is
  taken, the app notices the installation by asking every few seconds.
  Starting at the install page instead would save a new user the Authorize
  click, but sends someone who has installed it before to their
  installation's settings with no way back, so it isn't used.
- **The client secret.** Exchanging a code needs the App's client secret,
  even with PKCE. It is built in from the gitignored file
  `apps/desktop/src-tauri/github-client-secret` or the
  `SAWMILL_GITHUB_CLIENT_SECRET` variable (see `build.rs`), never kept in
  git. A desktop app can't keep it secret, and that's accepted: PKCE, the
  state check and callbacks that only go to 127.0.0.1 protect a sign-in,
  not the secret. Forks register their own GitHub App. A build without the
  secret signs in with the device flow instead (a code entered at
  github.com/login/device).

- **Tokens.** The access token lasts 8 hours and the refresh token 6 months.
  Both are kept in the system keychain (service: the app identifier), never
  in a file. Debug builds are the exception: they use `dev-sign-in.json` in
  the app's config folder (mode 600), because macOS ties a keychain item to
  the signature of the program that saved it, and an unsigned build's
  signature changes with every rebuild, so each one would ask for the
  keychain password. A background thread renews the access token 15 minutes before
  it expires; git commands never wait on the network for it. If renewing is
  refused (revoked, or 6 months unused), the app signs out and the panel
  offers to sign in again.
- **Git.** `CliGit::with_config_source` reads the token before every git
  command and passes `http.https://github.com/.extraHeader` through the
  environment, so it reaches github.com only and never lands in
  `.git/config`, remote URLs or process listings. GitHub HTTPS remotes need
  nothing else; SSH remotes are unaffected.
- **Commits.** While signed in, new commits in every workspace are by the
  person's name and the account's no-reply address
  (`<id>+<login>@users.noreply.github.com`, `SyncEngine::set_person`). The
  committer is always the device, so history and conflict blocks can say
  which of a person's devices an edit came from. See
  [Conflict rules](#conflict-rules) for the person's id.
- **Finding workspaces.** After signing in, onboarding lists the workspaces
  in the repositories the App can reach, to join with one click: those with
  the `sawmill-workspace` topic (set on the repos the app creates) and up
  to 40 others with a `workspace.json` at the top. Ones this device already
  has are left out.
- **A repo in one click.** "Start a new workspace" in onboarding, and
  "Create a private repo on GitHub" in the sync panel, create `<workspace name>` (or `-2`, `-3`… when taken) on the user's
  account, sets it as the remote and syncs. GitHub adds a repo the App
  creates to an installation limited to chosen repositories, so it syncs at
  once (tested with both installation settings). In case that ever changes,
  the app checks `GET /repos/<owner>/<name>` afterwards; if it can't reach
  the repo, the panel says so and links to the installation's settings.

### Sync targets

Every target is a git remote, so the engine is the same for all of them:

| Target | For | Remote |
|---|---|---|
| None | One device | No remote. Adding one later pushes the whole history. |
| Cloud folder | Individuals, small teams on a shared folder | A bare repo in the folder, e.g. `~/Dropbox/My Notes.docsync`, as a `file://` remote |
| GitHub | People with GitHub accounts | A private repo the app creates after GitHub sign-in |
| Git URL | Developers | Any URL, under "Advanced" |
| Hosted (later) | Teams without GitHub | Our own git-over-HTTPS service with email accounts |

In the app this is one setting, `none | folder | github | git_url | hosted`,
that can be changed at any time. The status bar names it ("Synced via iCloud
Drive") rather than anything about git.

Hosted isn't being built for now. The decision on 2026-11-25 was to go
without a server of our own and add one later, with a public release
([product-design.md](product-design.md#servers)).

### Cloud folder remotes

A cloud folder only carries git objects, which are named by their content and
never change, so they survive being copied in any order. The refs are the
problem: two devices pushing at about the same time would both write
`refs/heads/main`, and the push retry above can't help because the other
device's push arrives seconds later. So a folder remote follows the same rule
as the file layout, one writer per file:

- **Each device writes only its own ref,**
  `refs/heads/devices/<device-id>`. Syncing fetches every device's ref,
  merges them locally with the usual `merge-tree` path, and publishes the
  result as this device's ref. No file in the shared repo has two writers,
  so nobody's publish is ever rejected and no retry loop is needed.
- **Publishing doesn't use `git push`.** git's receive-pack refuses every
  push while any ref in the repo points at objects that are missing, which
  is exactly the state a cloud folder is in whenever another device's ref
  has arrived before its pack. Instead the engine writes one new pack
  (`git pack-objects`: everything since this device's previous ref) into
  `objects/pack/`, the `.pack` before its `.idx`, then the ref, each as a
  temp file renamed into place (`GitBackend::publish_to_folder`). Packs are
  named by their content and never change.
- **A ref whose objects haven't arrived waits.** Each device ref is fetched
  on its own (and only when its commit isn't already here). If the fetch
  fails because objects are missing, that device is skipped this time and
  listed in `SyncReport::incomplete_devices`; the others still merge and
  this device still publishes.
- **The shared repo is never repacked.** `gc.auto`, `gc.autoPackLimit`,
  `receive.autogc` and ref packing are off, so git never rewrites a shared
  file.
- **The app watches the whole folder remote** and syncs 2 seconds after
  files stop arriving, instead of waiting for the next timed sync. Changes
  right after its own sync are its own publish, and are ignored.
- **iCloud may not have downloaded the repo yet.** The app runs `brctl
  download` on it when the workspace opens; files that still aren't there
  count as not arrived yet.
- **Which remotes are folder remotes:** a local path ending in `.docsync`.
  Other local paths, such as `/Volumes/USB/notes.git`, are ordinary git
  remotes with one shared branch. The device id is stored per copy in
  `.docsync/app.json`, e.g. `arjans-macbook-pro-3f9a1c`; joining again on the
  same device makes a new one.

The cost is merging N device refs instead of one remote branch, and an
extra merge commit when two devices merge the same changes at once (the
next sync fast-forwards one onto the other). GitHub and other git hosts keep
the single `main` branch.

The tests prove it with a simulated cloud (`tests/common/mod.rs`): each
device has its own copy of the folder, and the cloud copies one file at a
time between the copies and a server, in random order. It fails the test if
two devices ever write the same file differently, since a real service
would keep one and set the other aside as a "conflicted copy".
`tests/folder_remote.rs` covers the cases one by one (a ref before its
pack, a missing folder) and the simulation runs every seed through a cloud
folder as well.

### Setting it up

To the user, a workspace is kept in one of two kinds of place. Its pages
and their whole history always live in the app's data folder
([The local copy](#the-local-copy)); the choice is where a second copy goes:

1. **A folder.** The default is "On this computer", which means no remote
   at all. "Change…" picks any folder, which gets a `<name>.docsync` folder
   remote. A folder in iCloud Drive, Dropbox or OneDrive puts the workspace
   on every device; a network drive or USB stick works the same way. The
   app can't know whether something syncs a folder, and doesn't need to:
   the format is the same everywhere. A tip says which services do it, and
   the installed ones are links that open the picker there.
2. **A Git repository:** GitHub (sign in, install the GitHub App if needed,
   then a new private repo; see
   [Signing in with GitHub](#signing-in-with-github)), or any Git URL.

"Add a workspace" starts with "Start a new workspace" or "Join a
workspace", and nothing else: opening a workspace this device already has
is the switcher's job. (The welcome screen, shown when none is open, also
lists recent ones.) Each screen shows the two places as blocks, "In a
folder" and "In a Git repository", with the chosen one open.
- **New** is one screen: the name, then the blocks. The folder block holds
  "Kept in On this computer [Change…]" and Create; the Git block holds
  GitHub and a URL field.
- **Join** uses the same two blocks.
  - "In a folder" lists the `*.docsync` folders found in the cloud
    folders, up to three levels down. It also takes any folder chosen by
    hand: the `.docsync` folder itself, or a folder above it.
  - "In a Git repository" lists the workspaces on GitHub this device
    doesn't have yet, or takes a URL.

The sync panel shows "Kept in On this computer", "Kept in Dropbox › Work"
or "Kept in GitHub". Its "Change…" shows the same two blocks; going back
to "On this computer" stops syncing and leaves the old copy where it is.
The local repo has the whole history, so a new place gets all of it on the
next sync (`switching_where_it_syncs_takes_the_history_along`). The other
devices follow on their own: see [Following a move](#following-a-move).

#### Following a move

When one device moves the workspace, it leaves a note in the workspace
itself, so the others follow on their next sync without anyone switching
them by hand. The code is in `apps/desktop/src-tauri/src/session.rs`
(`prepare_move`, `pending_move`, `follow`), with the engine's part in
`SyncEngine::check_remote` and `SyncEngine::follow_remote`.

- **The note is a synced setting:** `kept_in` in `workspace.json`. It's
  one string, so a merge never mixes two places, and it describes the
  place the same way on every device: `folder:Dropbox/Work/Notes.docsync`
  (the service without its account, which differs per person),
  `folder:~/Backups/Notes.docsync`, `folder:/Volumes/USB/Notes.docsync`, or
  a Git URL without any password (`cloud::portable_place`).
- **Each folder remote has an id,** a random `place-id` file inside the
  `.docsync` folder, made when the workspace first moves there, and the
  note ends with it (`…/Notes.docsync#3f9a…`). Old places keep their
  folders, usually with the same name, so without the id a device looking
  for the new place could find an old one, which holds the same history,
  and move back to it. With the id, only that folder counts, wherever it
  appears.
- **Moving** first checks that the new place doesn't hold a different
  workspace, then writes the note and syncs once more with the old place.
  That last sync is how the note reaches devices that still sync there,
  and it works the same for folders and Git hosts. If the old place
  can't be reached, those devices switch by hand; nothing is lost. Going
  back to "On this computer" leaves no note: it stops syncing on this
  device only.
- **Following.** After every sync (and when offline, since the old place
  may be gone once everyone has moved), a device whose remote isn't the
  note's place looks for it. For a folder it tries the same path in each
  cloud folder of that service, then folders with the same name in every
  cloud folder, since a folder shared with you usually appears somewhere
  else in your Dropbox; either way the folder's id must match the note's. It switches only to a place that already holds
  this workspace's history (`RemoteCheck::SameWorkspace`). It never
  switches to an empty remote (the mover's files haven't arrived), one it
  can't reach (Dropbox not installed, not signed in to GitHub), or a
  different workspace. Until it can, it keeps syncing where it did, and
  the sync panel says where the workspace moved, with "Locate…" for a
  folder.
- **Once per move.** Each copy remembers the last note it acted on
  (`followed` in `.docsync/app.json`), so a device whose shared folder sits
  at a different path doesn't search again on every sync.
- **Two moves at once.** If two devices move the workspace to different
  places before either hears of the other, the newer note wins for the
  devices still at the old place. The two movers don't sync with each
  other until one of them is switched by hand. That's rare, and nothing
  is lost, since the histories merge.
- **Tested on real cloud folders:** `real_cloud_folders_follow_a_move` in
  `session.rs` runs the whole scenario through this computer's Dropbox and
  OneDrive (`cargo test --lib real_cloud -- --ignored --nocapture`). It
  found the old-place problem above. It waits before deleting its folders,
  since Dropbox puts back a folder deleted while it's still uploading.
- **Unique workspaces.** A new workspace's first commit has a random id in
  its message. Two workspaces made on one device in the same second would
  otherwise have the same first commit, and would be taken for one
  workspace when switching or following.

Knowing the cloud folders is a convenience, not a requirement. The app
detects them in these places:
- iCloud Drive: `~/Library/Mobile Documents/com~apple~CloudDocs`, or
  `%USERPROFILE%\iCloudDrive` on Windows.
- The File Provider folders in `~/Library/CloudStorage`: Dropbox, OneDrive,
  Google Drive's "My Drive" and Box.
- Dropbox's `info.json`, and `%OneDrive%` on Windows.

What the detection is for:
- Links in the tip that open the folder picker there.
- Finding workspaces to join.
- "Kept in Dropbox › Work" in the sync panel.
- A quiet note when a chosen folder isn't in any of them. That's fine for a
  network drive, a USB stick or a backup.
- A warning when a workspace's own folder sits inside a cloud folder. The
  status dot turns amber, and the panel offers one button to move the files
  to the local folder. If the workspace didn't sync yet, it also creates
  the bare repo where the files were.

The code is in `apps/desktop/src-tauri/src/cloud.rs` and
`apps/desktop/src/Welcome.tsx`.

#### Folders the app doesn't control

Since the folder can be anywhere, these are handled, with tests in
`crates/docsync/tests/switching.rs` and `apps/desktop/src-tauri/src/session.rs`:

- **The folder is gone:** moved, deleted, renamed, or on a drive that isn't
  connected. Syncing counts it as offline, with the reason ("the folder …
  isn't there"). The sync panel says so and offers "Locate…" to point at its
  new place, such as when Dropbox moves its folder or a drive comes back
  under another letter. A folder whose files haven't arrived yet (no `HEAD`)
  waits the same way.
- **The service drops empty folders.** Git won't open a repository without
  `refs/` and `objects/`. They're recreated before every sync and join
  (`prepare_folder_remote`).
- **The wrong folder or URL.** Pointing a workspace at a remote that already
  holds a different workspace, one with no history in common, is refused
  (`SyncEngine::switch_remote`); otherwise the next sync would merge the two
  workspaces. An empty remote is fine, and so is one that can't be reached
  right now. Two devices that each start a workspace on the same empty
  remote still merge, as before. The check runs under the sync lock, and
  the app runs it without holding the session, since it fetches.
- **A copied workspace folder.** A folder copied to another computer, or
  next to itself, or restored from a backup, takes `.docsync/app.json` and
  its device id along. Two copies writing one device ref would overwrite
  each other, so the id records which copy it was made for: a random id
  per app install, plus the folder. Any other copy makes a new id. Moving a
  workspace makes a new id too, which is harmless: the old ref is an
  ancestor and gets skipped.
- **Unusable places:** the app's own workspaces folder, a folder inside a
  workspace, and a folder inside another `.docsync` folder are refused when
  choosing.
- **No file events.** Network drives often don't report changes, and the
  watcher isn't re-armed when a missing folder comes back. The sync every 45
  seconds covers both.
- **Not handled yet:**
  - Files the service keeps online-only (Dropbox, OneDrive) are downloaded
    when git reads them. Without a connection that read fails, and syncing
    shows "Sync paused" with git's message rather than "Offline".
  - A folder that's been damaged (a pack deleted by hand) leaves that
    device's changes "still arriving" forever. "Restore the shared folder
    from this device" is noted under sharing below.

### Sharing with other people

Git hosts grant access per repository, so **a workspace is the unit of
sharing**: everyone with access sees every page. A company therefore has
several workspaces, one for each group of people who may see the same
things, shown together as spaces. How one space uses another's work without
copies is in [product-design.md](product-design.md#access-across-spaces).

Each target shares in its own way, behind one "Share" button:

- **Cloud folder:** the provider's own sharing (Dropbox shared folders,
  iCloud Drive folder sharing via `NSSharingService`, OneDrive). Once someone
  accepts, the folder appears on their device and the `*.docsync` scan finds
  it. Per-device refs keep this safe however many people join. Anyone with
  access can also damage the shared repo, so the app should offer "restore the
  shared repo from this device"; every device has the full history.
- **GitHub:** the app invites by username
  (`PUT /repos/{owner}/{repo}/collaborators/{username}`, with "can view"
  mapped to read access), and on the invitee's device lists and accepts
  pending invitations (`GET /user/repository_invitations`) before cloning.
  Teams use an organization, which also allows inviting by email and is what
  makes read access possible: in a repository on a personal account every
  collaborator can also write. Everyone needs a GitHub account.
- **Hosted (later):** invites by email or link, with owner, editor and viewer
  roles. It is a git server over HTTPS with our own sign-in in front, so the
  engine doesn't change; the token reaches git through
  `CliGit::with_config`.

Limits that follow from the git model:

- No per-page permissions. Sharing one page means a separate workspace, or
  checks on the hosted service's side.
- Read-only access needs a host that enforces it. On a shared folder, anyone
  who can read can usually write.
- Removing someone stops future syncs; they keep the copy they have.

## What the tests guarantee

Run them with `cargo test`. To use a specific git binary, set
`DOCSYNC_TEST_GIT=/path/to/git`.

- **`tests/scenarios.rs`:** each rule above, plus offline work, push races,
  edits during a sync, stale lock files, joining an empty remote and restarts.
- **`tests/crash_recovery.rs`:** crashes a merging sync at *every* git call,
  both just before and just after the call (so "the push reached the remote
  but we died" is covered). It then restarts and checks convergence and that
  every edit survived.
- **`tests/simulation.rs`:** three devices make random edits, deletions,
  offline periods, clock jumps and syncs, in random order. Then it checks:
  - **Convergence:** all devices have the same commit and identical files.
  - **Validity:** no raw git conflict markers, all JSON parses, no half-present
    pages or databases, no leftover merge state.
  - **No silent loss:** an edit may only be missing if the device that deleted
    it had already seen it, i.e. the edit's commit is an ancestor of the
    deleter's commit. JSON values may lose to a newer value, but must be
    something someone wrote. Content that no longer existed anyway doesn't
    count: a line its author added and removed again, or a value a newer
    edit overwrote.

  Scale it up with `DOCSYNC_SIM_SEEDS` and `DOCSYNC_SIM_STEPS`, and reproduce a
  failure with `DOCSYNC_SIM_SEED=<n>`.

## Known limitations / next steps

- **Orphaned child pages.** If a parent page is deleted while a child is edited
  elsewhere, the child comes back but its `parent` no longer exists. The app
  should show such pages at the top level.
- **A column's choices resolve as one value.** Two devices editing the
  same select column's `options` at once: the newest list wins. Changes to
  different columns, or to different fields of one column, merge.
- **No live collaboration.** This is asynchronous sync: no live cursors and no
  character-by-character merging.
- **Code and other text files merge as opaque files.** Only `.md` and
  `.json` get a real merge, and `git add -A` commits everything that isn't
  ignored. Agents need a plain-text merge kind and stricter rules for what
  gets committed; see [agents-design.md](agents-design.md#what-it-changes-in-the-sync-engine).
- **No drafts.** A workspace has one working copy. An agent's run needs its
  own, on a hidden branch, applied through the same merge as a sync; see
  [agents-design.md](agents-design.md#drafts).
- **One workspace open at a time.** The app holds a single open workspace
  and switches between them. A company's spaces need several open together,
  each with its own engine and worker
  ([roadmap step 7](roadmap.md#7-spaces-people-and-the-inbox)).
- **Large attachments live in the repo.** The direction is to keep large
  files such as video and audio out of git, with a pointer in the repo and
  the bytes in a file store
  ([product-design.md](product-design.md#what-stays-out-of-git)). Not
  designed yet.
- **Authentication** (GitHub/GitLab sign-in, keychain storage) sits in the app
  and reaches git through `CliGit::with_config_source`; see
  [Signing in with GitHub](#signing-in-with-github).
