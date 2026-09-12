<!-- translated-from: docs/user-guide.md sha256:9db9a7d509ba0d64184d33ea3eb59151b77f8a85dd4dbbd506e09e5bdbc77b5c -->

# User guide

*日本語版: [docs/user-guide.md](../user-guide.md)*

What each screen does and how to work with it. The layout is the same three levels as phpMyAdmin (**server → database → table**), and the sidebar on the left reaches any of them.

## Connecting

1. Under **Server**, pick one of the presets your administrator configured, or choose **Enter manually** and fill in the server type, host and port
2. Enter your username and password and press **Connect**. PostgreSQL needs the name of a database to connect to (`postgres` when left empty)
3. Your credentials are held in a server-side session; the browser only gets a cookie with a signed session ID. (Separately, the last server, username and database are remembered in `localStorage` — never the password. On a shared machine, bear in mind that the next person sees which server you connected to.) After `SESSION_TTL_MINUTES` of inactivity (30 by default) the session ends; connecting again returns you to the page you were on

Your administrator restricts which hosts can be reached with `TSMYADMIN_ALLOWED_HOSTS`. Hosts outside that list cannot be connected to.

## Interface language

The language menu at the top right switches between English and 日本語 (the page reloads, and the choice is kept in this browser). On a first visit the browser's language setting decides: English for English locales, Japanese otherwise.

## Elements shared by every screen

| Element | What it does |
|---|---|
| Sidebar | The tree of databases → (on PostgreSQL, schemas →) tables. The box at the top filters table names. The button at the left of the header, or `⌘/Ctrl + B`, shows and hides it (the setting is kept in this browser) |
| Tabs | The features of each level (Browse / Structure / SQL / …). The state lives in the URL, so a page can be shared or bookmarked as it is |
| Theme | The moon / sun icon in the header switches between light and dark |
| Shortcuts | `?` lists them. `⌘/Ctrl + K` the sidebar filter, `←` `→` paging, `⌘/Ctrl + Enter` run SQL, `Enter` edit the focused cell |
| Errors | When something fails to load, **Retry** fetches it again. An error that takes out the whole page is cleared by reloading |

## Server

| Tab | Contents |
|---|---|
| Databases | The list (with size, and table count on MySQL), creating one (which then opens it), and dropping one (confirmed by retyping the name; on PostgreSQL, sessions connected to it are disconnected first) |
| SQL | A SQL console for the server as a whole. **Database** chooses which database unqualified names resolve in |
| Status | The server version, uptime and status variables (filtered by name) |
| Variables | System variables (filtered by name) |
| Processes | The connections the server has open. tsmyadmin's own carry a **tsmyadmin** badge. **Cancel query** stops the running statement only and leaves the connection, its transaction and its temporary tables alone (no confirmation). **Kill** closes the connection itself (the confirmation shows the user, database and running query) |
| Users | The accounts, their privileges (as GRANT statements), **Create user**, **Change password** and **Drop** |

## Database

| Tab | Contents |
|---|---|
| Structure | Tables and views (estimated row count, engine, comment) and creating a table. Tick several and use **Export the selected tables**, **Empty the selected tables…** or **Drop the selected tables…** (confirmed by typing the table name for one, the database name for several) |
| SQL | A SQL console scoped to this database (below) |
| Export | Downloads the whole database as SQL / CSV / JSON (tables can be selected). See *Export in detail* below |
| Import | Loads a SQL script (mysqldump / mariadb-dump / pg_dump) or a CSV, with progress and a stop button. See *Import in detail* below |
| Privileges | Each user's current level on this database (All / Some / None), and granting or revoking everything on it. **Choose privileges…** grants or revokes `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `REFERENCES` / `TRIGGER` on either the whole database or one table. (Only privileges that mean the same thing on both servers are offered; anything else — MySQL `INDEX`, PostgreSQL `TRUNCATE` — goes through the SQL tab.) A user allowed by a server-wide privilege (`*.*`) carries a **Global** badge, which revoking on this database does not remove |
| Routines | Stored procedures and functions. **Show definition** fetches the CREATE statement |
| Triggers | The triggers and their definitions |
| Events | MySQL's event scheduler (enable / disable / drop). On PostgreSQL the tab says it is not supported |

## Table

### Browse

