/** API against the real compose databases (bun run test:integration). */
import { createAdapter } from '@tsmyadmin/adapter'
import {
  ApiErrorSchema,
  BrowseResultSchema,
  ImportEventSchema,
  SessionStateSchema,
  SnapshotListSchema,
  SnapshotRestorePreviewSchema,
  SnapshotRestoreResultSchema,
  StatementResultSchema,
  TableSchemaSchema,
} from '@tsmyadmin/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { MemorySessionStore } from './session/store.ts'

const targets = [
  {
    dialect: 'mysql' as const,
    url: process.env.TEST_MYSQL_URL ?? 'mysql://tsmyadmin:tsmyadmin@127.0.0.1:13306/tsmyadmin_test',
  },
  {
    dialect: 'postgres' as const,
    url: process.env.TEST_PG_URL ?? 'postgres://tsmyadmin:tsmyadmin@127.0.0.1:15433/tsmyadmin_test',
  },
  // TEST_DIALECTS=mysql restricts the run to one server (the MariaDB CI job has no PostgreSQL service).
].filter((t) => !process.env.TEST_DIALECTS || process.env.TEST_DIALECTS.split(',').includes(t.dialect))

const store = new MemorySessionStore({ adapterFactory: createAdapter, sweepIntervalMs: 0 })
const app = createApp({ ...loadConfig({}), sessionSecret: 'integration-secret', allowedHosts: ['*'] }, { store })
afterAll(() => store.closeAll())

