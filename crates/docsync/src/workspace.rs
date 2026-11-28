//! Reading and writing pages and databases in the on-disk format described
//! in [`crate::layout`]. This is deliberately thin: it only writes files.
//! Syncing is the [`crate::SyncEngine`]'s job.

use std::fs;
use std::path::{Path, PathBuf};

use rand::Rng;
use serde_json::{Map, Value, json};

use crate::database::{Column, ColumnChange, ColumnType, Row, Schema, sort_rows};
use crate::database_page::{DatabasePage, View, ViewType};
use crate::error::IoContext;
use crate::layout::{
    self, DATABASE_SCHEMA, DATABASES_DIR, LEGACY_DATABASE_ROWS, PAGE_BODY, PAGE_META, PAGES_DIR,
};
use crate::{Error, Result, front_matter, json_merge};

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

/// A random id: 12 characters from `[0-9a-z]`.
pub fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..12)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

impl Workspace {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---- workspace settings -------------------------------------------

    /// The workspace's name, from `workspace.json`. It syncs like any other
    /// field, so every device shows the same name; folders and remotes keep
    /// whatever name they were created with. `None` for workspaces made
    /// before names were stored, or when the file is missing or broken.
    pub fn name(&self) -> Option<String> {
        let value = self.read_json(&self.root.join(layout::WORKSPACE_FILE)).ok()?;
        let name = value.get("name")?.as_str()?.trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    /// Rename the workspace. Leading and trailing whitespace is dropped; an
    /// empty name is refused.
    pub fn set_name(&self, name: &str) -> Result<()> {
        let path = self.root.join(layout::WORKSPACE_FILE);
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidData {
                path: path.display().to_string(),
                message: "a workspace name can't be empty".into(),
            });
        }
        if !path.exists() {
            return self.write_json(&path, &json!({ "name": name }));
        }
        self.update_json(&path, |settings| {
            settings.insert("name".into(), name.into());
        })
    }

    /// The workspace format of the files on disk: the `format` field of
    /// `workspace.json`, or 1 when it's missing (see
    /// [`crate::WORKSPACE_FORMAT`]).
    pub fn format(&self) -> u32 {
        self.read_json(&self.root.join(layout::WORKSPACE_FILE))
            .ok()
            .and_then(|v| v.get("format")?.as_u64())
            .and_then(|f| u32::try_from(f).ok())
            .unwrap_or(1)
    }

    /// Record the workspace format. Doesn't commit.
    pub fn set_format(&self, format: u32) -> Result<()> {
        let path = self.root.join(layout::WORKSPACE_FILE);
        if self.read_json(&path).is_err() {
            return self.write_json(&path, &json!({ "format": format }));
        }
        self.update_json(&path, |settings| {
            settings.insert("format".into(), format.into());
        })
    }

    /// Where the workspace is kept besides each device, from
    /// `workspace.json`: written by the device that last moved it, so the
    /// others follow (see "Following a move" in docs/sync-design.md). The
    /// app chooses the format; a single string, so a merge never mixes two
    /// places.
    pub fn kept_in(&self) -> Option<String> {
        let value = self.read_json(&self.root.join(layout::WORKSPACE_FILE)).ok()?;
        let place = value.get("kept_in")?.as_str()?.trim();
        (!place.is_empty()).then(|| place.to_string())
    }

    /// Record where the workspace is kept now. Doesn't commit.
    pub fn set_kept_in(&self, place: &str) -> Result<()> {
        let path = self.root.join(layout::WORKSPACE_FILE);
        if !path.exists() {
            return self.write_json(&path, &json!({ "kept_in": place }));
        }
        self.update_json(&path, |settings| {
            settings.insert("kept_in".into(), place.into());
        })
    }

    // ---- pages ---------------------------------------------------------

    pub fn create_page(&self, title: &str, parent: Option<&str>) -> Result<String> {
        let id = new_id();
        self.create_page_with_id(&id, title, parent)?;
        Ok(id)
    }

    pub fn create_page_with_id(&self, id: &str, title: &str, parent: Option<&str>) -> Result<()> {
        self.create_page_with(id, title, parent, Map::new(), "")
    }

    /// Create a page with its properties and body in one go.
    pub fn create_page_with(
        &self,
        id: &str,
        title: &str,
        parent: Option<&str>,
        properties: Map<String, Value>,
        body: &str,
    ) -> Result<()> {
        let meta = json!({ "id": id, PAGE_NAME: title, "parent": parent, "properties": properties });
        self.write_json(&self.page_dir(id).join(PAGE_META), &meta)?;
        self.write_file(&self.page_dir(id).join(PAGE_BODY), body.as_bytes())
    }

    pub fn page_exists(&self, id: &str) -> bool {
        self.page_dir(id).join(PAGE_META).is_file()
    }

    /// Every page, database rows included (see [`Workspace::find_row`]).
    pub fn list_pages(&self) -> Result<Vec<String>> {
        list_ids(&self.root.join(PAGES_DIR), Some(PAGE_META))
    }

    pub fn read_page_meta(&self, id: &str) -> Result<Value> {
        self.read_json(&self.page_dir(id).join(PAGE_META))
    }

    /// Rename a page: its meta.json's `name` (a `title` from a hand edit
    /// goes).
    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            meta.insert(PAGE_NAME.into(), title.into());
            meta.remove(OLD_PAGE_NAME);
        })
    }

    pub fn set_parent(&self, id: &str, parent: Option<&str>) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            meta.insert("parent".into(), parent.into());
        })
    }

    /// Where a page sits among the pages next to it, once it's been put
    /// there by hand: its meta.json's `position`. `None` removes it, and the
    /// page sorts by name after the ones that have one.
    pub fn set_page_position(&self, id: &str, position: Option<f64>) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            put_position(meta, position);
        })
    }

    /// Put a page under `parent` (`None`: the top level) at `position`, in
    /// one write.
    pub fn move_page(&self, id: &str, parent: Option<&str>, position: Option<f64>) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            meta.insert("parent".into(), parent.into());
            put_position(meta, position);
        })
    }

    pub fn set_page_property(&self, id: &str, key: &str, value: Value) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            object_field(meta, "properties").insert(key.into(), value);
        })
    }

    /// Empty a page's property: its value is removed, its type stays.
    pub fn clear_page_property(&self, id: &str, key: &str) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            object_field(meta, "properties").remove(key);
        })
    }

    /// A page's properties as columns, in order, and their values. A value
    /// without a type (front matter, an agent, a hand edit) reads as a text
    /// property named by its key, so nothing is hidden.
    pub fn page_properties(&self, id: &str) -> Result<(Vec<Column>, Map<String, Value>)> {
        let meta = self.read_page_meta(id)?;
        Ok(page_properties_from(&meta))
    }

    /// Add a typed property to a page; returns its key.
    pub fn add_page_property(&self, id: &str, name: &str, kind: ColumnType) -> Result<String> {
        let key = new_id();
        let (columns, _) = self.page_properties(id)?;
        let column = Column {
            id: key.clone(),
            name: name.to_string(),
            kind,
            position: Some(crate::database::next_position(&columns)),
            options: Vec::new(),
        };
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            object_field(meta, PROPERTY_SCHEMA).insert(key.clone(), column.to_json());
        })?;
        Ok(key)
    }

    /// Rename, retype, move or change the choices of a page's property. A
    /// property without a type yet gets one.
    pub fn update_page_property(&self, id: &str, key: &str, change: &ColumnChange) -> Result<()> {
        let path = self.page_dir(id).join(PAGE_META);
        let (columns, _) = self.page_properties(id)?;
        let mut column = columns
            .into_iter()
            .find(|c| c.id == key)
            .ok_or_else(|| Error::InvalidData {
                path: path.display().to_string(),
                message: format!("no property {key}"),
            })?;
        change.apply(&mut column);
        self.update_json(&path, |meta| {
            object_field(meta, PROPERTY_SCHEMA).insert(key.to_string(), column.to_json());
        })
    }

    /// Remove a page's property, with its value: unlike a database column,
    /// it's in one file, so nothing else is rewritten.
    pub fn remove_page_property(&self, id: &str, key: &str) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            object_field(meta, PROPERTY_SCHEMA).remove(key);
            object_field(meta, "properties").remove(key);
            if meta[PROPERTY_SCHEMA].as_object().is_some_and(Map::is_empty) {
                meta.remove(PROPERTY_SCHEMA);
            }
        })
    }

    /// How the page is shown (`"width"`, `"textSize"`, ...), in the
    /// `display` field of its meta.json. `None` removes the option, which
    /// means the default. Options merge one by one, like properties.
    pub fn set_page_display(&self, id: &str, key: &str, value: Option<Value>) -> Result<()> {
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            let display = meta.entry("display").or_insert_with(|| json!({}));
            if !display.is_object() {
                *display = json!({});
            }
            let display = display.as_object_mut().expect("object");
            match value {
                Some(value) => display.insert(key.into(), value),
                None => display.remove(key),
            };
            if display.is_empty() {
                meta.remove("display");
            }
        })
    }

    pub fn read_body(&self, id: &str) -> Result<String> {
        let path = self.page_dir(id).join(PAGE_BODY);
        fs::read_to_string(&path).at(&path)
    }

    pub fn write_body(&self, id: &str, body: &str) -> Result<()> {
        self.write_file(&self.page_dir(id).join(PAGE_BODY), body.as_bytes())
    }

    /// Move YAML front matter at the top of the page's body into its
    /// meta.json: `title` (or `name`) becomes the page's name, every other
    /// field a property.
    /// Front matter was written after meta.json (by another tool or an AI
    /// agent), so its values replace the ones there. Returns whether the
    /// page changed. Doesn't commit.
    ///
    /// meta.json is written first: if the process stops in between, the
    /// front matter is still in the body and is moved again next time.
    pub fn lift_front_matter(&self, id: &str) -> Result<bool> {
        if !self.page_exists(id) || self.find_row(id).is_some() {
            // A database row's properties are its database's columns, keyed
            // by column id, which front matter can't name.
            return Ok(false);
        }
        let body = match self.read_body(id) {
            Ok(body) => body,
            Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(false);
            }
            Err(e) => return Err(e),
        };
        let Some(front) = front_matter::parse(&body) else {
            return Ok(false);
        };
        self.update_json(&self.page_dir(id).join(PAGE_META), |meta| {
            if let Some(title) = front.title {
                meta.insert(PAGE_NAME.into(), title.into());
                meta.remove(OLD_PAGE_NAME);
            }
            let props = meta.entry("properties").or_insert_with(|| json!({}));
            if !props.is_object() {
                *props = json!({});
            }
            props.as_object_mut().expect("object").extend(front.properties);
        })?;
        self.write_body(id, &front.body)?;
        Ok(true)
    }

    /// Where a page's attachments go: `pages/<id>/assets`.
    pub fn page_assets_dir(&self, id: &str) -> PathBuf {
        self.page_dir(id).join(layout::PAGE_ASSETS)
    }

    /// Save `bytes` in the page's `assets/` as `name`, or as `name-2`,
    /// `name-3`, … when that's taken. `name` is only a suggestion: anything
    /// before the last `/` or `\\` is dropped. Returns the link to the file
    /// from the page's text (see [`layout::asset_link`]).
    pub fn add_page_asset(&self, id: &str, name: &str, bytes: &[u8]) -> Result<String> {
        let dir = self.page_assets_dir(id);
        fs::create_dir_all(&dir).at(&dir)?;
        let name = name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches('.');
        let name = if name.is_empty() { "file" } else { name };
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 => (&name[..i], &name[i..]),
            _ => (name, ""),
        };
        let mut file = name.to_string();
        for n in 2.. {
            let path = dir.join(&file);
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut out) => {
                    std::io::Write::write_all(&mut out, bytes).at(&path)?;
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => file = format!("{stem}-{n}{ext}"),
                Err(e) => return Err(e).at(&path),
            }
        }
        Ok(layout::asset_link(&file))
    }

    pub fn delete_page(&self, id: &str) -> Result<()> {
        let dir = self.page_dir(id);
        fs::remove_dir_all(&dir).at(&dir)
    }

    // ---- database pages ------------------------------------------------
    // The format is in [`crate::database_page`].

    /// A page that shows `database` (or, with `None`, one still to be
    /// chosen) in a single table view.
    pub fn create_database_page(
        &self,
        title: &str,
        parent: Option<&str>,
        database: Option<&str>,
    ) -> Result<String> {
        let id = new_id();
        let view = View::new(&new_id(), "Table", ViewType::Table, 0.0);
        let mut field = json!({ "views": { view.id.clone(): view.to_json() } });
        if let Some(database) = database {
            field["id"] = database.into();
        }
        let meta =
            json!({ "id": id, PAGE_NAME: title, "parent": parent, "properties": {}, "database": field });
        self.write_json(&self.page_dir(&id).join(PAGE_META), &meta)?;
        self.write_file(&self.page_dir(&id).join(PAGE_BODY), b"")?;
        Ok(id)
    }

    /// Which database a database page shows.
    pub fn set_page_database(&self, id: &str, database: &str) -> Result<()> {
        self.edit_database_field(id, |field| {
            field.insert("id".into(), database.into());
        })
    }

    /// Add or replace one of a database page's views, or remove it with `None`.
    pub fn set_page_view(&self, id: &str, view: &str, value: Option<&View>) -> Result<()> {
        self.edit_database_field(id, |field| {
            let views = field.entry("views").or_insert_with(|| json!({}));
            if !views.is_object() {
                *views = json!({});
            }
            let views = views.as_object_mut().expect("object");
            match value {
                Some(value) => views.insert(view.into(), value.to_json()),
                None => views.remove(view),
            };
        })
    }

    /// Edit a page's `database` field, refusing a page that isn't a database page.
    fn edit_database_field(&self, id: &str, edit: impl FnOnce(&mut Map<String, Value>)) -> Result<()> {
        let path = self.page_dir(id).join(PAGE_META);
        let mut failed = false;
        self.update_json(&path, |meta| {
            match meta.get_mut("database").and_then(Value::as_object_mut) {
                Some(field) => edit(field),
                None => failed = true,
            }
        })?;
        if failed {
            return Err(Error::InvalidData {
                path: path.display().to_string(),
                message: "not a database page".into(),
            });
        }
        Ok(())
    }

    /// The database pages showing `database`.
    pub fn pages_showing(&self, database: &str) -> Result<Vec<String>> {
        let mut pages = Vec::new();
        for id in self.list_pages()? {
            let meta = self.read_page_meta(&id).unwrap_or_default();
            if DatabasePage::from_meta(&meta).and_then(|p| p.database).as_deref() == Some(database) {
                pages.push(id);
            }
        }
        Ok(pages)
    }

    // ---- databases -----------------------------------------------------
    // The format is in [`crate::database`].

    /// A database with a title column called "Name" (id [`TITLE_COLUMN`]),
    /// then text columns whose ids are `columns`.
    pub fn create_database(&self, name: &str, columns: &[&str]) -> Result<String> {
        let id = new_id();
        self.create_database_with_id(&id, name, columns)?;
        Ok(id)
    }

    pub fn create_database_with_id(&self, id: &str, name: &str, columns: &[&str]) -> Result<()> {
        let title = Column {
            id: TITLE_COLUMN.into(),
            name: "Name".into(),
            kind: ColumnType::Title,
            position: Some(0.0),
            options: Vec::new(),
        };
        let columns: Map<String, Value> = std::iter::once(title)
            .chain(columns.iter().enumerate().map(|(i, col)| Column {
                id: col.to_string(),
                name: col.to_string(),
                kind: ColumnType::Text,
                position: Some(i as f64 + 1.0),
                options: Vec::new(),
            }))
            .map(|column| (column.id.clone(), column.to_json()))
            .collect();
        let schema = json!({ "id": id, "name": name, "columns": columns });
        self.write_json(&self.database_dir(id).join(DATABASE_SCHEMA), &schema)
    }

    pub fn database_exists(&self, id: &str) -> bool {
        self.database_dir(id).join(DATABASE_SCHEMA).is_file()
    }

    pub fn list_databases(&self) -> Result<Vec<String>> {
        list_ids(&self.root.join(DATABASES_DIR), Some(DATABASE_SCHEMA))
    }

    /// The database's schema.json as written.
    pub fn read_database_json(&self, id: &str) -> Result<Value> {
        self.read_json(&self.database_dir(id).join(DATABASE_SCHEMA))
    }

    pub fn read_schema(&self, id: &str) -> Result<Schema> {
        Ok(Schema::from_json(id, &self.read_database_json(id)?))
    }

    pub fn rename_database(&self, id: &str, name: &str) -> Result<()> {
        self.update_json(&self.database_dir(id).join(DATABASE_SCHEMA), |schema| {
            schema.insert("name".into(), name.into());
        })
    }

    /// Add a column after the others; returns its id. Not a title column:
    /// a database has one, from when it's made.
    pub fn add_column(&self, db: &str, name: &str, kind: ColumnType) -> Result<String> {
        if kind == ColumnType::Title {
            return Err(self.schema_error(db, "a database has one title column".into()));
        }
        let id = new_id();
        let schema = self.read_schema(db)?;
        let column = Column {
            id: id.clone(),
            name: name.to_string(),
            kind,
            position: Some(schema.next_position()),
            options: Vec::new(),
        };
        self.edit_columns(db, |columns| {
            columns.insert(id.clone(), column.to_json());
        })?;
        Ok(id)
    }

    /// Change a column's name, type, position or options. Cells keep their
    /// values when the type changes; readers treat a value of the wrong type
    /// as text until it is edited. The title column keeps its type, and no
    /// other column gets it.
    pub fn update_column(&self, db: &str, column: &str, change: &ColumnChange) -> Result<()> {
        let mut current = self
            .read_schema(db)?
            .column(column)
            .cloned()
            .ok_or_else(|| self.schema_error(db, format!("no column {column}")))?;
        if let Some(kind) = change.kind
            && kind != current.kind
            && (kind == ColumnType::Title || current.kind == ColumnType::Title)
        {
            return Err(self.schema_error(db, "the title column keeps its type".into()));
        }
        change.apply(&mut current);
        self.edit_columns(db, |columns| {
            columns.insert(column.to_string(), current.to_json());
        })
    }

    /// Remove a column from the schema. Its cells stay in the rows, so the
    /// rows aren't all rewritten (and can't conflict with edits elsewhere);
    /// readers ignore cells of unknown columns. The title column stays.
    pub fn remove_column(&self, db: &str, column: &str) -> Result<()> {
        if self
            .read_schema(db)?
            .title_column()
            .is_some_and(|c| c.id == column)
        {
            return Err(self.schema_error(db, "the title column can't be deleted".into()));
        }
        self.edit_columns(db, |columns| {
            columns.remove(column);
        })
    }

    /// Edit the `columns` object, moving a schema in the first format (a
    /// list of names) to the current one first.
    fn edit_columns(&self, db: &str, edit: impl FnOnce(&mut Map<String, Value>)) -> Result<()> {
        let schema = self.read_schema(db)?;
        self.update_json(&self.database_dir(db).join(DATABASE_SCHEMA), |value| {
            let columns = value.entry("columns").or_insert_with(|| json!({}));
            if !columns.is_object() {
                *columns = schema.columns_json();
            }
            edit(columns.as_object_mut().expect("object"));
        })
    }

    /// Add a row after the others, as a page of its own. Its position is
    /// the time it was made, so rows added on different devices meanwhile
    /// end up in the order they were added. A cell of the title column is
    /// the page's title.
    pub fn add_row(&self, db: &str, cells: Map<String, Value>) -> Result<String> {
        let id = new_id();
        self.add_row_with_id(db, &id, cells)?;
        Ok(id)
    }

    pub fn add_row_with_id(&self, db: &str, row: &str, mut cells: Map<String, Value>) -> Result<()> {
        let title = match self.title_column_id(db) {
            Some(column) => cells.remove(&column),
            None => None,
        };
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or_default();
        let meta = json!({
            "id": row,
            PAGE_NAME: title.as_ref().and_then(Value::as_str).unwrap_or_default(),
            "parent": null,
            "properties": cells,
            ROW_FIELD: { "database": db, "position": millis },
        });
        self.write_json(&self.page_dir(row).join(PAGE_META), &meta)?;
        self.write_file(&self.page_dir(row).join(PAGE_BODY), b"")
    }

    /// Whether `row` is a row of `db`.
    pub fn row_exists(&self, db: &str, row: &str) -> bool {
        self.find_row(row).as_deref() == Some(db)
    }

    /// The ids of a database's rows, in no particular order.
    pub fn list_rows(&self, db: &str) -> Result<Vec<String>> {
        Ok(self.read_rows(db)?.into_iter().map(|r| r.id).collect())
    }

    /// Every row, in display order: the pages whose `row` field names
    /// `db`. A meta.json that doesn't parse (a hand edit) is left out rather
    /// than hiding the whole database.
    pub fn read_rows(&self, db: &str) -> Result<Vec<Row>> {
        let title = self.title_column_id(db);
        let mut rows = Vec::new();
        for id in self.list_pages()? {
            let Ok(meta) = self.read_page_meta(&id) else {
                continue;
            };
            if row_database(&meta) == Some(db) {
                rows.push(Row::from_meta(&id, &meta, title.as_deref()));
            }
        }
        sort_rows(&mut rows);
        Ok(rows)
    }

    /// One row, refusing a page that isn't a row of `db`.
    pub fn read_row(&self, db: &str, row: &str) -> Result<Row> {
        let meta = self.read_page_meta(row)?;
        if row_database(&meta) != Some(db) {
            return Err(Error::InvalidData {
                path: self.page_dir(row).join(PAGE_META).display().to_string(),
                message: format!("not a row of database {db}"),
            });
        }
        Ok(Row::from_meta(row, &meta, self.title_column_id(db).as_deref()))
    }

    /// Put a row at `position` in a view that orders its rows by hand (a
    /// board whose cards are dragged): `row.positions.<view>` in its
    /// meta.json. Other views keep their order.
    pub fn set_row_view_position(&self, db: &str, row: &str, view: &str, position: f64) -> Result<()> {
        self.read_row(db, row)?;
        self.update_json(&self.page_dir(row).join(PAGE_META), |meta| {
            object_field(object_field(meta, ROW_FIELD), "positions").insert(view.into(), json!(position));
        })
    }

    /// Set a row's cell: the property of its page, keyed by column id, or
    /// its page's title for the title column.
    pub fn set_cell(&self, db: &str, row: &str, column: &str, value: Value) -> Result<()> {
        if self.title_column_id(db).as_deref() == Some(column) {
            return self.set_title(row, value.as_str().unwrap_or_default());
        }
        self.set_page_property(row, column, value)
    }

    /// Empty a cell: its key is removed, or the title emptied.
    pub fn clear_cell(&self, db: &str, row: &str, column: &str) -> Result<()> {
        if self.title_column_id(db).as_deref() == Some(column) {
            return self.set_title(row, "");
        }
        self.clear_page_property(row, column)
    }

    /// The id of a database's title column, if it has one.
    fn title_column_id(&self, db: &str) -> Option<String> {
        let schema = self.read_schema(db).ok()?;
        schema.title_column().map(|c| c.id.clone())
    }

    fn schema_error(&self, db: &str, message: String) -> Error {
        Error::InvalidData {
            path: self.database_dir(db).join(DATABASE_SCHEMA).display().to_string(),
            message,
        }
    }

    /// Rename every page's `title` field to `name` ([`PAGE_NAME`], workspace
    /// format 3). A page with both keeps its `name`. Returns how many pages
    /// changed. Safe to run again, and on two devices at once.
    pub fn rename_title_fields(&self) -> Result<usize> {
        let mut changed = 0;
        for id in self.list_pages()? {
            let Ok(meta) = self.read_page_meta(&id) else {
                continue;
            };
            if meta.get(OLD_PAGE_NAME).is_none() {
                continue;
            }
            self.update_json(&self.page_dir(&id).join(PAGE_META), |meta| {
                if let Some(title) = meta.remove(OLD_PAGE_NAME)
                    && !meta.get(PAGE_NAME).is_some_and(Value::is_string)
                {
                    meta.insert(PAGE_NAME.into(), title);
                }
            })?;
            changed += 1;
        }
        Ok(changed)
    }

    /// Give every database a title column, as databases made before there
    /// was one don't have (workspace format 3): its first text column
    /// becomes the title column, or a new one called "Name" (id
    /// [`TITLE_COLUMN`]) comes first. Then a row's cell of the title column
    /// becomes its page's title, replacing it. Returns how many files
    /// changed. Safe to run again, and on two devices at once: both make
    /// the same change.
    pub fn give_databases_titles(&self) -> Result<usize> {
        let mut changed = 0;
        let mut titles: std::collections::HashMap<String, String> = Default::default();
        for db in self.list_databases()? {
            let Ok(schema) = self.read_schema(&db) else {
                continue;
            };
            let column = match schema.title_column() {
                Some(c) => c.clone(),
                None => {
                    let column = match schema.columns.iter().find(|c| c.kind == ColumnType::Text) {
                        Some(text) => Column {
                            kind: ColumnType::Title,
                            ..text.clone()
                        },
                        None => {
                            let first = schema
                                .columns
                                .iter()
                                .filter_map(|c| c.position)
                                .fold(0.0, f64::min);
                            let mut id = TITLE_COLUMN.to_string();
                            for n in 2.. {
                                if schema.column(&id).is_none() {
                                    break;
                                }
                                id = format!("{TITLE_COLUMN}-{n}");
                            }
                            Column {
                                id,
                                name: "Name".into(),
                                kind: ColumnType::Title,
                                position: Some(first - 1.0),
                                options: Vec::new(),
                            }
                        }
                    };
                    self.edit_columns(&db, |columns| {
                        columns.insert(column.id.clone(), column.to_json());
                    })?;
                    changed += 1;
                    column
                }
            };
            titles.insert(db, column.id);
        }
        // One pass over the pages, rather than one per database.
        for row in self.list_pages()? {
            let Ok(meta) = self.read_page_meta(&row) else {
                continue;
            };
            let Some(column) = row_database(&meta).and_then(|db| titles.get(db)) else {
                continue;
            };
            let Some(cell) = meta["properties"].get(column) else {
                continue;
            };
            let title = match cell {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            self.update_json(&self.page_dir(&row).join(PAGE_META), |meta| {
                meta.insert(PAGE_NAME.into(), title.into());
                meta.remove(OLD_PAGE_NAME);
                object_field(meta, "properties").remove(column);
            })?;
            changed += 1;
        }
        Ok(changed)
    }

    /// Delete a row: its page, with its text and attachments.
    pub fn delete_row(&self, _db: &str, row: &str) -> Result<()> {
        self.delete_page(row)
    }

    /// The database a page is a row of, if it is one.
    pub fn find_row(&self, row: &str) -> Option<String> {
        if row.is_empty() || row.contains(['/', '\\', '.']) {
            return None;
        }
        let meta = self.read_page_meta(row).ok()?;
        row_database(&meta).map(str::to_string)
    }

    /// Move rows from the first layout (`databases/<db>/rows/<row>.json`
    /// and `.md`) into pages of their own. Returns how many were moved.
    /// Safe to run again, and after a crash halfway: a row's page is
    /// written before its old files are removed.
    pub fn move_rows_into_pages(&self) -> Result<usize> {
        let mut moved = 0;
        for db in self.list_databases()? {
            let dir = self.database_dir(&db).join(LEGACY_DATABASE_ROWS);
            for row in list_ids(&dir, None)? {
                let json_path = dir.join(format!("{row}.json"));
                let body_path = dir.join(format!("{row}.md"));
                let Ok(old) = self.read_json(&json_path) else {
                    continue;
                };
                let mut meta = json!({
                    "id": row,
                    PAGE_NAME: "",
                    "parent": null,
                    "properties": old["cells"].as_object().cloned().unwrap_or_default(),
                    ROW_FIELD: { "database": db },
                });
                if let Some(position) = old["position"].as_f64() {
                    meta[ROW_FIELD]["position"] = json!(position);
                }
                if old["display"].is_object() {
                    meta["display"] = old["display"].clone();
                }
                let body = match fs::read_to_string(&body_path) {
                    Ok(body) => body,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                    Err(e) => return Err(e).at(&body_path),
                };
                self.write_file(&self.page_dir(&row).join(PAGE_BODY), body.as_bytes())?;
                self.write_json(&self.page_dir(&row).join(PAGE_META), &meta)?;
                if body_path.is_file() {
                    fs::remove_file(&body_path).at(&body_path)?;
                }
                fs::remove_file(&json_path).at(&json_path)?;
                moved += 1;
            }
            // Gone once empty; whatever else is left (a conflict copy) stays.
            let _ = fs::remove_dir(&dir);
        }
        Ok(moved)
    }

    /// Delete a database with its rows.
    pub fn delete_database(&self, id: &str) -> Result<()> {
        for row in self.list_rows(id)? {
            self.delete_page(&row)?;
        }
        let dir = self.database_dir(id);
        fs::remove_dir_all(&dir).at(&dir)
    }

    // ---- helpers -------------------------------------------------------

    fn page_dir(&self, id: &str) -> PathBuf {
        self.root.join(PAGES_DIR).join(id)
    }

    fn database_dir(&self, id: &str) -> PathBuf {
        self.root.join(DATABASES_DIR).join(id)
    }

    fn read_json(&self, path: &Path) -> Result<Value> {
        let bytes = fs::read(path).at(path)?;
        serde_json::from_slice(&bytes).map_err(|e| Error::InvalidData {
            path: path.display().to_string(),
            message: e.to_string(),
        })
    }

    fn write_json(&self, path: &Path, value: &Value) -> Result<()> {
        self.write_file(path, &json_merge::to_canonical_bytes(value))
    }

    fn update_json(&self, path: &Path, edit: impl FnOnce(&mut Map<String, Value>)) -> Result<()> {
        let mut value = self.read_json(path)?;
        let map = value.as_object_mut().ok_or_else(|| Error::InvalidData {
            path: path.display().to_string(),
            message: "expected a JSON object".into(),
        })?;
        edit(map);
        self.write_json(path, &value)
    }

    /// Write via a temporary file and rename, so a crash never leaves a
    /// half-written file for the next commit to pick up.
    fn write_file(&self, path: &Path, content: &[u8]) -> Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).at(dir)?;
        }
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(layout::TEMP_SUFFIX);
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, content).at(&tmp)?;
        fs::rename(&tmp, path).at(path)
    }
}

