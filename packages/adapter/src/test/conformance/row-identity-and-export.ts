import {
  type Cell,
  type InputCell,
  isBinaryCell,
  isGeneratedColumn,
  isTruncatedCell,
  MAX_TEXT_CHARS,
} from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { quoteIdent } from '../../sql/quote.ts'
import type { ConformanceEnv } from './env.ts'

/** Conformance: row identity, binary values, export, generated columns and statement-level triggers (in the order they have always run in). */
export function describeRowIdentityAndExport(env: ConformanceEnv): void {
  const { ns, dialect, scratch, exec, execOk, runDdl, browseAll } = env
  describe('row identity edge cases', () => {
    it('handles a mixed-case / quoted primary key column in browse, update, iterate and DDL', async () => {
      const t = `${scratch}_camel`
      const q = (c: string) => quoteIdent(dialect, c)
      await execOk(`CREATE TABLE ${t} (${q('userId')} INT PRIMARY KEY, ${q('Name')} VARCHAR(20) NULL)`)
      await execOk(`INSERT INTO ${t} (${q('userId')}, ${q('Name')}) VALUES (1, 'a'), (2, 'b')`)
      const schema = await env.db.describeTable(ns, t)
      expect(schema.primaryKey).toEqual(['userId'])
      const browsed = await browseAll(t)
      expect(browsed.keyColumns).toEqual(['userId'])
      expect(await env.db.updateRow(ns, t, { kind: 'pk', values: { userId: 2 } }, { Name: 'B' })).toEqual({
        affectedRows: 1,
      })
      const seen: unknown[] = []
      for await (const b of env.db.iterateRows(ns, t, { batchSize: 1 })) seen.push(...b.rows.map((r) => r[0]))
      expect(seen).toEqual([1, 2])
      const create = await env.db.showCreateTable(ns, t)
      await execOk(`DROP TABLE ${t}`)
      await execOk(create.map((c) => `${c};`).join('\n'))
      expect((await env.db.describeTable(ns, t)).primaryKey).toEqual(['userId'])
      await execOk(`DROP TABLE ${t}`)
    })

    it.skipIf(dialect !== 'postgres')('does not treat a partial unique index as a row key', async () => {
      const t = `${scratch}_pu`
      await execOk(
        `CREATE TABLE ${t} (email TEXT NOT NULL, deleted BOOLEAN NOT NULL);
         CREATE UNIQUE INDEX ${t}_live ON ${t} (email) WHERE NOT deleted;
         INSERT INTO ${t} VALUES ('x', true), ('x', true), ('x', false), ('y', false)`
      )
      expect((await browseAll(t)).keyKind).toBe('ctid')
      let n = 0
      for await (const b of env.db.iterateRows(ns, t, { batchSize: 2 })) n += b.rows.length
      expect(n).toBe(4)
      await execOk(`DROP TABLE ${t}`)
    })
  })

  describe.skipIf(dialect !== 'postgres')('partitioned tables', () => {
    it('is read-only without a key and exports every row exactly once', async () => {
      const t = `${scratch}_part`
      await execOk(
        `CREATE TABLE ${t} (id INT NOT NULL, region TEXT NOT NULL) PARTITION BY LIST (region);
         CREATE TABLE ${t}_a PARTITION OF ${t} FOR VALUES IN ('a');
         CREATE TABLE ${t}_b PARTITION OF ${t} FOR VALUES IN ('b');
         INSERT INTO ${t} SELECT i, CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END FROM generate_series(1, 10) i`
      )
      try {
        expect((await env.db.describeTable(ns, t)).partitioned).toBe(true)
        expect((await browseAll(t)).keyKind).toBe('none')
        let n = 0
        for await (const b of env.db.iterateRows(ns, t, { batchSize: 3 })) n += b.rows.length
        expect(n).toBe(10)
        // Partitions are implementation detail: not listed (and therefore not dumped twice).
        expect((await env.db.listTables(ns)).map((x) => x.name)).not.toContain(`${t}_a`)
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })
  })

  describe('binary values', () => {
    it('caps binaries when browsing but exports them whole', async () => {
      const t = `${scratch}_bin`
      const binType = dialect === 'mysql' ? 'LONGBLOB' : 'BYTEA'
      const big = dialect === 'mysql' ? "REPEAT('x', 70000)" : "decode(repeat('78', 70000), 'hex')"
      const bytes = (cell: Cell): number => (isBinaryCell(cell) ? Buffer.from(cell.$bin, 'base64').length : -1)
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, b ${binType} NULL)`)
      await execOk(`INSERT INTO ${t} (id, b) VALUES (1, ${big})`)
      expect(bytes((await browseAll(t)).rows[0]?.[1] ?? null)).toBe(64 * 1024)
      let exported: Cell = null
      for await (const b of env.db.iterateRows(ns, t, { batchSize: 10 })) exported = b.rows[0]?.[1] ?? null
      expect(bytes(exported)).toBe(70000)
      await execOk(`DROP TABLE ${t}`)
    })

    it('caps long text when browsing (with its full length) but exports it whole', async () => {
      const t = `${scratch}_txt`
      const long = `REPEAT('y', ${MAX_TEXT_CHARS + 5})`
      await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, s ${dialect === 'mysql' ? 'MEDIUMTEXT' : 'TEXT'} NULL)`)
      await execOk(`INSERT INTO ${t} (id, s) VALUES (1, ${long}), (2, 'short')`)
      const browsed = (await browseAll(t)).rows.map((r) => r[1] ?? null)
      expect(browsed[1]).toBe('short')
      const cut = browsed[0] ?? null
      expect(isTruncatedCell(cut)).toBe(true)
      expect(isTruncatedCell(cut) ? { chars: cut.$text.length, length: cut.length } : null).toEqual({
        chars: MAX_TEXT_CHARS,
        length: MAX_TEXT_CHARS + 5,
      })
      // The SQL console applies the same cap; a cut value can never be written back through a row key.
      const [viaSql] = await execOk(`SELECT s FROM ${t} WHERE id = 1`)
      expect(viaSql?.kind === 'rows' && isTruncatedCell(viaSql.result.rows[0]?.[0] ?? null)).toBe(true)
      await expect(
        env.db.updateRow(ns, t, { kind: 'pk', values: { id: 1 } }, { s: cut as unknown as InputCell })
      ).rejects.toMatchObject({ code: 'VALIDATION' })
      let exported: Cell = null
      for await (const b of env.db.iterateRows(ns, t, { batchSize: 10 })) exported = b.rows[0]?.[1] ?? null
      expect(typeof exported === 'string' ? exported.length : -1).toBe(MAX_TEXT_CHARS + 5)
      await execOk(`DROP TABLE ${t}`)
    })

    it('reads catalog text (a view definition, a routine body) whole however long it is', async () => {
      const v = `${scratch}_bigview`
      const fn = `${scratch}_bigfn`
      const literal = 'y'.repeat(MAX_TEXT_CHARS + 100)
      await execOk(`CREATE VIEW ${v} AS SELECT '${literal}' AS s`)
      await execOk(
        dialect === 'mysql'
          ? `CREATE FUNCTION ${fn}() RETURNS TEXT DETERMINISTIC RETURN '${literal}'`
          : `CREATE FUNCTION ${fn}() RETURNS text LANGUAGE sql AS $$ SELECT '${literal}' $$`
      )
      try {
        expect((await env.db.showCreateTable(ns, v)).join('\n')).toContain(literal)
        expect(await env.db.routineDefinition(ns, fn, 'function')).toContain(literal)
        // The same text through the console is capped: display and catalog are different reads.
        const [shown] = await execOk(`SELECT s FROM ${v}`)
        expect(shown?.kind === 'rows' && isTruncatedCell(shown.result.rows[0]?.[0] ?? null)).toBe(true)
      } finally {
        await execOk(`DROP VIEW ${v}`)
        await execOk(dialect === 'mysql' ? `DROP FUNCTION ${fn}` : `DROP FUNCTION ${fn}()`)
      }
    })
  })

  describe('export', () => {
    it('dump of identity / auto-increment + generated columns restores over the existing table and keeps inserting', async () => {
      const t = `${scratch}_seq`
      const idCol =
        dialect === 'mysql' ? 'id INT AUTO_INCREMENT PRIMARY KEY' : 'id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
      const expr = dialect === 'mysql' ? 'CONCAT(a, b)' : 'a || b'
      // `at` has an expression default (MySQL reports it as EXTRA = DEFAULT_GENERATED): a regular column whose
      // stored values must survive the dump, unlike the generated `ab`.
      await execOk(
        `CREATE TABLE ${t} (${idCol}, a VARCHAR(10) NOT NULL, b VARCHAR(10) NOT NULL, ab VARCHAR(21) GENERATED ALWAYS AS (${expr}) STORED, at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`
      )
      await execOk(
        `INSERT INTO ${t} (a, b, at) VALUES ('x', 'y', '2001-02-03 04:05:06'), ('p', 'q', '2002-03-04 05:06:07')`
      )
      const schema = await env.db.describeTable(ns, t)
      const generated = new Set(schema.columns.filter((c) => isGeneratedColumn(c.extra)).map((c) => c.name))
      expect([...generated]).toEqual(['ab'])
      const dump = [
        `${env.db.exporter.dropIfExists(ns, schema)};`,
        ...(await env.db.showCreateTable(ns, t, schema)).map((c) => `${c};`),
      ]
      for await (const b of env.db.iterateRows(ns, t, { batchSize: 10, schema })) {
        const keep = b.columns.map((c, i) => (generated.has(c.name) ? -1 : i)).filter((i) => i >= 0)
        dump.push(
          env.db.exporter.insert(
            ns,
            t,
            keep.map((i) => b.columns[i]?.name ?? ''),
            b.rows.map((r) => keep.map((i) => r[i] ?? null)),
            { overriding: schema.columns.some((c) => c.extra === 'identity always') }
          )
        )
      }
      dump.push(...env.db.exporter.afterData(ns, schema))
      await execOk(dump.join('\n'))
      // Sequence advanced past the restored ids: the next insert gets id 3, not a duplicate 1.
      await execOk(`INSERT INTO ${t} (a, b) VALUES ('m', 'n')`)
      const rows = await browseAll(t)
      expect(rows.rows.map((r) => [r[0], r[3]])).toEqual([
        [1, 'xy'],
        [2, 'pq'],
        [3, 'mn'],
      ])
      expect(rows.rows.slice(0, 2).map((r) => String(r[4]).slice(0, 19))).toEqual([
        '2001-02-03 04:05:06',
        '2002-03-04 05:06:07',
      ])
      await execOk(`DROP TABLE ${t}`)
    })

    it.skipIf(dialect !== 'postgres')(
      'dumps an inheritance parent without its children and pages it by key',
      async () => {
        const p = `${scratch}_inh`
        const c = `${scratch}_inh_child`
        await execOk(
          `CREATE TABLE ${p} (id INT PRIMARY KEY, b TEXT); CREATE TABLE ${c} (PRIMARY KEY (id)) INHERITS (${p})`
        )
        await execOk(
          `INSERT INTO ${p} VALUES (1, 'p1'), (2, 'p2'), (3, 'p3'); INSERT INTO ${c} VALUES (1, 'c1'), (2, 'c2')`
        )
        const schema = await env.db.describeTable(ns, p)
        expect(schema).toMatchObject({ partitioned: false, hasChildren: true })
        // Batches smaller than the row count: a keyset over the parent would skip the children's duplicate ids.
        for (const batchSize of [1, 100]) {
          const seen: string[] = []
          for await (const b of env.db.iterateRows(ns, p, { batchSize, schema }))
            for (const r of b.rows) seen.push(String(r[1]))
          expect(seen).toEqual(['p1', 'p2', 'p3'])
        }
        // Browsing keeps SQL semantics (children included); a PK edit through the parent that would touch a
        // child row as well fails the exactly-one-row check instead of silently updating both.
        const all = await browseAll(p)
        expect(all.total).toBe(5)
        await expect(env.db.updateRow(ns, p, { kind: 'pk', values: { id: 1 } }, { b: 'x' })).rejects.toMatchObject({
          code: 'KEY_MISMATCH',
        })
        await execOk(`DROP TABLE ${c}; DROP TABLE ${p}`)
      }
    )

    it.skipIf(dialect !== 'postgres')(
      'advances sequences within their bounds and gives a serial copy its own',
      async () => {
        const t = `${scratch}_seqmin`
        await execOk(
          `CREATE TABLE ${t} (id INT GENERATED BY DEFAULT AS IDENTITY (START WITH 1000 MINVALUE 1000) PRIMARY KEY, s SERIAL, v INT)`
        )
        // Empty table: afterData must not try to set the sequence below its minimum.
        const empty = await env.db.describeTable(ns, t)
        await execOk(env.db.exporter.afterData(ns, empty).join('\n'))
        expect(await env.db.insertRow(ns, t, { v: 1 })).toEqual({ affectedRows: 1 })
        expect((await browseAll(t)).rows[0]?.[0]).toBe(1000)
        const copy = `${scratch}_seqmin_copy`
        await runDdl({
          op: 'copyTable',
          table: t,
          newName: copy,
          withData: true,
          columns: ['id', 's', 'v'],
          identityColumns: ['id'],
          serialColumns: ['s'],
        })
        expect(await env.db.insertRow(ns, copy, { v: 2 })).toEqual({ affectedRows: 1 })
        expect((await browseAll(copy)).rows.map((r) => [r[0], r[1]])).toEqual([
          [1000, 1],
          [1001, 2],
        ])
        // The copy no longer depends on the source's serial sequence: the source can be dropped.
        await execOk(`DROP TABLE ${t}`)
        expect(await env.db.insertRow(ns, copy, { v: 3 })).toEqual({ affectedRows: 1 })
        await execOk(`DROP TABLE ${copy}`)
      }
    )

    it('dump (showCreateTable + iterateRows + exporter.insert) recreates the table with identical rows', async () => {
      const src = `${scratch}_dump`
      await execOk(`CREATE TABLE ${src} (id INT PRIMARY KEY, s VARCHAR(50) NULL, n INT NULL, d DATE NULL)`)
      await execOk(
        `INSERT INTO ${src} (id, s, n, d) VALUES (1, 'it''s "quoted" \\ back', 10, '2024-01-02'), (2, NULL, NULL, NULL), (3, '', 0, '1970-01-01')`
      )
      const before = await browseAll(src)
      const create = await env.db.showCreateTable(ns, src)
      const inserts: string[] = []
      for await (const b of env.db.iterateRows(ns, src, { batchSize: 2 })) {
        inserts.push(
          env.db.exporter.insert(
            ns,
            src,
            b.columns.map((c) => c.name),
            b.rows
          )
        )
      }
      expect(inserts).toHaveLength(2)
      await execOk(`DROP TABLE ${src}`)
      await execOk([...create.map((c) => `${c};`), ...inserts].join('\n'))
      const after = await browseAll(src)
      expect(after.rows).toEqual(before.rows)
      expect(after.columns.map((c) => c.name)).toEqual(before.columns.map((c) => c.name))
      await execOk(`DROP TABLE ${src}`)
    })
  })

  describe('showCreateTable (generated columns)', () => {
    it('round-trips a STORED generated column through the reconstructed DDL', async () => {
      const t = `${scratch}_gen`
      // CONCAT() is only STABLE on PostgreSQL (generation expressions must be IMMUTABLE); || is OR on MySQL.
      const expr = dialect === 'mysql' ? 'CONCAT(a, b)' : 'a || b'
      await execOk(
        `CREATE TABLE ${t} (id INT PRIMARY KEY, a VARCHAR(20) NOT NULL, b VARCHAR(20) NOT NULL, ab VARCHAR(41) GENERATED ALWAYS AS (${expr}) STORED)`
      )
      const create = await env.db.showCreateTable(ns, t)
      expect(create.join('\n')).toMatch(/GENERATED ALWAYS AS \(.*\) STORED/i)
      await execOk(`DROP TABLE ${t}`)
      await execOk(create.map((c) => `${c};`).join('\n'))
      await execOk(`INSERT INTO ${t} (id, a, b) VALUES (1, 'x', 'y')`)
      const rows = await browseAll(t)
      expect(rows.rows[0]?.[3]).toBe('xy')
      const ab = (await env.db.describeTable(ns, t)).columns.find((c) => c.name === 'ab')
      expect(ab?.extra.toLowerCase()).toContain('generated')
      await execOk(`DROP TABLE ${t}`)
    })
  })

  describe('listTriggers (statement-level)', () => {
    it.skipIf(dialect !== 'postgres')('decodes TRUNCATE triggers on PostgreSQL', async () => {
      const fn = `${scratch}_trg_fn`
      await execOk(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
         CREATE TRIGGER ${scratch}_trunc BEFORE TRUNCATE ON ${scratch} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`
      )
      try {
        const trg = (await env.db.listTriggers(ns, scratch)).find((t) => t.name === `${scratch}_trunc`)
        expect(trg).toMatchObject({ timing: 'BEFORE', events: 'TRUNCATE', orientation: 'STATEMENT' })
      } finally {
        await exec(`DROP TRIGGER IF EXISTS ${scratch}_trunc ON ${scratch}; DROP FUNCTION IF EXISTS ${fn}()`, {
          stopOnError: false,
        })
      }
    })
  })
}