describe.each(targets)('API integration ($dialect)', ({ dialect, url }) => {
  const u = new URL(url)
  const login = {
    dialect,
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  }
  let cookie = ''
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } })

  it('logs in against the real server', async () => {
    const res = await req('/api/session', { method: 'POST', body: JSON.stringify(login) })
    expect(res.status).toBe(201)
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(SessionStateSchema.parse(await res.json()).dialect).toBe(dialect)
  })

  it('refuses to rename a MySQL database that has a view, trigger, routine or event, on the real server', async () => {
    if (dialect !== 'mysql') return
    const name = `it_dbops_${Date.now().toString(36)}`
    const run = (sql: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql, stopOnError: true }) })
    await run(`CREATE DATABASE ${name}`)
    try {
      await run(
        [
          `CREATE TABLE ${name}.t (id INT PRIMARY KEY)`,
          `CREATE VIEW ${name}.v AS SELECT id FROM ${name}.t`,
          `CREATE TRIGGER ${name}.trg BEFORE INSERT ON ${name}.t FOR EACH ROW SET NEW.id = NEW.id`,
          `CREATE PROCEDURE ${name}.p() SELECT 1`,
          `CREATE EVENT ${name}.e ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1`,
        ].join(';\n')
      )
      const res = await req('/api/databases/information_schema/ddl/preview', {
        method: 'POST',
        body: JSON.stringify({ op: { op: 'renameDatabase', name, newName: `${name}_x` } }),
      })
      expect(res.status).toBe(400)
      const { message } = ApiErrorSchema.parse(await res.json())
      for (const what of ['1 views', '1 triggers', '1 routines', '1 events']) expect(message).toContain(what)
    } finally {
      await run(`DROP DATABASE IF EXISTS ${name}`)
    }
  })

  it('rejects wrong passwords', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, password: 'nope' }),
    })
    expect(res.status).toBe(401)
  })

  it('connects in the collation asked for (MySQL), and refuses a name that is not one', async () => {
    if (dialect !== 'mysql') return
    const asked = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, collation: 'utf8mb4_bin' }),
    })
    expect(asked.status).toBe(201)
    const own = asked.headers.get('set-cookie')?.split(';')[0] ?? ''
    const ran = await app.request('/api/databases/tsmyadmin_test/sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: own },
      body: JSON.stringify({ sql: 'SELECT @@collation_connection AS c' }),
    })
    const [result] = z.array(StatementResultSchema).parse(await ran.json())
    expect(result?.kind === 'rows' ? result.result.rows : null).toEqual([['utf8mb4_bin']])
    const bad = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, collation: 'x; y' }),
    })
    expect(bad.status).toBe(400)
  })

  it('walks databases → tables → structure → rows', async () => {
    const dbs = z.array(z.object({ name: z.string() })).parse(await (await req('/api/databases')).json())
    expect(dbs.map((d) => d.name)).toContain('tsmyadmin_test')
    const tables = await (await req('/api/databases/tsmyadmin_test/tables')).json()
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(tables)
        .map((t) => t.name)
    ).toContain('users')
    const structure = TableSchemaSchema.parse(
      await (await req('/api/databases/tsmyadmin_test/tables/users/structure')).json()
    )
    expect(structure.primaryKey).toEqual(['id'])
    const rows = BrowseResultSchema.parse(
      await (await req('/api/databases/tsmyadmin_test/tables/users/rows?sort=name:desc&limit=2')).json()
    )
    expect(rows.rows.map((r) => r[1])).toEqual(['Eve', 'Dave'])
    expect(rows.total).toBe(5)
  })

  it('runs SQL and previews DDL', async () => {
    const results = z.array(StatementResultSchema).parse(
      await (
        await req('/api/databases/tsmyadmin_test/sql', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT COUNT(*) AS n FROM users' }),
        })
      ).json()
    )
    expect(results[0]?.kind).toBe('rows')
    const preview = await (
      await req('/api/databases/tsmyadmin_test/ddl/preview', {
        method: 'POST',
        body: JSON.stringify({ op: { op: 'dropTable', table: 'users' } }),
      })
    ).json()
    expect(z.object({ sql: z.array(z.string()) }).parse(preview).sql[0]).toMatch(/DROP TABLE/)
  })

  it('produces a SQL dump that restores over the existing objects (foreign keys after all tables)', async () => {
    const parent = `dump_parent_${dialect}`
    const child = `dump_child_${dialect}`
    const sql = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
    await sql(
      `CREATE TABLE ${parent} (id INT PRIMARY KEY);
       CREATE TABLE ${child} (id INT PRIMARY KEY, parent_id INT NULL, CONSTRAINT ${child}_fk FOREIGN KEY (parent_id) REFERENCES ${parent} (id));
       INSERT INTO ${parent} (id) VALUES (1); INSERT INTO ${child} (id, parent_id) VALUES (1, 1)`
    )
    try {
      // child sorts before parent: the dump must still restore (DROP ... CASCADE / FK checks off, FKs last).
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${child},${parent}&format=sql`)).text()
      expect(dump).toContain('dump complete')
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      const errors = restored.filter((r) => r.kind === 'error')
      expect(errors).toEqual([])
      const rows = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${child}/rows`)).json()
      )
      expect(rows.rows).toEqual([[1, 1]])
      const structure = TableSchemaSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${child}/structure`)).json()
      )
      expect(structure.foreignKeys.map((f) => f.refTable)).toEqual([parent])
    } finally {
      await sql(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`)
    }
  })

  it('takes a snapshot and puts it back: changed rows, a dropped table, and what was made since', async () => {
    const scratch = `it_snap_${dialect}_${Date.now().toString(36)}`
    const mysql = dialect === 'mysql'
    // MySQL: a database of its own. PostgreSQL: a schema of the test database.
    const db = mysql ? scratch : 'tsmyadmin_test'
    const schema = mysql ? '' : `?schema=${scratch}`
    const run = (path: string, text: string) =>
      req(`/api/databases/${path}/sql`, {
        method: 'POST',
        body: JSON.stringify({ sql: text, stopOnError: true, ...(mysql ? {} : { schema: scratch }) }),
      })
    const errorsOf = async (res: Response) =>
      z
        .array(StatementResultSchema)
        .parse(await res.json())
        .filter((r) => r.kind === 'error')
    const rows = async (table: string) =>
      BrowseResultSchema.parse(await (await req(`/api/databases/${db}/tables/${table}/rows${schema}`)).json()).rows
    await req('/api/databases/tsmyadmin_test/sql', {
      method: 'POST',
      body: JSON.stringify({ sql: mysql ? `CREATE DATABASE ${scratch}` : `CREATE SCHEMA ${scratch}` }),
    })
    try {
      expect(
        await errorsOf(
          await run(
            db,
            `CREATE TABLE a (id INT PRIMARY KEY, v VARCHAR(20));
             CREATE TABLE b (id INT PRIMARY KEY, a_id INT, CONSTRAINT b_fk FOREIGN KEY (a_id) REFERENCES a (id));
             INSERT INTO a VALUES (1, 'one'), (2, 'two'); INSERT INTO b VALUES (1, 1)`
          )
        )
      ).toEqual([])
      const taken = SnapshotListSchema.parse(
        await (
          await req(`/api/databases/${db}/snapshots${schema}`, {
            method: 'POST',
            body: JSON.stringify({ name: 'start' }),
          })
        ).json()
      )
      const id = taken.snapshots[0]?.id ?? ''
      expect(taken.snapshots[0]).toMatchObject({ name: 'start', objects: 2 })
      // Changes after it: a row edited, a child row and a table removed, a new table made.
      expect(
        await errorsOf(
          await run(
            db,
            `UPDATE a SET v = 'changed' WHERE id = 1; DROP TABLE b; DELETE FROM a WHERE id = 2; CREATE TABLE c (id INT)`
          )
        )
      ).toEqual([])
      const preview = SnapshotRestorePreviewSchema.parse(
        await (await req(`/api/databases/${db}/snapshots/${id}/restore/preview${schema}`)).json()
      )
      expect(preview.drops).toHaveLength(1)
      expect(preview.drops[0]).toContain('c')
      const restored = await req(`/api/databases/${db}/snapshots/${id}/restore${schema}`, { method: 'POST' })
      const result = SnapshotRestoreResultSchema.parse(await restored.json())
      expect(result.errors).toEqual([])
      expect(result.failed).toBe(0)
      expect(await rows('a')).toEqual([
        [1, 'one'],
        [2, 'two'],
      ])
      expect(await rows('b')).toEqual([[1, 1]])
      // What was made since is gone.
      expect((await req(`/api/databases/${db}/tables/c/rows${schema}`)).status).toBe(404)
    } finally {
      await req('/api/databases/tsmyadmin_test/sql', {
        method: 'POST',
        body: JSON.stringify({
          sql: mysql ? `DROP DATABASE IF EXISTS ${scratch}` : `DROP SCHEMA IF EXISTS ${scratch} CASCADE`,
        }),
      })
    }
  })

  it('restores dumps written with the SQL options: REPLACE, UPDATE, one row per statement, IF NOT EXISTS, a transaction, no comments', async () => {
    const t = `dump_opts_${dialect}`
    const sql = async (text: string, db = 'tsmyadmin_test') =>
      req(`/api/databases/${db}/sql`, { method: 'POST', body: JSON.stringify({ sql: text }) })
    const rows = async () =>
      BrowseResultSchema.parse(await (await req(`/api/databases/tsmyadmin_test/tables/${t}/rows`)).json()).rows
    const run = async (dump: string) => {
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
    }
    const dumpOf = async (params: string) =>
      (await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql&${params}`)).text()
    await sql(`DROP TABLE IF EXISTS ${t}`)
    await sql(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO ${t} VALUES (1, 'one'), (2, 'two'), (3, 'three')`
    )
    try {
      // Rows written one to a statement, as REPLACE / ON CONFLICT, over a table that is there already.
      const replace = await dumpOf('structure=0&data=1&statement=replace&extended=0&transaction=1&comments=0')
      expect(replace).not.toContain('-- Table:')
      expect(replace.match(/^(REPLACE|INSERT) INTO/gm)).toHaveLength(3)
      await sql(`UPDATE ${t} SET name = 'changed'; DELETE FROM ${t} WHERE id = 3`)
      await run(replace)
      expect(await rows()).toEqual([
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
      ])

      // UPDATE by primary key puts values back without touching which rows exist.
      const update = await dumpOf('structure=0&data=1&statement=update')
      expect(update).toContain('UPDATE')
      await sql(`UPDATE ${t} SET name = 'x'; INSERT INTO ${t} VALUES (4, 'four')`)
      await run(update)
      expect(await rows()).toEqual([
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
        [4, 'four'],
      ])

      // IF NOT EXISTS + IGNORE restore over what is there without an error or a duplicate.
      const gentle = await dumpOf('dropTable=0&ifNotExists=1&ignore=1')
      expect(gentle).toMatch(/CREATE TABLE IF NOT EXISTS/)
      await run(gentle)
      expect(await rows()).toHaveLength(4)

      // A range: the middle two rows of the table.
      const middle = await dumpOf('structure=0&rowOffset=1&rowLimit=2')
      expect(middle).toContain("'two'")
      expect(middle).toContain("'three'")
      expect(middle).not.toContain("'one'")
      expect(middle).not.toContain("'four'")
      // Without a key an UPDATE dump is refused before it starts.
      const keyless = `${t}_keyless`
      await sql(`DROP TABLE IF EXISTS ${keyless}; CREATE TABLE ${keyless} (a INT)`)
      const refused = await req(`/api/databases/tsmyadmin_test/export?tables=${keyless}&format=sql&statement=update`)
      await sql(`DROP TABLE IF EXISTS ${keyless}`)
      expect(refused.status).toBe(400)
    } finally {
      await sql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('writes a view as a table with its rows when asked, and packages a dump as gzip and as a zip', async () => {
    const t = `dump_vt_${dialect}`
    const v = `${t}_v`
    const sql = async (text: string, db = 'tsmyadmin_test') =>
      req(`/api/databases/${db}/sql`, { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP VIEW IF EXISTS ${v}; DROP TABLE IF EXISTS ${t}`)
    await sql(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20)); INSERT INTO ${t} VALUES (1, 'one'), (2, 'two'); CREATE VIEW ${v} AS SELECT id, name FROM ${t} WHERE id > 1`
    )
    try {
      const dump = await (
        await req(`/api/databases/tsmyadmin_test/export?tables=${v}&format=sql&viewsAsTables=1`)
      ).text()
      expect(dump).toContain(`CREATE TABLE`)
      expect(dump).not.toContain('CREATE VIEW')
      // Restored into another database the view's rows are a table's.
      const other = dialect === 'mysql' ? 'tsmyadmin_other' : 'tsmyadmin_test'
      const restore = dialect === 'mysql' ? dump : dump.replace(new RegExp(v, 'g'), `${v}_copy`)
      const restored = z.array(StatementResultSchema).parse(await (await sql(restore, other)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
      const name = dialect === 'mysql' ? v : `${v}_copy`
      const copied = BrowseResultSchema.parse(await (await req(`/api/databases/${other}/tables/${name}/rows`)).json())
      expect(copied.rows.map((r) => r.slice(0, 2))).toEqual([[2, 'two']])
      await sql(`DROP TABLE IF EXISTS ${name}`, other)

      const gz = await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql&compress=gzip`)
      expect(gz.headers.get('content-type')).toBe('application/gzip')
      expect(new Uint8Array(await gz.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]))
      const zip = await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=csv&filePerTable=1`)
      expect(zip.headers.get('content-type')).toBe('application/zip')
    } finally {
      await sql(`DROP VIEW IF EXISTS ${v}; DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('leaves generated columns out of the INSERTs it writes', async () => {
    // The server computes them; listing one in an INSERT makes the whole dump unrestorable.
    const t = `dump_gen_${dialect}`
    const sql = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await sql(`DROP TABLE IF EXISTS ${t}`)
    const generated =
      dialect === 'mysql'
        ? `CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, twice INT AS (a * 2) STORED)`
        : `CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, twice INT GENERATED ALWAYS AS (a * 2) STORED)`
    await sql(`${generated}; INSERT INTO ${t} (id, a) VALUES (1, 21)`)
    try {
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql`)).text()
      // The column belongs in the CREATE but never in an INSERT's column list.
      expect(dump).toContain('twice')
      for (const line of dump.split('\n'))
        if (/^INSERT INTO/i.test(line.trim())) expect(line.slice(0, line.indexOf('VALUES'))).not.toContain('twice')
      const restored = z.array(StatementResultSchema).parse(await (await sql(dump)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
      const rows = BrowseResultSchema.parse(await (await req(`/api/databases/tsmyadmin_test/tables/${t}/rows`)).json())
      expect(rows.rows).toEqual([[1, 21, 42]])
    } finally {
      await sql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('dumps routines, triggers and events that restore over the existing ones', async () => {
    // Runs in tsmyadmin_other: a whole-database dump of tsmyadmin_test would race the adapter conformance
    // suite, whose scratch tables appear and vanish there while this test runs.
    const other = (text: string) =>
      req('/api/databases/tsmyadmin_other/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    const setup =
      dialect === 'mysql'
        ? [
            'DROP TABLE IF EXISTS prog_t',
            'CREATE TABLE prog_t (id INT PRIMARY KEY, title VARCHAR(50) NULL)',
            'DROP FUNCTION IF EXISTS prog_label',
            "CREATE FUNCTION prog_label(uid INT) RETURNS VARCHAR(20) DETERMINISTIC RETURN CONCAT('#', uid)",
            'DROP TRIGGER IF EXISTS prog_before_insert',
            // Escapes in the bodies: information_schema hands them back processed, SHOW CREATE as written.
            "CREATE TRIGGER prog_before_insert BEFORE INSERT ON prog_t FOR EACH ROW SET NEW.title = COALESCE(NEW.title, 'un\\'titled\\\\')",
            'DROP EVENT IF EXISTS prog_event',
            "CREATE EVENT prog_event ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM prog_t WHERE title = 'x\\'y'",
            // A body that mentions DEFINER inside a string must survive DEFINER stripping untouched.
            'DROP PROCEDURE IF EXISTS prog_p',
            "DELIMITER $$\nCREATE PROCEDURE prog_p() BEGIN SELECT 'DEFINER=root@localhost' AS s; END$$\nDELIMITER ;",
            'DROP VIEW IF EXISTS prog_v',
            'CREATE VIEW prog_v AS SELECT prog_label(id) AS label FROM prog_t',
          ]
        : [
            'DROP TABLE IF EXISTS prog_t CASCADE',
            'DROP TABLE IF EXISTS prog_part',
            'DROP TABLE IF EXISTS prog_sc',
            'DROP TABLE IF EXISTS prog_sp',
            'DROP TABLE IF EXISTS prog_d CASCADE',
            'DROP VIEW IF EXISTS prog_v3',
            'DROP FUNCTION IF EXISTS prog_one()',
            'DROP FUNCTION IF EXISTS prog_count()',
            'DROP FUNCTION IF EXISTS prog_label(bigint)',
            'DROP FUNCTION IF EXISTS prog_rows()',
            'CREATE TABLE prog_t (id INT PRIMARY KEY, title VARCHAR(50) NULL)',
            "CREATE OR REPLACE FUNCTION prog_label(uid INT) RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT '#' || uid $$",
            "CREATE OR REPLACE FUNCTION prog_default_title() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.title := COALESCE(NEW.title, 'untitled'); RETURN NEW; END $$",
            'CREATE TRIGGER prog_before_insert BEFORE INSERT ON prog_t FOR EACH ROW EXECUTE FUNCTION prog_default_title()',
            // An overload: both definitions must be dumped as separate statements, once.
            "CREATE OR REPLACE FUNCTION prog_label(uid TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT '#' || uid $$",
            'DROP VIEW IF EXISTS prog_v2',
            'DROP VIEW IF EXISTS prog_v',
            'CREATE VIEW prog_v AS SELECT prog_label(id) AS label, id FROM prog_t',
            // prog_v2 sorts after prog_v by name but its definition ends with the dependency name: ordering is
            // by mention, not by luck; WITH CHECK OPTION must survive the round trip.
            'CREATE VIEW prog_v2 AS SELECT id FROM prog_v WITH CHECK OPTION',
            // A SQL-standard body reads a view: it can only be created after the views.
            'CREATE FUNCTION prog_count() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM prog_v2; END',
            // A third overload with a SQL-standard body: classified on its own, not with its string-body siblings.
            'CREATE FUNCTION prog_label(uid BIGINT) RETURNS TEXT LANGUAGE sql RETURN (SELECT max(label) FROM prog_v)',
            // A string-body function whose signature uses the table's row type: created after the table.
            'CREATE FUNCTION prog_rows() RETURNS SETOF prog_t LANGUAGE sql AS $$ SELECT * FROM prog_t $$',
            // A view reading a SQL-standard-body function: that function must precede this view.
            'CREATE FUNCTION prog_one() RETURNS INT LANGUAGE sql BEGIN ATOMIC SELECT 1; END',
            'CREATE VIEW prog_v3 AS SELECT prog_one() AS one',
            // A table whose default calls a string-body routine, and a functional index: routines go first.
            'CREATE TABLE prog_d (id INT PRIMARY KEY, label TEXT DEFAULT prog_label(0), CHECK (id > 0))',
            'CREATE INDEX prog_d_idx ON prog_d (prog_label(id))',
            // A trigger switched off must come back switched off.
            'CREATE TRIGGER prog_off BEFORE INSERT ON prog_d FOR EACH ROW EXECUTE FUNCTION prog_default_title()',
            'ALTER TABLE prog_d DISABLE TRIGGER prog_off',
            "COMMENT ON FUNCTION prog_one() IS 'always one'",
            // A partitioned table: partitions are recreated with the parent and rows come back through it.
            'CREATE TABLE prog_part (id INT, d DATE) PARTITION BY RANGE (d)',
            "CREATE TABLE prog_part_2024 PARTITION OF prog_part FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
            'CREATE TABLE prog_part_rest PARTITION OF prog_part DEFAULT',
            "INSERT INTO prog_part VALUES (1, '2024-06-01'), (2, '2030-01-01')",
            'CREATE INDEX prog_part_d_idx ON prog_part (d)',
            'CREATE TRIGGER prog_always BEFORE INSERT ON prog_d FOR EACH ROW EXECUTE FUNCTION prog_default_title()',
            'ALTER TABLE prog_d ENABLE ALWAYS TRIGGER prog_always',
            // A serial parent with an inheritance child: the child keeps the inherited nextval() default and the
            // shared sequence is advanced past the child's ids.
            'CREATE TABLE prog_sp (id SERIAL PRIMARY KEY, a INT)',
            'CREATE TABLE prog_sc (x TEXT) INHERITS (prog_sp)',
            "INSERT INTO prog_sc (a, x) VALUES (1, 'c'), (2, 'd')",
          ]
    for (const statement of setup) {
      const r = z.array(StatementResultSchema).parse(await (await other(statement)).json())
      expect(r.filter((x) => x.kind === 'error').map((x) => (x.kind === 'error' ? x.message : ''))).toEqual([])
    }
    try {
      const dump = await (
        await req('/api/databases/tsmyadmin_other/export?format=sql&routines=1&stripDefiner=1')
      ).text()
      expect(dump).toContain('-- Routines')
      expect(dump).toContain('-- Triggers')
      expect(dump).toContain('prog_label')
      expect(dump).toContain('prog_before_insert')
      if (dialect === 'mysql') {
        expect(dump).toContain('-- Events')
        expect(dump).toContain('prog_event')
        expect(dump).toContain('DELIMITER ;;')
        // Header DEFINER clauses are gone; the string inside prog_p's body is not a header and stays.
        expect(dump).not.toMatch(/^CREATE\s+(?:ALGORITHM\S*\s+)?DEFINER\s*=/m)
      }
      // The view depends on the function: it must be dumped after the routines section.
      expect(dump.indexOf('-- Routines')).toBeLessThan(dump.indexOf('-- View: prog_v'))
      if (dialect === 'postgres') {
        expect(dump.match(/CREATE OR REPLACE FUNCTION [^\n]*prog_label/g)).toHaveLength(3)
        expect(dump.indexOf('-- View: prog_v\n')).toBeLessThan(dump.indexOf('-- Routine: prog_count'))
        expect(dump.indexOf('-- Routine: prog_one')).toBeLessThan(dump.indexOf('-- View: prog_v3'))
        expect(dump.indexOf('-- Routines')).toBeLessThan(dump.indexOf('-- Table: prog_d'))
        expect(dump.indexOf('-- Table: prog_t\n')).toBeLessThan(dump.indexOf('-- Routine: prog_rows'))
        expect(dump).toContain(`COMMENT ON FUNCTION "public"."prog_one"() IS 'always one'`)
        expect(dump).toContain('DISABLE TRIGGER "prog_off"')
      } else expect(dump).toContain("SELECT 'DEFINER=root@localhost' AS s")
      // Drop the programs and the view, then replay the dump: everything must come back and the trigger fire.
      await other(
        dialect === 'mysql'
          ? 'DROP VIEW prog_v; DROP TRIGGER prog_before_insert; DROP FUNCTION prog_label; DROP PROCEDURE prog_p; DROP EVENT prog_event'
          : 'DROP TABLE prog_sc; DROP TABLE prog_sp; DROP FUNCTION prog_rows(); DROP TABLE prog_part; DROP TABLE prog_d; DROP VIEW prog_v3; DROP FUNCTION prog_one(); DROP FUNCTION prog_label(bigint); DROP FUNCTION prog_count(); DROP VIEW prog_v2; DROP VIEW prog_v; DROP TRIGGER prog_before_insert ON prog_t; DROP FUNCTION prog_label(int); DROP FUNCTION prog_label(text)'
      )
      const restored = z.array(StatementResultSchema).parse(await (await other(dump)).json())
      expect(
        restored.filter((r) => r.kind === 'error').map((r) => (r.kind === 'error' ? `${r.message} @ ${r.sql}` : ''))
      ).toEqual([])
      const routines = (await (await req('/api/databases/tsmyadmin_other/routines')).json()) as { name: string }[]
      expect(routines.filter((r) => r.name === 'prog_label')).toHaveLength(dialect === 'postgres' ? 3 : 1)
      const tables = (await (await req('/api/databases/tsmyadmin_other/tables')).json()) as {
        name: string
        kind: string
      }[]
      expect(tables.find((t) => t.name === 'prog_v')?.kind).toBe('view')
      if (dialect === 'postgres') {
        expect(tables.find((t) => t.name === 'prog_v2')?.kind).toBe('view')
        expect(routines.map((r) => r.name)).toContain('prog_count')
        const create = (await (await req('/api/databases/tsmyadmin_other/tables/prog_v2/create')).json()) as {
          sql: string[]
        }
        expect(create.sql.join('\n')).toContain('WITH CASCADED CHECK OPTION')
        expect(tables.find((t) => t.name === 'prog_v3')?.kind).toBe('view')
        const d = (await (await req('/api/databases/tsmyadmin_other/tables/prog_d/create')).json()) as { sql: string[] }
        expect(d.sql.join('\n')).toMatch(/CHECK \(+id > 0\)+/)
        const trg = (await (await req('/api/databases/tsmyadmin_other/triggers')).json()) as {
          name: string
          fireMode: string
        }[]
        expect(trg).toContainEqual(expect.objectContaining({ name: 'prog_off', fireMode: 'disabled' }))
        expect(trg).toContainEqual(expect.objectContaining({ name: 'prog_always', fireMode: 'always' }))
        const partRows = BrowseResultSchema.parse(
          await (await req('/api/databases/tsmyadmin_other/tables/prog_part/rows')).json()
        )
        expect(partRows.rows.map((r) => r[0])).toEqual([1, 2])
        // The parent's index came back valid and reached the partitions.
        const idx = z
          .array(StatementResultSchema)
          .parse(
            await (
              await other(
                "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname LIKE 'prog_part%_d_idx' AND i.indisvalid"
              )
            ).json()
          )
        expect(idx[0]?.kind === 'rows' ? Number(idx[0].result.rows[0]?.[0]) : -1).toBe(3)
        const next = z
          .array(StatementResultSchema)
          .parse(await (await other("INSERT INTO prog_sc (a, x) VALUES (3, 'after') RETURNING id")).json())
        expect(next[0]?.kind === 'rows' ? Number(next[0].result.rows[0]?.[0]) : -1).toBe(3)
        expect(tables.map((t) => t.name)).not.toContain('prog_part_2024')
      }
      const triggers = (await (await req('/api/databases/tsmyadmin_other/triggers')).json()) as { name: string }[]
      expect(triggers.map((t) => t.name)).toContain('prog_before_insert')
      if (dialect === 'mysql') {
        // With DEFINER kept, the trigger and event headers name the account and restore over themselves.
        const kept = await (await req('/api/databases/tsmyadmin_other/export?format=sql&routines=1')).text()
        // SHOW CREATE prints the statement as written (MariaDB keeps the unquoted name).
        expect(kept).toMatch(/^CREATE DEFINER=`\w+`@`[^`]+` TRIGGER `?prog_before_insert`?/m)
        expect(kept).toMatch(/^CREATE DEFINER=`\w+`@`[^`]+` EVENT `?prog_event`?/m)
        const again = z.array(StatementResultSchema).parse(await (await other(kept)).json())
        expect(again.filter((r) => r.kind === 'error').map((r) => (r.kind === 'error' ? r.message : ''))).toEqual([])
      }
      await other('INSERT INTO prog_t (id) VALUES (1)')
      const rows = BrowseResultSchema.parse(
        await (await req('/api/databases/tsmyadmin_other/tables/prog_t/rows')).json()
      )
      expect(rows.rows).toEqual([[1, dialect === 'mysql' ? "un'titled\\" : 'untitled']])
    } finally {
      await other(
        dialect === 'mysql'
          ? 'DROP VIEW IF EXISTS prog_v; DROP EVENT IF EXISTS prog_event; DROP TRIGGER IF EXISTS prog_before_insert; DROP FUNCTION IF EXISTS prog_label; DROP PROCEDURE IF EXISTS prog_p; DROP TABLE IF EXISTS prog_t'
          : 'DROP TABLE IF EXISTS prog_sc; DROP TABLE IF EXISTS prog_sp; DROP FUNCTION IF EXISTS prog_rows(); DROP TABLE IF EXISTS prog_part; DROP TABLE IF EXISTS prog_d; DROP VIEW IF EXISTS prog_v3; DROP FUNCTION IF EXISTS prog_one(); DROP FUNCTION IF EXISTS prog_label(bigint); DROP FUNCTION IF EXISTS prog_count(); DROP VIEW IF EXISTS prog_v2; DROP VIEW IF EXISTS prog_v; DROP TABLE IF EXISTS prog_t CASCADE; DROP FUNCTION IF EXISTS prog_label(int); DROP FUNCTION IF EXISTS prog_label(text); DROP FUNCTION IF EXISTS prog_default_title'
      )
    }
  })

  it('restores a MySQL dump into another database without touching the source', async () => {
    if (dialect !== 'mysql') return
    const t = 'dump_move_mysql'
    const src = async (text: string) =>
      req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    const dst = async (text: string) =>
      req('/api/databases/tsmyadmin_other/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await src(`DROP TABLE IF EXISTS ${t}`)
    await dst(`DROP TABLE IF EXISTS ${t}`)
    await src(`CREATE TABLE ${t} (id INT PRIMARY KEY, v VARCHAR(10)); INSERT INTO ${t} VALUES (1, 'prod')`)
    try {
      const dump = await (await req(`/api/databases/tsmyadmin_test/export?tables=${t}&format=sql`)).text()
      // Unqualified statements: the dump names no database, so it restores wherever it is imported.
      expect(dump).not.toContain('`tsmyadmin_test`.')
      const restored = z.array(StatementResultSchema).parse(await (await dst(dump)).json())
      expect(restored.filter((r) => r.kind === 'error')).toEqual([])
      const moved = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_other/tables/${t}/rows`)).json()
      )
      expect(moved.rows).toEqual([[1, 'prod']])
      const source = BrowseResultSchema.parse(
        await (await req(`/api/databases/tsmyadmin_test/tables/${t}/rows`)).json()
      )
      expect(source.rows).toEqual([[1, 'prod']])
    } finally {
      await src(`DROP TABLE IF EXISTS ${t}`)
      await dst(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  const upload = async (db: string, fields: Record<string, string>, body: string | Uint8Array) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([body], 'f.sql'))
    const res = await app.request(`/api/databases/${db}/import`, {
      method: 'POST',
      body: fd,
      headers: { cookie, origin: 'http://localhost' },
    })
    const text = await res.text()
    // Pre-run refusals (size, encoding, validation of the form) are plain JSON, not an event stream.
    const events = res.ok
      ? text
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => ImportEventSchema.parse(JSON.parse(l)))
      : [{ type: 'fatal' as const, error: ApiErrorSchema.parse(JSON.parse(text)) }]
    return { status: res.status, events, last: events.at(-1) }
  }

  /** Like `upload`, to any import endpoint and with a file of any name. */
  const uploadTo = async (path: string, fields: Record<string, string>, body: string | Uint8Array, name = 'f.csv') => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([body], name))
    const res = await app.request(path, { method: 'POST', body: fd, headers: { cookie, origin: 'http://localhost' } })
    const text = await res.text()
    const events = res.ok
      ? text
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => ImportEventSchema.parse(JSON.parse(l)))
      : [{ type: 'fatal' as const, error: ApiErrorSchema.parse(JSON.parse(text)) }]
    return { status: res.status, events, last: events.at(-1) }
  }
  const IMPORT = '/api/databases/tsmyadmin_test/import'
  const runSql = (sql: string) =>
    req('/api/databases/tsmyadmin_test/sql', { method: 'POST', body: JSON.stringify({ sql }) })
  const firstColumns = async (table: string, n = 2) =>
    BrowseResultSchema.parse(await (await req(`/api/databases/tsmyadmin_test/tables/${table}/rows`)).json()).rows.map(
      (r) => r.slice(0, n)
    )

  it('loads a CSV with its own enclosure, escape and skip, and on a duplicate key ignores or replaces', async () => {
    const t = `imp_opts_${dialect}`
    await runSql(`DROP TABLE IF EXISTS ${t}`)
    await runSql(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(30))`)
    try {
      const csv = "id;name\n1;'a;b'\n2;'it\\'s'\n3;'three'\n"
      const first = await uploadTo(
        IMPORT,
        { format: 'csv', table: t, delimiter: ';', enclosure: "'", escape: '\\', skip: '1' },
        csv
      )
      expect(first.last).toMatchObject({ type: 'result', result: { format: 'csv', inserted: 2, skipped: 1 } })
      expect(await firstColumns(t)).toEqual([
        [2, "it's"],
        [3, 'three'],
      ])
      const again = 'id,name\n2,changed\n4,four\n'
      expect((await uploadTo(IMPORT, { format: 'csv', table: t }, again)).last).toMatchObject({ type: 'fatal' })
      await uploadTo(IMPORT, { format: 'csv', table: t, onDuplicate: 'ignore' }, again)
      expect(await firstColumns(t)).toEqual([
        [2, "it's"],
        [3, 'three'],
        [4, 'four'],
      ])
      await uploadTo(IMPORT, { format: 'csv', table: t, onDuplicate: 'replace' }, again)
      expect(await firstColumns(t)).toEqual([
        [2, 'changed'],
        [3, 'three'],
        [4, 'four'],
      ])
    } finally {
      await runSql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('says what "leave out duplicates" let pass besides the duplicates (MySQL)', async () => {
    if (dialect !== 'mysql') return
    const t = 'imp_warn_mysql'
    await runSql(`DROP TABLE IF EXISTS ${t}`)
    await runSql(`CREATE TABLE ${t} (id INT PRIMARY KEY, s VARCHAR(3))`)
    try {
      const done = await uploadTo(IMPORT, { format: 'csv', table: t, onDuplicate: 'ignore' }, 'id,s\n1,ok\n2,toolong\n')
      expect(done.last).toMatchObject({ type: 'result', result: { format: 'csv', inserted: 2 } })
      const warnings = (done.last as { result: { warnings: string[] } }).result.warnings
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/truncated/i)
    } finally {
      await runSql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('creates the table from a CSV, and from a spreadsheet the export wrote', async () => {
    const t = `imp_new_${dialect}`
    const src = `imp_src_${dialect}`
    const copy = `imp_copy_${dialect}`
    for (const name of [t, src, copy]) await runSql(`DROP TABLE IF EXISTS ${name}`)
    try {
      const csv = 'n,price,day,label\n1,1.50,2026-01-02,x\n22,20.25,2026-02-03,\\N\n'
      const made = await uploadTo(IMPORT, { format: 'csv', table: t, createTable: '1' }, csv)
      expect(made.last).toMatchObject({ type: 'result', result: { format: 'csv', inserted: 2 } })
      const created = (made.last as { result: { created: { dataType: string }[] } }).result.created
      expect(created.map((c) => c.dataType.toUpperCase().replace(/\(.*/, ''))).toEqual([
        'INT',
        'DECIMAL',
        'DATE',
        'VARCHAR',
      ])
      // The table exists now: a second create is refused.
      expect((await uploadTo(IMPORT, { format: 'csv', table: t, createTable: '1' }, csv)).last).toMatchObject({
        type: 'fatal',
      })

      await runSql(`CREATE TABLE ${src} (id INT PRIMARY KEY, name VARCHAR(20))`)
      await runSql(`INSERT INTO ${src} VALUES (1, 'one'), (2, NULL)`)
      const ods = new Uint8Array(
        await (await req(`/api/databases/tsmyadmin_test/export?tables=${src}&format=ods`)).arrayBuffer()
      )
      const loaded = await uploadTo(IMPORT, { format: 'ods', table: copy, createTable: '1' }, ods, 'x.ods')
      expect(loaded.last).toMatchObject({ type: 'result', result: { format: 'ods', inserted: 2 } })
      expect(await firstColumns(copy)).toEqual([
        [1, 'one'],
        [2, null],
      ])
    } finally {
      for (const name of [t, src, copy]) await runSql(`DROP TABLE IF EXISTS ${name}`)
    }
  })

  it('opens gzip and zip uploads, reads a Shift_JIS file, and starts a SQL script partway', async () => {
    const t = `imp_pack_${dialect}`
    await runSql(`DROP TABLE IF EXISTS ${t}`)
    await runSql(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(30))`)
    try {
      const { gzipSync } = await import('node:zlib')
      const iconv = (await import('iconv-lite')).default
      const { zipStream } = await import('./lib/zip.ts')
      const sql = `INSERT INTO ${t} VALUES (1, 'a');\nINSERT INTO ${t} VALUES (2, 'b');\nINSERT INTO ${t} VALUES (3, 'c');\n`
      const gz = await uploadTo(IMPORT, { format: 'sql', skip: '1' }, new Uint8Array(gzipSync(sql)), 'd.sql.gz')
      expect(gz.last).toMatchObject({ type: 'result', result: { format: 'sql', succeeded: 2 } })
      expect(await firstColumns(t)).toEqual([
        [2, 'b'],
        [3, 'c'],
      ])
      await runSql(`DELETE FROM ${t}`)
      const zipped = new Uint8Array(
        Buffer.concat(await Array.fromAsync(zipStream([{ name: 'd.sql', data: sql }], new Date())))
      )
      expect((await uploadTo(IMPORT, { format: 'sql' }, zipped, 'd.zip')).last).toMatchObject({
        result: { succeeded: 3 },
      })
      await runSql(`DELETE FROM ${t}`)
      const sjis = new Uint8Array(iconv.encode(`INSERT INTO ${t} VALUES (1, '日本語');`, 'cp932'))
      expect((await uploadTo(IMPORT, { format: 'sql', charset: 'cp932' }, sjis, 's.sql')).last).toMatchObject({
        result: { succeeded: 1 },
      })
      expect(await firstColumns(t)).toEqual([[1, '日本語']])
      // The same bytes read as UTF-8 are refused up front.
      expect((await uploadTo(IMPORT, { format: 'sql' }, sjis, 's.sql')).status).toBe(400)
    } finally {
      await runSql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('keeps a zero in an AUTO_INCREMENT column when asked (MySQL)', async () => {
    if (dialect !== 'mysql') return
    const t = 'imp_zero_mysql'
    await runSql(`DROP TABLE IF EXISTS ${t}`)
    await runSql(`CREATE TABLE ${t} (id INT AUTO_INCREMENT PRIMARY KEY, v INT)`)
    try {
      const script = `INSERT INTO ${t} (id, v) VALUES (0, 7);`
      await uploadTo(IMPORT, { format: 'sql', noAutoValueOnZero: '1' }, script, 'z.sql')
      expect((await firstColumns(t, 1)).flat()).toEqual([0])
      await runSql(`DELETE FROM ${t}`)
      await uploadTo(IMPORT, { format: 'sql' }, script, 'z.sql')
      expect((await firstColumns(t, 1)).flat()).not.toEqual([0])
    } finally {
      await runSql(`DROP TABLE IF EXISTS ${t}`)
    }
  })

  it('dumps several databases (MySQL) or schemas (PostgreSQL) together and restores them at the server level', async () => {
    const mysql = dialect === 'mysql'
    const a = `it_srv_a_${dialect}`
    const b = `it_srv_b_${dialect}`
    const kind = mysql ? 'DATABASE' : 'SCHEMA'
    const cleanup = async () => {
      for (const name of [a, b])
        await runSql(mysql ? `DROP DATABASE IF EXISTS ${name}` : `DROP SCHEMA IF EXISTS ${name} CASCADE`)
    }
    await cleanup()
    await runSql(`CREATE ${kind} ${a}`)
    await runSql(`CREATE ${kind} ${b}`)
    try {
      await runSql(`CREATE TABLE ${a}.t (id INT PRIMARY KEY)`)
      await runSql(`INSERT INTO ${a}.t VALUES (1), (2)`)
      await runSql(`CREATE TABLE ${b}.u (name VARCHAR(10))`)
      await runSql(`INSERT INTO ${b}.u VALUES ('x')`)
      const res = await req(`/api/server/export?targets=${a},${b}`)
      expect(res.status).toBe(200)
      const dump = await res.text()
      expect(dump).toContain(mysql ? `CREATE DATABASE IF NOT EXISTS \`${a}\`` : `CREATE SCHEMA IF NOT EXISTS "${a}"`)
      expect(dump).toContain(`INSERT INTO`)
      expect((await req('/api/server/export?targets=nope_missing')).status).toBe(404)
      await cleanup()
      const restored = await uploadTo('/api/server/import', { format: 'sql' }, dump, 'all.sql')
      expect(restored.last).toMatchObject({ type: 'result', result: { format: 'sql', failed: 0 } })
      const rows = await runSql(`SELECT id FROM ${a}.t ORDER BY id`)
      expect(JSON.stringify(await rows.json())).toContain('"rows":[[1],[2]]')
      const zip = await req(`/api/server/export?targets=${a},${b}&filePerTable=1`)
      expect(zip.headers.get('content-type')).toBe('application/zip')
      expect(new Uint8Array(await zip.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
    } finally {
      await cleanup()
    }
  })

  it('imports a pg_dump plain-format file: \\restrict header and COPY … FROM stdin data', async () => {
    if (dialect !== 'postgres') return
    const other = (text: string) =>
      req('/api/databases/tsmyadmin_other/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    await other('DROP TABLE IF EXISTS imp_copy; DROP TABLE IF EXISTS imp_empty; DROP TABLE IF EXISTS imp_blank')
    try {
      // What pg_dump ≥ 17.6 writes: the psql fence, a comment block above every statement, COPY blocks with
      // tab-separated, backslash-escaped data — including an empty table and a table holding one empty string.
      const dump = [
        '--',
        '-- PostgreSQL database dump',
        '--',
        '\\restrict abc123',
        'SET statement_timeout = 0;',
        '',
        '--',
        '-- Name: imp_copy; Type: TABLE; Schema: public; Owner: tsmyadmin',
        '--',
        '',
        'CREATE TABLE public.imp_copy (id integer NOT NULL, note text, PRIMARY KEY (id));',
        'CREATE TABLE public.imp_empty (id integer);',
        'CREATE TABLE public.imp_blank (note text);',
        '',
        '--',
        '-- Data for Name: imp_copy; Type: TABLE DATA; Schema: public; Owner: tsmyadmin',
        '--',
        '',
        'COPY public.imp_copy (id, note) FROM stdin;',
        "1\tit's\\ta",
        '2\t\\N',
        '3\tline\\nbreak',
        '\\.',
        '',
        'COPY public.imp_empty (id) FROM stdin;',
        '\\.',
        '',
        'COPY public.imp_blank (note) FROM stdin;',
        '',
        '\\.',
        '',
        '--',
        '-- Name: imp_copy_seq; Type: SEQUENCE SET',
        '--',
        '',
        "SELECT pg_catalog.setval('public.imp_copy_seq', 3, true);",
        '\\unrestrict abc123',
        '',
      ].join('\n')
      const r = await upload('tsmyadmin_other', { format: 'sql', stopOnError: '0' }, dump)
      expect(r.status).toBe(200)
      expect(r.last?.type).toBe('result')
      if (r.last?.type !== 'result' || r.last.result.format !== 'sql') throw new Error('no result')
      // The setval fails (no such sequence): everything else, COPY included, went through. Its line is the
      // statement's own, not the comment block above it.
      expect(r.last.result).toMatchObject({ total: 8, statements: 8, succeeded: 7, failed: 1 })
      expect(r.last.result.errors[0]).toMatchObject({ line: 36, index: 7 })
      const rowsOf = async (table: string) =>
        BrowseResultSchema.parse(await (await req(`/api/databases/tsmyadmin_other/tables/${table}/rows`)).json()).rows
      expect(await rowsOf('imp_copy')).toEqual([
        [1, "it's\ta"],
        [2, null],
        [3, 'line\nbreak'],
      ])
      expect(await rowsOf('imp_empty')).toEqual([])
      // One empty-string row (a key-less table also carries its ctid).
      expect((await rowsOf('imp_blank')).map((r) => r[0])).toEqual([''])
    } finally {
      await other('DROP TABLE IF EXISTS imp_copy; DROP TABLE IF EXISTS imp_empty; DROP TABLE IF EXISTS imp_blank')
    }
  })

  it('imports a CSV with identity / generated columns and names the failing line', async () => {
    const other = (text: string) =>
      req('/api/databases/tsmyadmin_other/sql', { method: 'POST', body: JSON.stringify({ sql: text }) })
    const create =
      dialect === 'mysql'
        ? 'CREATE TABLE imp_csv (id INT AUTO_INCREMENT PRIMARY KEY, n INT NOT NULL, dbl INT AS (n * 2) STORED)'
        : 'CREATE TABLE imp_csv (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n INT NOT NULL, dbl INT GENERATED ALWAYS AS (n * 2) STORED)'
    await other('DROP TABLE IF EXISTS imp_csv')
    await other(create)
    try {
      // A CSV export lists every column: the generated one is skipped, explicit ids are accepted.
      const ok = await upload('tsmyadmin_other', { format: 'csv', table: 'imp_csv' }, 'id,n,dbl\n5,1,2\n6,2,4\n')
      expect(ok.last).toMatchObject({ type: 'result', result: { format: 'csv', inserted: 2, skippedColumns: ['dbl'] } })
      const rows = BrowseResultSchema.parse(
        await (await req('/api/databases/tsmyadmin_other/tables/imp_csv/rows')).json()
      )
      expect(rows.rows).toEqual([
        [5, 1, 2],
        [6, 2, 4],
      ])
      // A bad value on line 4: nothing of the file is kept and the message names the line (or its batch).
      const bad = await upload('tsmyadmin_other', { format: 'csv', table: 'imp_csv' }, 'n\n7\n8\nx\n')
      expect(bad.last?.type).toBe('fatal')
      if (bad.last?.type !== 'fatal') throw new Error('expected fatal')
      expect(bad.last.error.code).toBe('VALIDATION')
      expect(['CSV_ROW_FAILED', 'CSV_ROWS_FAILED']).toContain(bad.last.error.reason)
      if (bad.last.error.reason === 'CSV_ROW_FAILED') expect(bad.last.error.params).toMatchObject({ line: 4 })
      const after = BrowseResultSchema.parse(
        await (await req('/api/databases/tsmyadmin_other/tables/imp_csv/rows')).json()
      )
      expect(after.rows).toHaveLength(2)
    } finally {
      await other('DROP TABLE IF EXISTS imp_csv')
    }
  })

  it('reports whether a failed account operation was rolled back', async () => {
    // Granting to an account that does not exist fails on both servers. PostgreSQL runs a multi-statement
    // operation in one transaction, so the response reports the rollback; MySQL commits each statement as it runs.
    const user = dialect === 'mysql' ? { name: 'r_optx_missing', host: '%' } : { name: 'r_optx_missing' }
    const res = await req('/api/users/execute', {
      method: 'POST',
      body: JSON.stringify({ op: { op: 'grantAll', user, database: 'tsmyadmin_test' } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { kind: string }[]; rolledBack: boolean }
    expect(body.results.some((r) => r.kind === 'error')).toBe(true)
    expect(body.rolledBack).toBe(dialect === 'postgres')
  })

  it('logs out', async () => {
    expect((await req('/api/session', { method: 'DELETE' })).status).toBe(200)
  })
})
