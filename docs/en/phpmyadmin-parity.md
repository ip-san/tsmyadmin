<!-- translated-from: docs/phpmyadmin-parity.md sha256:bdb99a34abe2db17fe236333f30b87d3aff7d9cf05bd8308f894c0cc70d30143 -->

# Feature parity with phpMyAdmin

Every input and action on every phpMyAdmin 5.2 screen (server, database, table and settings — 122 screens in all), checked against tsmyadmin. **tsmyadmin is phpMyAdmin-complete when every row of this table is either "✅" or "Out of scope".**

| Mark | Meaning |
|---|---|
| ✅ | An equivalent exists (on PostgreSQL, its counterpart) |
| △ | Partly there |
| ✗ | Not yet |
| Out of scope | Will not be built (with the reason) |

The basics (browsing and editing, structure changes, SQL, search, QBE, export / import basics, privileges, creating routines / triggers / events, tracking, central columns, display transformations, user groups, preferences, GIS, normalization, the console, zoom search) are done, so this table lists only what is still different.

In 2026-09 every phpMyAdmin screen was audited again: ten rows marked ✅ went back to △, and new rows (S18–, D16–, T17–, E9–, G13–) and the quality debt (Q1–) were added. The steps for the remaining work are under "Remaining work in detail" at the end.

## Server