- Click a column heading to sort (ascending → descending → off). Shift-click sorts by several columns (the number shows the order). **Rows per page** is kept in this browser
- **Columns N/M** chooses which columns to show (kept in the URL)
- A foreign key value links to the row it references (↗); a primary key links to the rows referencing it (↵)
- On a table over 100,000 rows with no filter, the exact count is skipped and the total reads *Approx. N rows*
- **Editing**: the pencil at the start of a row opens a dialog; double-clicking a cell edits it in place (`Enter` saves, `Esc` cancels). The copy icon **duplicates a row** (auto-increment columns take a new value)
- **Deleting**: tick the rows and press **Delete selected rows**; a confirmation follows
- A table with neither a primary key nor a unique key is addressed by `ctid` on PostgreSQL and by every column on MySQL (compared byte for byte, so rows that differ only in case or accents — which the collation would treat as equal — count as different rows). If that does not match exactly one row, the change fails and nothing is written. `ctid` is a physical position, so once another session has updated or deleted a row, an edit made from a stale screen can land on a different one — reload just before editing a table without a primary key (adding a primary key is the real fix)
- Views and sequences are read-only. So are PostgreSQL partitioned parents and inheritance parents (`ctid` repeats across children, so a row cannot be identified — edit through the child table)

### Structure

- Add, change and drop columns; add and drop indexes; add and drop foreign keys (to tables in the same schema); see what references this table; see the CREATE statement
- Every change goes **preview of the generated SQL → Run**. An operation that cannot be undone (TRUNCATE, DROP …) also asks you to retype the object's name

### SQL

- `⌘/Ctrl + Enter` runs. Several statements each get their own result (rows / affected rows / the position of an error), drawn as each one finishes
- **Cancel** stops a run in progress. A result past the **Row limit** shows only the first rows (and says so)
- **EXPLAIN** shows the query plan for a single statement
- **Confirm UPDATE / DELETE without WHERE** (on by default) asks before running a statement that would touch every row. It reads the text you typed, so it may ask once too often; it never stays silent when it should ask. Clearing the box runs without asking
- **CSV** and **JSON** download what is on screen. CSV has an option to **stop spreadsheets from running values as formulas** (off by default; it prefixes the value with an apostrophe, so do not use it for a file you intend to import back)
- **Saved queries** stores the editor text under a name (up to 200). Where they are kept depends on the deployment, and the panel says which: with a persistent session store (`SESSION_STORE=sqlite`, the production default) they are encrypted and tied to the connection account, so the same list appears when you sign in from another browser; with `SESSION_STORE=memory` they stay in this browser only
- **History** keeps the last 100 (**Clear history** removes them — do that before leaving a shared machine). Unsent editor text survives moving between tabs (within this browser tab)

Every run is autocommitted. A script that ends with a transaction still open is rolled back before the connection is returned (the screen then says the transaction was still open and was rolled back). Keep `BEGIN` and `COMMIT` in the same run.

### Search / Insert / Export / Import / Triggers / Operations

| Tab | Contents |
|---|---|
| Search | Combines per-column conditions (=, ≠, <, >, *contains*, *starts with* (no wildcards needed), LIKE, IS NULL …). The result carries over to the Browse tab |
| Insert | Inserts one row from a form, with **Use default** and **NULL** per column (the default is shown as the placeholder). The screen stays open afterwards so you can enter the next row (**Back to Browse** returns to the list) |
| Export | Downloads this table as SQL / CSV / JSON (structure and/or data) |
| Import | Loads a CSV into this table |
| Triggers | The triggers of this table |
| Operations | **Rename table**, **Table options** (comment; on MySQL also engine, collation and the next AUTO_INCREMENT value), **Copy table** (with or without its data), **Maintenance** (MySQL: ANALYZE / OPTIMIZE / CHECK TABLE; PostgreSQL: ANALYZE / VACUUM / VACUUM FULL), **Empty the table…** (TRUNCATE) and **Drop the table…** (DROP). A view offers only **Drop the view…** |

### Export in detail

- A SQL export can include routines, triggers and events. Routines are separated with `DELIMITER ;;`
- On MySQL the `DEFINER` clause (of routines, triggers and events) can be stripped so the dump restores as another user
- A MySQL SQL dump carries no database name, so it can be imported into a database with a different name as it is
- MariaDB sequences are written as `CREATE SEQUENCE` plus a `RESTART` from the current value; packages are written specification first, then body
- A standalone PostgreSQL sequence (one that is not the internal sequence of a serial or identity column) is written as `CREATE SEQUENCE`, `OWNED BY` and its current value (`setval`)
- A PostgreSQL materialized view is created `WITH NO DATA` and refreshed afterwards with `REFRESH MATERIALIZED VIEW`
- On PostgreSQL the dump also restores constraints (CHECK / UNIQUE / EXCLUDE and foreign key options), column collations, identity column options, `UNLOGGED`, inheritance and partitioning, the indexes of materialized views, and whether a trigger is enabled
- **Add DROP TABLE IF EXISTS** puts the DROPs of everything in the dump at the top, in dependency order, on PostgreSQL (`CASCADE` is not used, so if an object outside the dump depends on one of them, the restore stops there). On MySQL each DROP goes immediately before its CREATE
- Views and routines are ordered by the dependencies the server's own catalog reports

