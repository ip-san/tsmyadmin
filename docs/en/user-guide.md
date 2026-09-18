<!-- translated-from: docs/user-guide.md sha256:64b3ac34e6fe809509bbc5ce305fdda741fdebb102564093b34045b3bc92ddac -->

# User guide

*日本語版: [docs/user-guide.md](../user-guide.md)*

What each screen does and how to work with it. The layout is the same three levels as phpMyAdmin (**server → database → table**), and the sidebar on the left reaches any of them.

## Connecting

1. Under **Server**, pick one of the presets your administrator configured, or choose **Enter manually** and fill in the server type, host and port
2. Enter your username and password and press **Connect**. PostgreSQL needs the name of a database to connect to (`postgres` when left empty)
3. Your credentials are held in a server-side session; the browser only gets a cookie with a signed session ID. (Separately, the last server, username and database are remembered in `localStorage` — never the password. On a shared machine, bear in mind that the next person sees which server you connected to.) After `SESSION_TTL_MINUTES` of inactivity (30 by default) the session ends; connecting again returns you to the page you were on

Your administrator restricts which hosts can be reached with `TSMYADMIN_ALLOWED_HOSTS`. Hosts outside that list cannot be connected to.

### Two-factor authentication (one-time codes and passkeys)

The **Security** tab at server level adds a one-time code from an authenticator app to the account this session logged in as.

1. **Enrol an authenticator app** shows a QR code, the key, an `otpauth://` URI and ten recovery codes — **once, there and then**. Scan the QR code with the app (where it cannot scan, type the key in or paste the URI)
2. Print the recovery codes or keep them in a password manager. Each works once, and they cannot be looked up later
3. Type the code the app is showing and **Finish enrolling**. Nothing takes effect until that succeeds, so stopping half-way cannot lock you out

From the next sign-in on, a code is asked for after the password. A recovery code goes in the same field. A code that has been accepted cannot be used again even within its own 30 seconds, so wait for the next one when signing in twice in a row.