| # | Feature | Status |
|---|---|---|
| S1 | Collation when creating a database; dropping several databases at once | ✅ |
| S2 | SQL: formatting, bound parameters, a delimiter field, roll back when finished, toggling foreign key checks | ✅ |
| S3 | Status: overview (traffic, connections), query statistics, filtering variables by category and flagging alerts | ✅ |
| S4 | Live monitor (charts, refresh rate). Slow / general log analysis only with `log_output=TABLE` | ✅ |
| S5 | Advisor (configuration suggestions) | ✅ |
| S6 | Processes: show only the active ones, choose the refresh rate | ✅ |
| S7 | Changing a system variable (SET GLOBAL) | ✅ |
| S8 | Storage engine details (InnoDB status and the like) | ✅ |
| S9 | Binary log events | ✅ |
| S10 | Replication control (start / stop, skip errors, set up) | ✅ |
| S11 | Locking / unlocking accounts; exporting privileges as SQL | ✅ |
| S12 | Creating an account: host choices, authentication plugin, password generator, a database of the same name with its grant | ✅ |
| S13 | Resource limits, SSL requirements | ✅ |
| S14 | Editing global privileges one by one | ✅ |
| S15 | Editing column-level and routine-level privileges | ✅ |
| S16 | Renaming / copying an account | ✅ |
| S17 | Server-wide export / import (several databases) | ✅ |
| S18 | Removing several users at once (dropping same-named databases, REVOKE first) | ✅ |
| S19 | A per-account "database privileges" list (every DB the account has rights on, edit / revoke per row) | ✅ |
| S20 | WITH GRANT OPTION on database / table grants | ✅ |
| S21 | Changing one's own password (from the top page, without account-management rights) | ✅ |
| S22 | Replication: creating the replica user, guidance on the source settings (server_id / log_bin / binlog_format / gtid_mode) | ✅ |
| S23 | Details per engine (that engine's variables) | ✅ |
| S24 | The server's start time on Status; sorting the process list by column and a "full query" toggle | ✅ |
| S25 | A documentation link per variable (MySQL / MariaDB / PostgreSQL manuals) | ✅ |
| S26 | Database list: a toggle for computing statistics (sizes) and sorting by column | ✅ |

## Database

| # | Feature | Status |
|---|---|---|
| D1 | Bulk actions on the chosen tables: copy, show CREATE, ANALYZE / CHECK / CHECKSUM / OPTIMIZE / REPAIR, add / replace a prefix | ✅ |
| D2 | More list columns (charset, created / updated), counting the exact rows on the spot | ✅ |
| D3 | Data dictionary (every table's definition, for printing) | ✅ |
| D4 | Search kinds (any word / all words / exact phrase / regular expression), filtering by column name | ✅ |
| D5 | Multi-table query (with the joins) | ✅ |
| D6 | Saving query builder criteria | ✅ |
| D7 | Changing the default collation (applied to every table and column) | ✅ |
| D8 | Copy options (carrying over foreign keys, AUTO_INCREMENT, privileges and the like) | △ (the database-level copy only has "copy the data"; structure-only / data-only, AUTO_INCREMENT, constraints and switching to the copy are missing → D8) |
| D9 | Routines: editing, running, dropping, exporting; DEFINER / SQL SECURITY / data access | △ (editing opens the SQL tab; a form pre-filled with parameters and body is missing → D9) |
| D10 | Triggers: editing, exporting; DEFINER | △ (editing opens the SQL tab → D10) |
| D11 | Events: editing, exporting; ON COMPLETION PRESERVE; DEFINER | △ (editing opens the SQL tab; PostgreSQL has no events → D11) |
| D12 | Views: OR REPLACE, ALGORITHM, DEFINER, SQL SECURITY, column names, WITH CHECK OPTION, editing a view | ✅ |
| D13 | Designer: creating / dropping relations on the diagram, display column, saved pages, exporting the schema (SVG / PDF) | △ (small/big boxes, snap to grid, labels on relation lines, straight/angled lines, hiding lines, full screen are missing → D13) |
| D14 | Tracking: a per-database list, recording the DDL / DML statements run | ✅ |
| D15 | Normalization steps (as far as creating the new tables) | ✅ |
| D16 | Table options on the create-table form (engine, collation, comment) | ✗ (set afterwards under Operations) |
| D17 | A favourite star per row of the structure list | ✗ (only on the table page) |
| D18 | Editing and downloading central columns | ✗ |
| D19 | Tracking: deleting a version, and downloading its definition as SQL | ✗ |
| D20 | Query builder: inserting a column before another (Ins / Del) | △ (append only) |
| D21 | Database search: deleting the matching rows | ✗ (browse only) |
| D22 | Designer: exporting the schema as DIA / EPS | ✗ |
| D23 | Structure: proposing a table structure (the best type for each column from its values; MySQL 8.0 has no PROCEDURE ANALYSE, so the values are read and the type inferred on the client) | ✗ |

## Table

| # | Feature | Status |
|---|---|---|
| T1 | Browse: editing several rows, exporting / copying the chosen rows, creating a view from the result, charting it | △ (the executed-SQL box has no Edit / EXPLAIN / As code / Bookmark / Refresh → T1) |
| T2 | Browse: reordering columns (remembered), full / partial text, binary as hex, downloading a BLOB, spatial values as WKT | ✅ |
| T3 | Browse: ordering by an index, showing a foreign key's display column, profiling | ✅ |
| T4 | Insert: functions (NOW / UUID / MD5 …), several rows at once, choosing a foreign key value, insert as a new row (duplicate row), a BLOB from a file | △ (no choice of what happens after the insert, no SQL preview, no insert-ignoring-errors → T4) |
| T5 | Search operators: IN / NOT IN / BETWEEN / REGEXP / comparing with an empty string | ✅ |
| T6 | Search: columns to show, DISTINCT, a free WHERE clause, ordering, page size | ✅ |
| T7 | Find and replace: regular expressions | ✅ |
| T8 | Zoom search: conditions per axis, a label column, a cap on points drawn | ✅ |
| T9 | Column definition: collation, attributes (UNSIGNED / ZEROFILL / BINARY / ON UPDATE), generated columns, moving a column, a key when adding | ✅ |
| T10 | Structure: a key on the chosen columns, changing / dropping several at once, reordering columns | ✅ |
| T11 | Indexes: FULLTEXT / SPATIAL, method, prefix length, renaming, editing | ✅ |
| T12 | Structure information: space used, row statistics, printing | ✅ |
| T13 | Creating and managing partitions | ✅ |
| T14 | Relations: foreign keys to another database, display column | ✅ |
| T15 | Operations: ROW_FORMAT, changing every column's collation, ALTER TABLE ORDER BY, CHECKSUM, FLUSH, copy options | ✅ |
| T16 | Tracking: choosing which kinds of statement to record | ✅ |
| T17 | Browse: show all rows (a setting lifts the 1,000 rows per page cap; a warning above 10,000 rows) | ✗ |
| T18 | Structure: "browse distinct values" of a column (DISTINCT with counts) | ✗ |
| T19 | Operations: check referential integrity (rows without a parent, per foreign key) | ✗ |
| T20 | Operations: more table options (PACK_KEYS / DELAY_KEY_WRITE / TRANSACTIONAL / PAGE_CHECKSUM / STATS_PERSISTENT / STATS_AUTO_RECALC) | ✗ |
| T21 | Browse: a profiling toggle (MySQL) | ✗ (SQL tab only) |
| T22 | Browse: highlighting the row under the pointer | ✗ |
| T23 | Search: ENUM / SET columns offer their values | ✗ |

## Export / import

| # | Feature | Status |
|---|---|---|
| E1 | Formats: ODS, ODT, Word, CSV for Excel, LaTeX, Texy!, MediaWiki, HTML (PDF is out of scope, below) | ✅ |
| E2 | Compression (zip / gzip), a file per table, file name templates, character set | ✅ |
| E3 | SQL options: INSERT / UPDATE / REPLACE, complete / extended INSERTs, maximum statement length, INSERT IGNORE, binary as hex, UTC times, a transaction, views as tables, CREATE DATABASE / USE, IF NOT EXISTS, comments | ✅ |
| E4 | A range of rows; locking the tables | ✅ |
| E5 | Import formats: ODS, XML, MediaWiki | ✅ |
| E6 | Compressed files, the file's character set, resuming part way, drag and drop | ✅ |
| E7 | CSV: creating a new table from it, REPLACE / IGNORE, enclosure and escape characters | ✅ |
| E8 | SQL: NO_AUTO_VALUE_ON_ZERO | ✅ |
| E9 | Export options per format (LaTeX caption / label, what XML includes (routines, triggers, views, data), JSON pretty / compact, CSV remove line breaks / always quote / header row, YAML / Markdown / Texy! / MediaWiki / ODT / Word structure-and-data choice, ODS NULL text) | ✗ |
| E10 | Import options per format (CSV column mapping and line terminator, ODS / XML percentages, currencies and dates, skipping empty rows) | ✗ |

## General

| # | Feature | Status |
|---|---|---|
| G1 | A settings screen (features, SQL, navigation, main panel, export / import defaults; saving to a file, loading, resetting) | △ (the "Features" and "Main panel" items (default tab, default insert row count, repeated headers…) are missing → G1) |
| G2 | Shared bookmarks with `[VARIABLE]` substitution; SQL history kept on the server | ✅ |
| G3 | Console: history, bookmarks, options | △ (Enter-to-run, open at start and expand-messages settings are missing → G3) |
| G4 | After a statement runs: edit / EXPLAIN / code for an application / run again | ✅ |
| G5 | Chart kinds (column, spline, area, pie, timeline, scatter); saving as an image | ✅ |
| G6 | GIS: saving as PNG / SVG | ✅ |
| G7 | More display transformations (hex, substring, boolean, date format, IPv4, prepend / append, image and text links) and input transformations (image upload, regular expression check, JSON / XML / SQL editors) | △ (the download link and the IP → integer input transformation are missing; Formatted / Imagelink / External are out of scope → G7) |
| G8 | Navigation: grouping by prefix, hiding items, paging when there are many | ✅ |
| G9 | Choosing the connection collation; server information on the home page | ✅ |
| G12 | Printable lists | ✅ |
| G13 | Favourites, recent tables, column order / visibility, display column and the sidebar state kept with the account (pmadb's recent / favorite / table_uiprefs / table_info) | ✗ (this browser only) |
| G14 | Navigation: expand all / collapse all / reload | ✗ |
| G15 | Routines and events in the navigation tree (optional setting) | ✗ |
| G16 | Resizable sidebar (remembered, keyboard too) | ✗ |
| G17 | Table comments as tooltips in the tree | ✗ |
| G18 | Console settings: Enter runs (Shift+Enter for a new line), open at start, expand messages | ✗ |
| G19 | A settings icon per page (to that screen's settings) | ✗ |
| G20 | A manual link per page (per dialect) | ✗ (one help link only) |
| G21 | A warning before the session expires, with "extend" | ✗ (redirect after it expires) |
| G22 | More keyboard shortcuts (d / s / t / h / b / e, Ctrl+Space for completion) | △ (7) |
| G23 | The "Features" and "Main panel" settings (default tab, default insert row count, repeated headers every N rows, confirm DROP, grid editing default, save on blur…) | ✗ |
| G24 | Display transformation: a download link for binary values. Input transformation: IPv4 → integer | ✗ |
| G25 | A PostgreSQL note on each row where the equivalent is missing or different (S1 / S8 / S13 / D1 / D9 / D11 / T10 / T13 / T15) | ✗ (docs only) |
| G26 | The console's "Debug SQL" tab (the statements the screens issued, with timings) | ✗ |
| G27 | The Formatted display transformation (a value shown as HTML; sanitising is a must) | ✗ |
| G28 | The Imagelink display transformation (an external image URL; the allowed hosts come from an environment variable and are added to the CSP's `img-src`) | ✗ |

## Quality debt (found in review, still open)

| # | Item | State |
|---|---|---|
| Q1 | `POST /sql-history` reads then writes without atomicity: two tabs on one account lose each other's runs (`apps/api/src/routes/sql-lists.ts`) | ✅ |
| Q2 | The shared-bookmark name check is not atomic: two accounts saving the same name at once swap the owner (same file) | ✅ |
| Q3 | `toLocaleString('ja-JP')` and the like hard-coded in 32 places under `apps/web/src` (Japanese separators and clock in the English UI). Put number / time formatters in `config/locale.ts` and replace them | ✅ |
| Q4 | A chart saved as SVG / PNG has no legend (the legend is a `<figcaption>` outside the SVG); scatter and timeline show no legend on screen either | ✅ |
| Q5 | Input transformations run the regular expression / JSON / XML check on every keystroke on the main thread; debounce or check on blur | ✅ |
| Q6 | MySQL "leave out duplicates" is `INSERT IGNORE`, which also lets truncation and other warnings pass silently; surface `SHOW WARNINGS` in the import result (optional) | ✅ |
| Q7 | Bookmark variables such as `[DB]` expand unquoted; quote them as identifiers per dialect | ✅ |
| Q8 | "Load" on a shared bookmark blanks the editor if the list refetched before the click (`SqlPanels.tsx`); carry the body in `NamedEntry` | ✅ |
| Q9 | Components over 300 lines (`SqlConsole.tsx` 380, `ExportOptionFields.tsx` 303, `AccountDialogs.tsx` 302) to split | ✅ |
| Q10 | The sidebar's open-group state is keyed by prefix alone (`TableList.tsx`); include db / schema | ✅ |

## Out of scope

| Feature | Reason |
|---|---|
| MySQL 3.23 / 4.0 compatibility modes (export / import) | Not used by current servers |
| Export: CodeGen (NHibernate), PHP array | Tied to one language or framework; outside a general administration tool |
| Import: LOAD DATA | `LOCAL` lets the server ask the client for any file, which is why it is off (mysql2 disables it too). Without `LOCAL` it reads files on the database server, which does not fit a container deployment |
| Export: writing PDF directly | It would mean shipping fonts to embed for Japanese and other scripts. The "HTML (print / PDF)" export gives a PDF through "Save as PDF" |
| Import: ESRI Shape files | A binary GIS format outside database administration (spatial data imports as WKT through SQL / CSV) |
| Translation into about 80 languages | The quality could not be kept. A language is one added file and two lines (the steps are under "Adding a language" in architecture.md) |
| Themes other than light / dark | Every colour is a CSS variable, which is where a deployment changes its palette |
| Update checks, error reports | They talk to an outside service, which an administration tool kept inside the network does not do |
| GIS map tiles (OpenStreetMap) | The coordinates on screen would leave for an outside service |
| HTTP / config / signon authentication, reCAPTCHA, the web setup script | Replaced by the login form, two-factor authentication and environment variables |
| Saving files on the server, upload directories | Does not fit running in a container (downloads and uploads are used instead) |
| Display transformations that run external commands | They would run arbitrary commands on the server |
| The External (external command) transformation | It would run arbitrary commands on the server (the same reason as the row above) |

## Remaining work in detail

Steps for the next (implementing) session. Go batch by batch from A, one commit per batch. S / M / L are estimates: check the real size when you start. Before each item, confirm the "current state" location with a grep; while working, keep to the YOU MUST rules in `CLAUDE.md` (Zod → API → `hc<AppType>`, `SAMPLE_OPS` snapshots for both dialects on a new DdlOp, DDL through the preview, both ja / en locales, `CHANGELOG.md`, `docs/` and `docs/en/` together + `bun run docs:sync`). Turn a finished row to ✅ in the table.

### Batch A: quality debt (Q1–Q10)

- **Q1 / Q2** (M): add `update(config, kind, name, fn)` to `SavedItems` in `apps/api/src/session/store.ts`, doing the read and the write in one transaction (SQLite) / WATCH-MULTI (Redis), with implementations in `sqlite-store.ts` / `redis-store.ts` and tests in `session/conformance.ts`; rewrite the history add and the shared-bookmark save in `routes/sql-lists.ts` on it. Done: concurrent POSTs from two clients of one account both remain in `GET /sql-history` (`app.test.ts`); a second save of a taken name always gets 409.
- **Q3** (M): put `numberLocale` (`'ja-JP' | 'en-US'`) and `formatNumber` / `formatTime` in `config/locale.ts` and replace the 32 sites of `git grep "'ja-JP'" apps/web/src` (`SqlPanels.tsx`, `MonitorChart.tsx`, `ResultChart.tsx`, `ChartXY.tsx`, `ConsoleOptions.tsx`…). Done: the grep returns only `locales/ja.ts`; a web test renders HistoryPanel under `en` and sees `1,234` and a 24-hour clock.
- **Q4** (M): draw the legend inside the SVG (a `<g>` top-right with a rect + text per series) and keep only an sr-only description in the HTML (`components/results/ResultChart.tsx`, `ChartPie.tsx`, `ChartXY.tsx`). Done: `e2e/sql-results.spec.ts` finds each series name in the saved SVG text.
- **Q5** (S): debounce the check in `components/rows/RowField.tsx` by 150 ms, or run it on blur; the pattern length cap (200) exists. Done: the RowForm test shows no `JSON.parse` per keystroke.
- **Q6** (M, optional): after `INSERT IGNORE` in `packages/adapter/src/base.ts` `insertRows`, read `SHOW WARNINGS` and surface the non-duplicate ones (1265 / 1366…) as `ImportResult` warnings. Done: an integration test shows a truncated value as a warning.
- **Q7** (S): quote as an identifier per dialect (`` ` `` / `"`) in `features/sql/variables.ts` (the web cannot import the adapter, so a small helper). Done: a unit test turns `my db` into `` `my db` `` / `"my db"`.
- **Q8** (S): give `NamedEntry` in `components/panels/NamedListPanel.tsx` a `payload`, and have the shared bookmarks in `SqlPanels.tsx` load it.
- **Q9** (M): move the history / bookmark wiring of `SqlConsole.tsx` into a `useConsoleLists` hook, `SqlFields` of `ExportOptionFields.tsx` into its own file, and split `AccountDialogs.tsx` in two. Done: `node scripts/check-architecture.mjs` prints no warnings.
- **Q10** (S): key `openGroups` in `features/sidebar/TableList.tsx` by `${db}/${schema}/${prefix}`.

### Batch B: server (S18–S26)

- **S18** (M): add a `dropUsers` op (`users[]`, `dropSameNameDatabases`, `revokeFirst`) to `packages/shared/src/schemas/users.ts`, both builders in `packages/adapter/src/{mysql,postgres}/users.ts` with `SAMPLE_OPS` snapshots in `test/users.test.ts`, a checkbox column and bulk bar in `features/users/UsersPage.tsx` (`confirmName` is the host). Done: tick two accounts → the preview shows `DROP USER a, b` (and `DROP DATABASE` when ticked) → both are gone on both dialects (`e2e/users.spec.ts`).
- **S19** (M): a new `features/users/AccountDatabasesPanel.tsx` that turns `grantsQuery` (parsed like `global-privileges.ts`) into one row per database the account has rights on, with a link to `/db/$db/privileges` and a revoke button.
- **S20** (S): `grantOption: boolean` on `PrivilegeTarget`, both builders (PostgreSQL: `WITH GRANT OPTION` / `REVOKE GRANT OPTION FOR`) and snapshots, a checkbox in `PrivilegeChooser.tsx`.
- **S21** (S–M): in `apps/api/src/routes/users.ts` allow a password change when `user === session.user` even without `canManageAccount`; open a dialog (reusing `features/users/PasswordForm.tsx`) from `features/server/ServerInfoCard.tsx`. Done: the fixture `reader` account changes its own password from the top page (`e2e/server-home.spec.ts`).
- **S22** (M): "Create a replica user…" in `ReplicationControls.tsx` (`createUser` + `REPLICATION SLAVE`; PostgreSQL `WITH REPLICATION`) and a guidance card reading `server_id` / `log_bin` / `binlog_format` / `gtid_mode` from `variablesQuery`.
- **S23** (S): opening an engine row in `ServerCatalogPage.tsx` shows the variables of its prefix (`innodb_` / `myisam_` / `aria_`).
- **S24** (S): the start time (now − uptime) in `insights.ts`; column sorting and a 100-character cut with a full-query toggle in `ProcessesPage.tsx`.
- **S25** (S): a manual URL per row in `VariablesPage.tsx` (MySQL `…/server-system-variables.html#sysvar_<name>`, the MariaDB KB, PostgreSQL `runtime-config`), following the external-link policy in `docs/security.md`.
- **S26** (S–M): `listDatabases({ stats })` in the adapter and API; a "compute sizes" toggle and column sorting on the top page.

### Batch C: database (the △ of D8–D13, D16–D21)

- **D9 / D10 / D11** (L): add `replaceRoutine` / `replaceTrigger` / `replaceEvent` (DROP + CREATE, or CREATE OR REPLACE) to `packages/shared/src/schemas/ddl.ts`, both builders, `SAMPLE_OPS` and conformance; give `CreateRoutineForm` / `CreateTriggerForm` / `CreateEventForm` an `initial` so "Edit" on each page opens them pre-filled (today `useEditDefinition` in `lib/open-in-console.ts` sends the definition to the SQL tab). Done: editing a parameter and a schedule passes E2E on both dialects (`e2e/routine-actions.spec.ts`).
- **D8** (M): the same choices as the table copy on the `copyDatabase` op (structure only / structure and data / data only, AUTO_INCREMENT, constraints, switch to the copy) in `DatabaseOperations.tsx`, `mysql/ddl.ts`, snapshots.
- **D13** (M): small/big boxes, snap to grid, labels on lines, straight / angled lines, hiding lines and full screen in `DesignerToolbar.tsx`, stored in the `designer-pages.ts` body. DIA / EPS are out of scope.
- **D16** (M): `engine` / `collation` / `comment` on the `createTable` op (PostgreSQL: comment only) and fields in `CreateTableForm.tsx` (reuse `operations/TableOptionsForm.tsx`).
- **D17** (S): a star per row in `TablesList.tsx` (`lib/table-shortcuts.ts`).
- **D18** (S): "Edit" (pre-fills the add form) and "Download" (JSON) in `CentralColumnsPage.tsx`.
- **D19** (M): `DELETE …/tracking/:version` in `apps/api/src/routes/tracking.ts`; delete and "Download SQL" in `TrackingPage.tsx`.
- **D20** (S): "insert before" on each output column of the query builder.
- **D21** (S): a "Delete" action on database search results (a DELETE with the same WHERE, through the preview).
- **D22** (M): from the same layout as `features/database/designer-svg.ts`, write DIA (XML: boxes and lines in a `<dia:diagram>`) and EPS (PostScript text) in `designer-dia.ts` / `designer-eps.ts`, and add them to the toolbar. Done: the files open in `dia` and `gs` (checked once by hand; the unit tests look at the structure only).
- **D23** (M): move the type inference of `apps/api/src/lib/import-create.ts` to `packages/shared` so the web can use it; "Propose a structure" in `ColumnsTable.tsx` reads the first rows of each column (`/rows`, up to 1,000), proposes a narrower type than the current one and hands it to the `changeColumn` preview. Done: an E2E proposes `INT` for a `VARCHAR(255)` column holding only integers.

### Batch D: table (the △ of T1 / T4, T17–T23)

- **T1** (M): move `features/sql/StatementActions.tsx` and `SqlCodeDialog.tsx` to `components/` and give `features/browse/ExecutedStatement.tsx` Edit / EXPLAIN / As code / Bookmark (`useSavedQueries`) / Refresh.
- **T4** (M): at the foot of `RowForm.tsx`: "afterwards: stay here / back to the list / edit the next row", "ignore errors" (`INSERT IGNORE` / `ON CONFLICT DO NOTHING`), and "Preview SQL" (values shown as bound).
- **T17** (S–M): "Show all" in `Pagination.tsx`, enabled by a `browseUnlimited` setting (off by default). Allow `limit=0` beyond `BROWSE_MAX_LIMIT` (shared schema and the adapter's `browseRows`) and warn before fetching more than 10,000 rows. The grid is already virtualised.
- **T18** (S): "distinct values" per column in `ColumnsTable.tsx` (`SELECT col, COUNT(*) … GROUP BY` through `/sql` into a small dialog).
- **T19** (S): "Check referential integrity" in `TableOperations.tsx` (`LEFT JOIN … WHERE ref IS NULL` per foreign key).
- **T20** (S): the MySQL options on the `setTableOptions` op, `TableOptionsForm.tsx` and snapshots (PostgreSQL: UNSUPPORTED).
- **T21** (S–M): pass `profile` through `browseRows`; a toggle in `BrowseToolbar.tsx` and `ProfileView.tsx` under the grid.
- **T22** (S): `hover:bg-surface-sub` in `BrowseRow.tsx` (the visual snapshots need refreshing).
- **T23** (S): `enum(...)` / `set(...)` types become selects in `SearchForm.tsx`.

### Batch E: cross-cutting (the △ of G1 / G3 / G7, G13–G25)

- **G13** (M): per-account items (favourites, recent, column settings, display column, sidebar state) in `stored.ts`, `SAVED_ITEM_KINDS`, `routes/stored.ts`, and switch `lib/{table-shortcuts,display-column,account-prefs}.ts` / `browse-search.ts` to the account (as `useNamedList` does). Done: they follow the account into a second browser under `SESSION_STORE=sqlite` (`e2e/account-preferences.spec.ts`).
- **G14** (S): expand all / collapse all / reload (refetch `databases` / `tables`) in `DbTree.tsx`.
- **G15** (M): a `navShowRoutines` setting that adds "Routines" and "Events" branches under an expanded database (`routinesQuery` / `eventsQuery`).
- **G16** (S): a drag handle in `AppShell.tsx` (200–480 px, keyboard too), `navWidth` in the settings.
- **G17** (S): the comment in `TableLink.tsx`'s `title`.
- **G18** (S): `sqlEnterRuns` / `consoleStartOpen` settings and the `SqlEditor.tsx` keymap.
- **G19** (S): a gear in `PageTitle.tsx`'s `actions` (`/settings#section`), anchors in `SettingsPage.tsx`.
- **G20** (S): a manual link per tab heading, per dialect (`locale.docs.*`).
- **G21** (S): the TTL on `/session`; a notice with "extend" two minutes before expiry in `routes/_app.tsx`.
- **G22** (S): d / s / t / h / b / e and Ctrl+Space in `ShortcutHelp.tsx` / `useShortcuts`.
- **G1 / G23** (M): default tab (server / DB / table), default insert row count, headers every N rows, confirm DROP, grid-editing default and save-on-blur in `PreferencesSchema`, `SettingsSections.tsx` and the consumers (`RowsGrid.tsx`, `InsertPage.tsx`, the redirect in `routes/_app/db.$db/index.tsx`).
- **G3** (S): covered by the G18 change.
- **G7 / G24** (S): `download` in `DISPLAY_TRANSFORMS` (the download URL from `lib/cell-url.ts`), `ipv4-to-int` in `INPUT_TRANSFORMS` (converted in `RowForm`'s `writtenValue`).
- **G25** (S, docs only): a "On PostgreSQL…" note on the rows concerned (no events, no REQUIRE SSL, no CHECK / REPAIR, no column reordering, no partitioning of an existing table…), based on the UNSUPPORTED cases in `packages/adapter/src/postgres/ddl.ts`.
- **G26** (M): in `lib/api.ts` (`unwrap` / `streamSql`), record the SQL the screens issue (`/sql`, the `executedSql` of `/rows`) with its duration in a ring buffer of this browser (200 at most), and add a "Debug SQL" tab to the docked console (time, duration, statement, run again). Mask statements holding a password as the audit log does.
- **G27** (M): add `html` to `DISPLAY_TRANSFORMS` and draw it in `TransformedCell.tsx` **after sanitising** (the `Sanitizer` API where it exists, else an allowlist of tags and attributes — `p b i u em strong a[href=http(s)] ul ol li br code pre table tr td th` — of our own). `javascript:` / `data:` hrefs and `on*` attributes are always dropped. Done: a unit test shows `<img onerror>` and `<script>` are not rendered.
- **G28** (M): an environment variable `TSMYADMIN_IMAGE_HOSTS` (comma-separated hosts allowed; in `apps/api/src/config.ts`, `.env.example`, `docs/deployment.md` and `docs/en/deployment.md`) added to the CSP's `img-src` (`apps/api/src/app.ts`); `imagelink` in `DISPLAY_TRANSFORMS` (the value, or the template with the value put in, as an http(s) URL in an `<img>`; a host outside the list is shown as a link). Done: an E2E in which only images from an allowed host are drawn (the API serves a test image at `/e2e-image`).

### Batch F: export / import (E9–E10)

- **E9** (L): per-format fields on `ExportQuerySchema` / `ExportOptionsSchema`, applied in `apps/api/src/lib/{export,export-formats,export-documents,export-office}.ts`, per-format sections like `CsvFields` in `components/export/ExportOptionFields.tsx`, `export-url.ts`, the template body, `export.test.ts`, `e2e/export.spec.ts`. Done: XML can include routines, triggers and views; CSV can drop the header row and quote every field; JSON can be compact.
- **E10** (M): a CSV column mapping (`columns`) and line terminator, "skip empty rows" for the rows formats, and ODS percentage / currency / date handling on `ImportFormSchema`, in `import.ts` / `import-rows.ts` / `ImportOptionFields.tsx` / `lib/import-options.ts`.