### Import in detail

- Files must be UTF-8 (run mysqldump with `--hex-blob`). psql meta-commands — `\connect` and the rest, as `pg_dump -C` writes them — cannot be run
- A SQL import offers **Stop on error** (on by default; turning it off skips a failed statement and continues), **Disable foreign key checks** and **Run in a single transaction**
- **On MySQL, "Run in a single transaction" cannot guarantee that everything is rolled back.** `CREATE` / `DROP` / `ALTER` commit implicitly, so in a dump that includes structure only the part after the last commit is rolled back (the result then says part of the file stays applied)
- **On PostgreSQL, "Disable foreign key checks" needs superuser privileges.** Without them the import is refused with `OPTION_FAILED` and nothing in the file runs — clear the option and try again
- A CSV is loaded in one transaction, and an error rolls the whole file back (a CSV import cannot be stopped once running). Set the **Target table**, **Delimiter**, whether **the first row holds the column names**, and the **NULL marker** (`\N` by default). An empty field is loaded as the empty string; only an unquoted value equal to the NULL marker becomes NULL. Header names are matched case-insensitively
- The result reports how many statements ran, succeeded, failed and did not run, the line number of an error, and warnings about switching databases or rolling a transaction back

## How values are shown

| Value | Shown / entered as |
|---|---|
| NULL | *NULL*, in italics. Forms have a **NULL** checkbox |
| Empty string | *(empty)*. Distinct from NULL |
| BIGINT / DECIMAL / date-time | Anything that would lose precision (a BIGINT past 2^53, DECIMAL, date-time values) is kept as the string the server returned — no rounding, no time zone conversion |
| JSON / arrays | Shown and edited as text |
| Binary | `[binary, N bytes]`. The first 64 KB are fetched, and it cannot be edited from a form (use SQL) |

## Limits

- A browse page shows at most 1,000 rows; a SQL console result at most 10,000
- A statement in the SQL console times out after 30 seconds (not adjustable from the screen). Use Import (up to 10 minutes) for long bulk work
- Generated columns (values the server computes from other columns) cannot be inserted or edited, and cannot be changed from the Structure tab either — a form cannot express the generation expression, and on MySQL the column would silently become an ordinary one. Use `ALTER TABLE` in the SQL tab
- Changing a column on MySQL replaces the whole definition with `MODIFY COLUMN`. Only what the form covers (name, type, nullability, default, AUTO_INCREMENT, comment) and what it carries over without showing (collation, `ON UPDATE CURRENT_TIMESTAMP`) is restated; `INVISIBLE` and the `SRID` of a spatial column are lost. On MariaDB a default containing characters outside the BMP (emoji, for instance) comes back from the catalog as `?`, so editing the column turns those characters into `?` (MySQL recovers them). Binary defaults have the same problem where the catalog does not return the value as it is: on MySQL a default containing a NUL byte (`BINARY(2) DEFAULT 0x0000`) is cut short and the change fails, and on MariaDB 10.11 a byte that the connection character set cannot represent (`DEFAULT 0xFF`) comes back as `?`, so the change replaces the default with `?`. Alter such a column with `ALTER TABLE` in the SQL tab
- Text longer than 65,536 characters is shown from the beginning with *… (truncated, N characters in total)* appended (that cell cannot be edited from the screen — update it from the SQL console; an export contains the whole value)
- A filtered count stops at 100,000 rows and reads *At least 100,000 rows* (jumping to the last page is then unavailable; use **Next**)
- If the tables selected for an export do not fit in the URL (hundreds of them), a message says so. Select all tables, or fewer of them
- An import file may be up to 64 MB
- The DROP half of **Add DROP TABLE IF EXISTS** (PostgreSQL) is wrapped in one transaction, but if the client restoring the dump does not stop on errors (`psql`'s default) and a DROP fails because an object outside the dump depends on it, the INSERTs still run and rows can be duplicated. Restore with errors fatal (`psql -v ON_ERROR_STOP=1`; tsmyadmin's own import does this by default)
- PostgreSQL has no event scheduler (use an extension such as `pg_cron`)
- Routines and triggers can be listed and their definitions shown, and **Edit in SQL tab** loads a script that replaces the definition into the editor (read it before running it). Creating a new one is done from the SQL tab