/// The field of a page's meta.json that holds its name (its title).
pub const PAGE_NAME: &str = "name";

/// What [`PAGE_NAME`] was called before workspace format 3. Still read, for
/// pages written by hand or by an agent, and renamed when the workspace is
/// opened or synced ([`Workspace::rename_title_fields`]).
pub const OLD_PAGE_NAME: &str = "title";

/// A page's name from its meta.json: `name`, else `title`, else empty.
pub fn page_name(meta: &Value) -> &str {
    meta[PAGE_NAME]
        .as_str()
        .or_else(|| meta[OLD_PAGE_NAME].as_str())
        .unwrap_or_default()
}

/// The id of the title column of a database made with
/// [`Workspace::create_database`], or given one by
/// [`Workspace::give_databases_titles`]. Other databases' title columns
/// have other ids.
pub const TITLE_COLUMN: &str = "title";

/// The field of a row's meta.json that makes it a row:
/// `{"database": "<db-id>", "position": <sort key>, "positions": {"<view-id>": <sort key>}}`.
pub const ROW_FIELD: &str = "row";

/// The database a page is a row of, from its meta.json.
pub fn row_database(meta: &Value) -> Option<&str> {
    meta[ROW_FIELD]["database"].as_str().filter(|db| !db.is_empty())
}

