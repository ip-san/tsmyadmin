<!-- translated-from: docs/phpmyadmin-parity.md sha256:8edf2f2758a5a95965ef3c7fab9c21da31b9bc09298a1e422a3d03288e18bd49 -->

# Feature parity with phpMyAdmin

Every input and action on every phpMyAdmin 5.2 screen (server, database, table and settings — 122 screens in all), checked against tsmyadmin. **tsmyadmin is phpMyAdmin-complete when every row of this table is either "✅" or "Out of scope".**

| Mark | Meaning |
|---|---|
| ✅ | An equivalent exists (on PostgreSQL, its counterpart) |
| △ | Partly there |
| ✗ | Not yet |
| Out of scope | Will not be built (with the reason) |

The basics (browsing and editing, structure changes, SQL, search, QBE, export / import basics, privileges, creating routines / triggers / events, tracking, central columns, display transformations, user groups, preferences, GIS, normalization, the console, zoom search) are done, so this table lists only what is still different.

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
| D8 | Copy options (carrying over foreign keys, AUTO_INCREMENT, privileges and the like) | ✅ |
| D9 | Routines: editing, running, dropping, exporting; DEFINER / SQL SECURITY / data access | ✅ |
| D10 | Triggers: editing, exporting; DEFINER | ✅ |
| D11 | Events: editing, exporting; ON COMPLETION PRESERVE; DEFINER | ✅ |
| D12 | Views: OR REPLACE, ALGORITHM, DEFINER, SQL SECURITY, column names, WITH CHECK OPTION, editing a view | ✅ |
| D13 | Designer: creating / dropping relations on the diagram, display column, saved pages, exporting the schema (SVG / PDF) | ✅ |
| D14 | Tracking: a per-database list, recording the DDL / DML statements run | ✅ |
| D15 | Normalization steps (as far as creating the new tables) | ✅ |

## Table

| # | Feature | Status |
|---|---|---|
| T1 | Browse: editing several rows, exporting / copying the chosen rows, creating a view from the result, charting it | ✅ |
| T2 | Browse: reordering columns (remembered), full / partial text, binary as hex, downloading a BLOB, spatial values as WKT | ✅ |
| T3 | Browse: ordering by an index, showing a foreign key's display column, profiling | ✅ |
| T4 | Insert: functions (NOW / UUID / MD5 …), several rows at once, choosing a foreign key value, insert as a new row (duplicate row), a BLOB from a file | ✅ |
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

## General

| # | Feature | Status |
|---|---|---|
| G1 | A settings screen (features, SQL, navigation, main panel, export / import defaults; saving to a file, loading, resetting) | ✅ |
| G2 | Shared bookmarks with `[VARIABLE]` substitution; SQL history kept on the server | ✅ |
| G3 | Console: history, bookmarks, options | ✅ |
| G4 | After a statement runs: edit / EXPLAIN / code for an application / run again | ✅ |
| G5 | Chart kinds (column, spline, area, pie, timeline, scatter); saving as an image | ✅ |
| G6 | GIS: saving as PNG / SVG | ✅ |
| G7 | More display transformations (hex, substring, boolean, date format, IPv4, prepend / append, image and text links) and input transformations (image upload, regular expression check, JSON / XML / SQL editors) | ✅ |
| G8 | Navigation: grouping by prefix, hiding items, paging when there are many | ✅ |
| G9 | Choosing the connection collation; server information on the home page | ✅ |
| G12 | Printable lists | ✅ |

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
