/** API against the real compose databases (bun run test:integration). */
import { createAdapter } from '@tsmyadmin/adapter'
import { BrowseResultSchema, SessionStateSchema, StatementResultSchema, TableSchemaSchema } from '@tsmyadmin/shared'
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

  it('rejects wrong passwords', async () => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...login, password: 'nope' }),
    })
    expect(res.status).toBe(401)
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
            "CREATE TRIGGER prog_before_insert BEFORE INSERT ON prog_t FOR EACH ROW SET NEW.title = COALESCE(NEW.title, 'untitled')",
            'DROP EVENT IF EXISTS prog_event',
            'CREATE EVENT prog_event ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM prog_t WHERE id < 0',
            // A body that mentions DEFINER inside a string must survive DEFINER stripping untouched.
            'DROP PROCEDURE IF EXISTS prog_p',
            "DELIMITER $$\nCREATE PROCEDURE prog_p() BEGIN SELECT 'DEFINER=root@localhost' AS s; END$$\nDELIMITER ;",
            'DROP VIEW IF EXISTS prog_v',
            'CREATE VIEW prog_v AS SELECT prog_label(id) AS label FROM prog_t',
          ]
        : [
            'DROP TABLE IF EXISTS prog_t CASCADE',
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
        expect(dump.indexOf('-- View: prog_v')).toBeLessThan(dump.indexOf('-- Routines (SQL-standard bodies)'))
      } else expect(dump).toContain("SELECT 'DEFINER=root@localhost' AS s")
      // Drop the programs and the view, then replay the dump: everything must come back and the trigger fire.
      await other(
        dialect === 'mysql'
          ? 'DROP VIEW prog_v; DROP TRIGGER prog_before_insert; DROP FUNCTION prog_label; DROP PROCEDURE prog_p; DROP EVENT prog_event'
          : 'DROP FUNCTION prog_label(bigint); DROP FUNCTION prog_count(); DROP VIEW prog_v2; DROP VIEW prog_v; DROP TRIGGER prog_before_insert ON prog_t; DROP FUNCTION prog_label(int); DROP FUNCTION prog_label(text)'
      )
      const restored = z.array(StatementResultSchema).parse(await (await other(dump)).json())
      expect(restored.filter((r) => r.kind === 'error').map((r) => (r.kind === 'error' ? r.message : ''))).toEqual([])
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
      }
      const triggers = (await (await req('/api/databases/tsmyadmin_other/triggers')).json()) as { name: string }[]
      expect(triggers.map((t) => t.name)).toContain('prog_before_insert')
      if (dialect === 'mysql') {
        // With DEFINER kept, the trigger and event headers name the account and restore over themselves.
        const kept = await (await req('/api/databases/tsmyadmin_other/export?format=sql&routines=1')).text()
        expect(kept).toMatch(/^CREATE DEFINER=`\w+`@`[^`]+` TRIGGER `prog_before_insert`/m)
        expect(kept).toMatch(/^CREATE DEFINER=`\w+`@`[^`]+` EVENT `prog_event`/m)
        const again = z.array(StatementResultSchema).parse(await (await other(kept)).json())
        expect(again.filter((r) => r.kind === 'error').map((r) => (r.kind === 'error' ? r.message : ''))).toEqual([])
      }
      await other('INSERT INTO prog_t (id) VALUES (1)')
      const rows = BrowseResultSchema.parse(
        await (await req('/api/databases/tsmyadmin_other/tables/prog_t/rows')).json()
      )
      expect(rows.rows).toEqual([[1, 'untitled']])
    } finally {
      await other(
        dialect === 'mysql'
          ? 'DROP VIEW IF EXISTS prog_v; DROP EVENT IF EXISTS prog_event; DROP TRIGGER IF EXISTS prog_before_insert; DROP FUNCTION IF EXISTS prog_label; DROP PROCEDURE IF EXISTS prog_p; DROP TABLE IF EXISTS prog_t'
          : 'DROP FUNCTION IF EXISTS prog_label(bigint); DROP FUNCTION IF EXISTS prog_count(); DROP VIEW IF EXISTS prog_v2; DROP VIEW IF EXISTS prog_v; DROP TABLE IF EXISTS prog_t CASCADE; DROP FUNCTION IF EXISTS prog_label(int); DROP FUNCTION IF EXISTS prog_label(text); DROP FUNCTION IF EXISTS prog_default_title'
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

  it('logs out', async () => {
    expect((await req('/api/session', { method: 'DELETE' })).status).toBe(200)
  })
})