/// Where a page keeps its properties' types; see [`page_properties_from`].
const PROPERTY_SCHEMA: &str = "property_schema";

/// A page's properties from its meta.json: `property_schema` holds their
/// types in the format of a database's columns, `properties` their values.
pub fn page_properties_from(meta: &Value) -> (Vec<Column>, Map<String, Value>) {
    let values = meta["properties"].as_object().cloned().unwrap_or_default();
    let mut columns = crate::database::columns_from_json(&meta[PROPERTY_SCHEMA]);
    // A page's title is its own; a title property (a hand edit) is text.
    for column in columns.iter_mut().filter(|c| c.kind == ColumnType::Title) {
        column.kind = ColumnType::Text;
    }
    for key in values.keys() {
        if !columns.iter().any(|c| &c.id == key) {
            columns.push(Column {
                id: key.clone(),
                name: key.clone(),
                kind: ColumnType::Text,
                position: None,
                options: Vec::new(),
            });
        }
    }
    (columns, values)
}

/// `map[key]` as an object, made one if it's missing or something else.
fn object_field<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let field = map.entry(key).or_insert_with(|| json!({}));
    if !field.is_object() {
        *field = json!({});
    }
    field.as_object_mut().expect("object")
}

/// Ids of the entries in `dir`: subdirectories containing `marker`, or with
/// no marker, `<id>.json` files. Conflict copies are skipped, and so are
/// directories without their marker file: git does not track directories,
/// so an emptied one can linger on disk after its files were synced away.
fn list_ids(dir: &Path, marker: Option<&str>) -> Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).at(dir),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.at(dir)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.contains(layout::CONFLICT_COPY_MARKER) {
            continue;
        }
        let is_dir = entry.file_type().at(entry.path())?.is_dir();
        match (marker, is_dir) {
            (Some(marker), true) => {
                if entry.path().join(marker).is_file() {
                    ids.push(name);
                }
            }
            (None, false) => {
                if let Some(id) = name.strip_suffix(".json") {
                    ids.push(id.to_string());
                }
            }
            _ => {}
        }
    }
    ids.sort();
    Ok(ids)
}

fn put_position(meta: &mut Map<String, Value>, position: Option<f64>) {
    match position {
        Some(position) => meta.insert("position".into(), json!(position)),
        None => meta.remove("position"),
    };
}
