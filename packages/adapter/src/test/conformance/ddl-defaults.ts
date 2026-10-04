import { type ColumnSpec } from '@tsmyadmin/shared'
import { expect, it } from 'vitest'
import type { ConformanceEnv, DdlHelpers } from './env.ts'
import { col } from './helpers.ts'

/** Conformance of `ddl`: defaults (in the order they have always run in). */
export function describeDdlDefaults(env: ConformanceEnv, { runScript, firstValue }: DdlHelpers): void {
  const { ns, dialect, scratch, exec, execOk, runDdl, browseAll, isMariaDb } = env
  it('creates a row trigger that fires', async () => {
    const t = `${scratch}_trg`
    const trigger = `${scratch}_up`
    await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20))`)
    try {
      await runScript({
        op: 'createTrigger',
        name: trigger,
        table: t,
        timing: 'BEFORE',
        event: 'INSERT',
        body:
          // Ending in a line comment: whatever closes the statement must not land inside it.
          dialect === 'mysql'
            ? 'BEGIN\n  SET NEW.name = UPPER(NEW.name);\nEND; -- upper-cases the name'
            : 'BEGIN\n  NEW.name := UPPER(NEW.name);\n  RETURN NEW;\nEND; -- upper-cases the name',
      })
      await execOk(`INSERT INTO ${t} (id, name) VALUES (1, 'abc')`)
      expect(await firstValue(`SELECT name FROM ${t}`)).toBe('ABC')
      expect((await env.db.listTriggers(ns)).map((x) => x.name)).toContain(trigger)
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      if (dialect === 'postgres') await exec(`DROP FUNCTION IF EXISTS ${trigger}_fn()`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'mysql')('creates an event on a schedule (MySQL)', async () => {
    const event = `${scratch}_ev`
    try {
      await runScript({
        op: 'createEvent',
        name: event,
        schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2030-01-01 00:00:00' },
        body: 'BEGIN\n  SET @conformance_event = 1;\n  SET @conformance_event = 2;\nEND # runs daily',
        enabled: false,
        comment: 'conformance',
      })
      const listed = (await env.db.listEvents(ns)).find((e) => e.name === event)
      expect(listed?.status).toMatch(/DISABLED/i)
    } finally {
      await exec(`DROP EVENT IF EXISTS ${event}`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'postgres')('modifyColumn keeps a serial / identity generator', async () => {
    const t = `${scratch}_ser`
    await execOk(`CREATE TABLE ${t} (sid SERIAL PRIMARY KEY, iid INT GENERATED ALWAYS AS IDENTITY, x INT NULL)`)
    try {
      await runDdl({
        op: 'modifyColumn',
        table: t,
        name: 'sid',
        column: col('sid', 'INT', { nullable: false, autoIncrement: true, comment: 'renumbered' }),
      })
      await runDdl({
        op: 'modifyColumn',
        table: t,
        name: 'iid',
        column: col('iid', 'INT', { nullable: false, autoIncrement: true }),
      })
      await execOk(`INSERT INTO ${t} (x) VALUES (1), (2)`)
      const rows = await browseAll(t)
      expect(rows.rows.map((r) => [r[0], r[1]])).toEqual([
        [1, 1],
        [2, 2],
      ])
      expect((await env.db.describeTable(ns, t)).columns[0]?.comment).toBe('renumbered')
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'mysql')('recovers a default the catalog cannot spell (MySQL)', async () => {
    // information_schema.COLUMNS.COLUMN_DEFAULT is utf8mb3, so a 4-byte character comes back as `?`.
    // MySQL prints such a default as hex in SHOW CREATE TABLE — which is also how a real `?` is told apart.
    if (await isMariaDb()) return
    const t = `${scratch}_astral`
    await execOk(
      `CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
        `emoji VARCHAR(20) NOT NULL DEFAULT '日本語😀', ` +
        `q VARCHAR(20) NOT NULL DEFAULT 'a?b')`
    )
    try {
      const hex = async () => {
        await execOk(`INSERT INTO ${t} () VALUES ()`)
        const rows = await exec(`SELECT HEX(emoji), HEX(q) FROM ${t} ORDER BY id DESC LIMIT 1`)
        const r = rows[0]
        return r?.kind === 'rows' ? JSON.stringify(r.result.rows[0]) : 'n/a'
      }
      const before = await hex()
      const schema = await env.db.describeTable(ns, t)
      const emoji = schema.columns.find((c) => c.name === 'emoji')
      // Recovered as the bytes MySQL itself would write, not as text with a `?` in it.
      expect(emoji?.default).toMatch(/^0x[0-9A-Fa-f]+$/)
      expect(emoji?.defaultIsExpression).toBe(true)
      // A `?` the user really typed stays a plain literal.
      expect(schema.columns.find((c) => c.name === 'q')).toMatchObject({
        default: 'a?b',
        defaultIsExpression: false,
      })
      for (const name of ['emoji', 'q']) {
        const c = schema.columns.find((x) => x.name === name)
        if (!c) throw new Error(name)
        await runDdl({
          op: 'modifyColumn',
          table: t,
          name,
          column: col(name, c.dataType, {
            nullable: c.nullable,
            collation: c.collation,
            comment: 'edited',
            default: c.defaultIsExpression
              ? { kind: 'expression', sql: c.default ?? '' }
              : { kind: 'literal', value: c.default ?? '' },
          }),
        })
      }
      expect(await hex()).toBe(before)
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'mysql')('modifyColumn keeps a column-level CHECK (MariaDB)', async () => {
    // MariaDB attaches CHECKs to the column and MODIFY COLUMN replaces the whole definition, so a
    // comment-only edit used to drop them — including the `json_valid` that is all a JSON column is.
    if (!(await isMariaDb())) return
    const t = `${scratch}_chk`
    await execOk(`CREATE TABLE ${t} (id INT PRIMARY KEY, c INT CHECK (c > 0), j JSON DEFAULT '{}')`)
    try {
      const refuses = async (sql: string) => (await exec(sql, { stopOnError: false })).some((r) => r.kind === 'error')
      const schema = await env.db.describeTable(ns, t)
      expect(schema.columns.find((c) => c.name === 'c')?.check).toBeTruthy()
      expect(schema.columns.find((c) => c.name === 'j')?.check).toBeTruthy()
      for (const name of ['c', 'j']) {
        const c = schema.columns.find((x) => x.name === name)
        if (!c) throw new Error(name)
        await runDdl({
          op: 'modifyColumn',
          table: t,
          name,
          column: col(name, c.dataType, {
            nullable: c.nullable,
            collation: c.collation,
            comment: 'edited',
            check: c.check,
            ...(c.default === null ? {} : { default: { kind: 'literal', value: c.default } }),
          }),
        })
      }
      expect(await refuses(`INSERT INTO ${t} (id, c) VALUES (1, -1)`)).toBe(true)
      expect(await refuses(`INSERT INTO ${t} (id, j) VALUES (2, 'not json')`)).toBe(true)
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'mysql')('describeTable reports a default that replays to the same value', async () => {
    // The two servers print COLUMN_DEFAULT differently (MariaDB quotes and escapes literals, MySQL 8 does
    // not) and both hide it behind the same column. Asserting the produced value catches either format.
    const t = `${scratch}_def`
    await execOk(
      `CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
        `plain VARCHAR(20) NOT NULL DEFAULT 'abc', ` +
        `quoted VARCHAR(20) NOT NULL DEFAULT 'it''s', ` +
        `newline VARCHAR(20) NOT NULL DEFAULT 'a\\nb', ` +
        `slash VARCHAR(20) NOT NULL DEFAULT 'a\\\\nb', ` +
        `looksHex VARCHAR(20) NOT NULL DEFAULT '0xFF', ` +
        `bin VARBINARY(10) NOT NULL DEFAULT 0x6162, ` +
        `none VARCHAR(20) NULL)`
    )
    const names = ['plain', 'quoted', 'newline', 'slash', 'looksHex', 'bin', 'none']
    try {
      const produced = async () => {
        await execOk(`INSERT INTO ${t} () VALUES ()`)
        const rows = await exec(
          `SELECT ${names.map((n) => `HEX(\`${n}\`)`).join(', ')} FROM ${t} ORDER BY id DESC LIMIT 1`
        )
        const r = rows[0]
        return r?.kind === 'rows' ? JSON.stringify(r.result.rows[0]) : 'n/a'
      }
      const before = await produced()
      const schema = await env.db.describeTable(ns, t)
      // A nullable column with no default is "no default", however the catalog spells it.
      expect(schema.columns.find((c) => c.name === 'none')?.default).toBeNull()
      for (const name of names) {
        const c = schema.columns.find((x) => x.name === name)
        if (!c) throw new Error(name)
        await runDdl({
          op: 'modifyColumn',
          table: t,
          name,
          column: col(name, c.dataType, {
            nullable: c.nullable,
            collation: c.collation,
            comment: 'edited',
            ...(c.default === null
              ? {}
              : {
                  default: c.defaultIsExpression
                    ? { kind: 'expression', sql: c.default }
                    : { kind: 'literal', value: c.default },
                }),
          }),
        })
      }
      expect(await produced()).toBe(before)

      // A byte the connection charset cannot show is reported as `?` by MariaDB 10.11 — the catalog itself
      // loses it, so only MySQL can be asked to carry one.
      if (!(await isMariaDb())) {
        const b = `${t}_hi`
        await execOk(`CREATE TABLE ${b} (id INT PRIMARY KEY AUTO_INCREMENT, v VARBINARY(4) NOT NULL DEFAULT 0xFF)`)
        try {
          const hex = async () => {
            await execOk(`INSERT INTO ${b} () VALUES ()`)
            const rows = await exec(`SELECT HEX(v) FROM ${b} ORDER BY id DESC LIMIT 1`)
            const r = rows[0]
            return r?.kind === 'rows' ? String(r.result.rows[0]?.[0]) : 'n/a'
          }
          const was = await hex()
          const c = (await env.db.describeTable(ns, b)).columns.find((x) => x.name === 'v')
          expect(c?.defaultIsExpression).toBe(true)
          await runDdl({
            op: 'modifyColumn',
            table: b,
            name: 'v',
            column: col('v', c?.dataType ?? 'varbinary(4)', {
              nullable: false,
              comment: 'edited',
              default: { kind: 'expression', sql: c?.default ?? '' },
            }),
          })
          expect(await hex()).toBe(was)
        } finally {
          await exec(`DROP TABLE IF EXISTS ${b}`, { stopOnError: false })
        }
      }
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'mysql')('modifyColumn replays an expression default without changing it', async () => {
    // information_schema hands the expression back with its literals escaped and its UTF-8 bytes read as
    // latin1; replaying that text verbatim would store mojibake. What matters is the value it produces.
    const t = `${scratch}_expr`
    await execOk(
      `CREATE TABLE ${t} (id INT PRIMARY KEY AUTO_INCREMENT, ` +
        `jp VARCHAR(20) NULL DEFAULT (concat('日本')), ` +
        `qu VARCHAR(20) NULL DEFAULT (concat('it''s')))`
    )
    try {
      const value = async () => {
        await execOk(`INSERT INTO ${t} () VALUES ()`)
        const rows = await exec(`SELECT jp, qu FROM ${t} ORDER BY id DESC LIMIT 1`)
        const r = rows[0]
        return r?.kind === 'rows' ? JSON.stringify(r.result.rows[0]) : 'n/a'
      }
      const before = await value()
      const schema = await env.db.describeTable(ns, t)
      for (const name of ['jp', 'qu']) {
        const c = schema.columns.find((x) => x.name === name)
        if (!c) throw new Error(name)
        await runDdl({
          op: 'modifyColumn',
          table: t,
          name,
          column: col(name, c.dataType, {
            nullable: c.nullable,
            collation: c.collation,
            // Taken from the catalog's answer, not assumed: a wrong flag has to show up here.
            default: c.defaultIsExpression
              ? { kind: 'expression', sql: c.default ?? '' }
              : { kind: 'literal', value: c.default ?? '' },
            comment: 'edited',
          }),
        })
      }
      expect(await value()).toBe(before)
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
    }
  })

  it.skipIf(dialect !== 'mysql')('modifyColumn keeps the clauses the column form does not model', async () => {
    // MySQL rewrites the whole column, so a comment-only edit used to drop ON UPDATE and the collation.
    const t = `${scratch}_keep`
    await execOk(
      `CREATE TABLE ${t} (id INT PRIMARY KEY, ` +
        'updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP, ' +
        'code VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_bin NULL)'
    )
    try {
      const before = await env.db.describeTable(ns, t)
      const spec = (name: string, over: Partial<ColumnSpec>) => {
        const c = before.columns.find((x) => x.name === name)
        if (!c) throw new Error(`missing column ${name}`)
        return col(name, c.dataType, {
          nullable: c.nullable,
          collation: c.collation,
          onUpdate: /\bon update (CURRENT_TIMESTAMP(?:\(\d\))?)/i.exec(c.extra)?.[1]?.toUpperCase() ?? null,
          ...over,
        })
      }
      await runDdl({
        op: 'modifyColumn',
        table: t,
        name: 'updated_at',
        column: spec('updated_at', { comment: 'c' }),
      })
      await runDdl({ op: 'modifyColumn', table: t, name: 'code', column: spec('code', { comment: 'c' }) })
      const after = await env.db.describeTable(ns, t)
      const byName = (n: string) => after.columns.find((c) => c.name === n)
      expect(byName('updated_at')?.extra.toLowerCase()).toContain('on update current_timestamp')
      expect(byName('code')?.collation).toBe('latin1_bin')
      expect(byName('code')?.comment).toBe('c')
    } finally {
      await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
    }
  })
}