**Passkeys**: where the administrator has set `TSMYADMIN_PASSKEY_ORIGIN`, **Enrol a passkey** adds a passkey (the device's biometrics, or a security key). Enrolled as the first method, it shows the recovery codes there and then. At sign-in, choose **Use a passkey** below the code field. It does not replace the password: it is the second step after it.

Once enrolled, the same tab lists the methods (authenticator app, passkeys) and lets you add or remove them. Changes take proof: type the app's current code in the **Code** field, or leave it empty to confirm with a passkey (a recovery code will not do).

To turn it all off, choose **Remove**. **If the device is gone and the recovery codes with it, you cannot undo this yourself** — ask the administrator to reset it from the **Users** tab. Where the administrator requires it of everyone (`TSMYADMIN_REQUIRE_2FA`), nothing else can be used until enrolment is finished.

## Interface language

The language menu at the top right switches between English and 日本語 (the page reloads, and the choice is kept in this browser). On a first visit the browser's language setting decides: English for English locales, Japanese otherwise.

## Elements shared by every screen

| Element | What it does |
|---|---|
| Sidebar | The tree of databases → (on PostgreSQL, schemas →) tables. The box at the top filters table names. Below it come **Favorites** (added and removed with the star by a table's name) and **Recent tables** (the last 10), kept in this browser for each connection. The button at the left of the header, or `⌘/Ctrl + B`, shows and hides it (the setting is kept in this browser) |
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
| Charsets and collations / Engines / Plugins | The character sets and collations, storage engines and plugins the server has (filtered on any column). PostgreSQL has none of these as such, so the same places show **Collations**, **Access methods** (table and index) and **Extensions** (available, and the version installed) |
| Processes | The connections the server has open. tsmyadmin's own carry a **tsmyadmin** badge. **Cancel query** stops the running statement only and leaves the connection, its transaction and its temporary tables alone (no confirmation). **Kill** closes the connection itself (the confirmation shows the user, database and running query) |
| Users | The accounts, their privileges (as GRANT statements), **Create user**, **Change password** and **Drop**. Accounts with a second factor that you may manage also get **Reset two-factor…** (for someone who lost their device) |
| Security | Two-factor authentication for the account this session logged in as (below). The secret needs somewhere to live, so the tab is only shown where the deployment has a persistent session store |

## Database

| Tab | Contents |
|---|---|
| Structure | Tables and views (estimated row count, engine, comment; the last row gives how many there are and totals their rows and size), creating a table, and **Create view** (a name and a SELECT statement). Tick several and use **Export the selected tables**, **Empty the selected tables…** or **Drop the selected tables…** (confirmed by typing the table name for one, the database name for several) |
| SQL | A SQL console scoped to this database (below) |
| Search | Finds rows containing a term in any column of the chosen tables (not case-sensitive; `%` and `_` are searched for as themselves; columns whose values have no readable text form are skipped — on MySQL binary, BIT and spatial types, on PostgreSQL bytea and the PostGIS types; PostgreSQL's bit, point and the like read as text and are searched). Each table shows its number of matching rows, and **Open in SQL tab** puts a SELECT for those rows into the SQL tab. Tables are searched one at a time, so **Stop** leaves the rest unsearched. Counts stop at 100,000 and read *N+ rows*. **What counts as a match differs by server**: MySQL compares in the connection's collation, so even `_bin` columns ignore case, accents are ignored, and in Japanese hiragana and katakana, full- and half-width letters, digits and katakana, and characters with and without dakuten (ハ and パ) all match — searches match broadly (half-width katakana with a separate dakuten mark, as in ﾊﾟ, counts as two characters, so the result depends on direction: searching for the full-width パ also finds rows containing ﾊﾟ, but searching for ﾊﾟ does not find rows that only contain パ). PostgreSQL distinguishes accents and treats full- and half-width forms as different characters; in `COLLATE "C"` columns it also distinguishes case outside ASCII |
| Query | Choose tables, output columns (alias, shown or not, sort) and conditions to build a SELECT, then **Open in the SQL tab** to edit and run it. A condition is a column, an operator and a value; conditions within a group are ANDed and groups are ORed. Values are written into the SQL as quoted literals. *contains* and *starts with* are LIKE, so they are case-sensitive on PostgreSQL and follow the column's collation on MySQL (unlike the Search tab). Several tables are **joined along their foreign keys** (LEFT JOINs starting from the first table chosen, each along a foreign key to a table already joined; foreign keys into another database or schema are not used; when several keys connect the same two tables, the first by constraint name is used, so change the ON clause in the SQL tab to join on another), and a set of tables no foreign key connects is refused. There is no free-form criteria row or LIKE pattern as in phpMyAdmin; add those in the SQL tab |
| Designer | A diagram of tables and foreign keys (view only). Lines are foreign keys; a box lists only the key columns and the columns they reference. Drag a box, or focus it and use the arrow keys (Shift for larger steps); the layout is saved in this browser only (**Reset layout** returns to the automatic layout). Under the diagram, a table lists the same keys (referenced table, ON DELETE / ON UPDATE, constraint name). A key into another database or schema appears only in that table, with its target qualified, and is not drawn. Unlike phpMyAdmin's Designer, nothing can be created or changed from the diagram |
| Export | Downloads the whole database as SQL / CSV / JSON / XML / YAML / Markdown (tables can be selected). See *Export in detail* below |
| Import | Loads a SQL script (mysqldump / mariadb-dump / pg_dump) or a CSV, with progress and a stop button. See *Import in detail* below |
| Privileges | Each user's current level on this database (All / Some / None), and granting or revoking everything on it. **Choose privileges…** grants or revokes `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `REFERENCES` / `TRIGGER` on either the whole database or one table. (Only privileges that mean the same thing on both servers are offered; anything else — MySQL `INDEX`, PostgreSQL `TRUNCATE` — goes through the SQL tab.) Choosing a table also lets you name columns — `SELECT` / `INSERT` / `UPDATE` / `REFERENCES` only, since `DELETE` and `TRIGGER` apply to the whole table and are refused before anything runs if combined with columns. Revoking at column level removes only a column-level privilege: it does not narrow one held on the whole table, which always covers every column. A user allowed by a server-wide privilege (`*.*`) carries a **Global** badge, which revoking on this database does not remove |
| Routines | Stored procedures and functions. **Show definition** fetches the CREATE statement. **Create routine** below builds one from its kind, name, parameters, return type and body (a MySQL BEGIN … END block is written as it is, semicolons and all — no DELIMITER needed) |
| Triggers | The triggers and their definitions. **Create trigger** builds one from its table, timing, event and body (on PostgreSQL a trigger function "name_fn" is created with it) |
| Events | MySQL's event scheduler (enable / disable / drop, and **Create event** on a one-off or repeating schedule). On PostgreSQL the tab says it is not supported |
| Operations | **Rename** and **copy** the database (see *Renaming and copying a database* below) |

### Renaming and copying a database

Both show the SQL before anything runs. The server's own databases are excluded, and on PostgreSQL so is the database you signed in with (the one this session is connected through).

| | MySQL | PostgreSQL |
|---|---|---|
| How a rename works | MySQL has no rename statement, so a new database is created and every table is moved in one (atomic) statement. **The old database is not dropped**, so routines or events your account cannot see, and tables created after you confirmed, are not taken with it. Seeing no tables does not mean it is empty: before dropping it, check it with an administrator account that can see everything. And an application still using the old name that creates its tables on startup will keep writing to the old database | `ALTER DATABASE … RENAME TO` |
| When a rename is refused | The database has any view, routine, trigger or event (they would be left behind, and views would lose the tables they read, so it stops before running) | Something is running in it |
| What a rename does not carry over | Privileges granted on the database (GRANT) | Nothing |
| Confirmation | Retype the current database name | Retype the current database name |
| What a copy includes | The tables' structure and, if chosen, their data. Foreign keys, views, routines, triggers, events and privileges are not copied | The whole database — tables, views, functions and data. It fails while anyone else is connected to the source |

On PostgreSQL, **idle** tsmyadmin connections to that database under the same database account are closed first. Nothing that is running is interrupted; in that case nothing changes and the operation fails. Copying needs the owner of the source database or a superuser.

## Table

### Browse

- Click a column heading to sort (ascending → descending → off). Shift-click sorts by several columns (the number shows the order). **Rows per page** is kept in this browser
- **Columns N/M** chooses which columns to show (kept in the URL)
- A foreign key value links to the row it references (↗); a primary key links to the rows referencing it (↵)
- On a table over 100,000 rows with no filter, the exact count is skipped and the total reads *Approx. N rows*
- **Editing**: the pencil at the start of a row opens a dialog; double-clicking a cell edits it in place (`Enter` saves, `Esc` cancels). The copy icon **duplicates a row** (auto-increment columns take a new value)
- **Deleting**: the bin at the start of a row deletes that row alone, or tick rows and press **Delete selected rows**; a confirmation follows
- Above the table is the SQL that fetched the page and how long it took. Filter values are not spliced into the SQL; they are listed as *Bound values*
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
- **Copy** puts the result on the clipboard as tab-separated text (column names first, NULL as `NULL`; the formula option above applies to it too), which a spreadsheet splits into cells when pasted. Over a connection that is neither HTTPS nor localhost some browsers refuse, and the screen says the copy failed. A result holding values cut for display cannot be copied, as it cannot be downloaded
- **Print** prints that statement's result alone (not the editor, sidebar or tabs). A long result that the screen draws only part of is laid out in full on paper, up to its first 1,000 rows. The browser's own print (`⌘/Ctrl + P`) prints every result
- **Chart** draws the result as bars or lines: one column for the categories (horizontal axis) and up to six numeric columns as values. A column can be a value only if it has at least one non-NULL value and every non-NULL value is a number (a single non-number rules it out). A row whose value is NULL is left out of that series (a line breaks there). Up to the first 500 rows are drawn; there are no other chart types such as pie charts
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
| Triggers | The triggers of this table. **Create trigger** there targets this table |
| Privileges | For each account that can log in: SELECT / INSERT / UPDATE / DELETE / REFERENCES / TRIGGER on this table, and where each comes from (the table, some columns, the whole database, the whole server; on PostgreSQL, superuser). **Choose privileges…** opens with this table already chosen. A revoke here only removes table and column grants; database-wide and server-wide grants stay. Privileges held through a role are not shown (nor, on PostgreSQL, the owner's implicit privileges or PUBLIC's). MySQL partial revokes (`partial_revokes`) are taken into account |
| Operations | **Rename table**, **Table options** (comment; on MySQL also engine, collation and the next AUTO_INCREMENT value), **Move table** (under the same name, rows and all: to another database on MySQL, to another schema of this database on PostgreSQL; the page then follows it), **Copy table** (with or without its data), **Maintenance** (MySQL: ANALYZE / OPTIMIZE / CHECK / REPAIR TABLE; PostgreSQL: ANALYZE / VACUUM / VACUUM FULL), **Empty the table…** (TRUNCATE) and **Drop the table…** (DROP). A view offers only **Drop the view…** |

### Export in detail

- Formats: SQL, CSV, JSON, XML, YAML and Markdown (table). CSV is one table at a time, with a comma, a semicolon (for Excel) or a tab between fields. XML and YAML lose nothing (NULL, binary as base64, and text holding control characters XML cannot carry, also as base64, are each told apart). Markdown is a table for documents, and writes binary values as their size only
- **Export templates** save the current choices (tables, format, structure / data, DROP, BOM and the rest) under a name to be loaded later. The list belongs to the database (and schema on PostgreSQL) and is not on the table-level Export tab. They are kept where saved queries are kept: with the connection account when sessions are persistent (encrypted, and visible from another browser), otherwise in this browser. With the account, the cap of 200 is shared with saved queries; in the browser each list has its own 200. Tables named by a template that no longer exist are left out of the selection and listed by name when it is loaded
- A SQL export can include routines, triggers and events. Routines are separated with `DELIMITER ;;`
- On MySQL the `DEFINER` clause (of routines, triggers and events) can be stripped so the dump restores as another user
- A MySQL SQL dump carries no database name, so it can be imported into a database with a different name as it is
- MariaDB sequences are written as `CREATE SEQUENCE` plus a `RESTART` from the current value; packages are written specification first, then body
- A PostgreSQL `serial` or `bigserial` column is written as `GENERATED BY DEFAULT AS IDENTITY` (an identity column). Numbering behaves the same, but the restored table no longer has a sequence of its own as a separate object, so anything naming `nextval('table_id_seq')` — an application, a trigger — needs fixing where it is restored
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
