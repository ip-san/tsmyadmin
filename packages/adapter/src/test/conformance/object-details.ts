import { describe, expect, it } from 'vitest'
import type { ConformanceEnv } from './env.ts'
import { col } from './helpers.ts'

/** Conformance: the blocks of `object-details` (in the order they have always run in). */
export function describeObjectDetails(env: ConformanceEnv): void {
  const { ns, dialect, scratch, exec, execOk, runDdl } = env
  describe('modifyColumn to a narrower type', () => {
    it('turns a text column of integers into INT, keeping the values (PostgreSQL needs the cast spelled out)', async () => {
      const t = `${scratch}_narrow`
      try {
        await runDdl({
          op: 'createTable',
          table: t,
          columns: [col('id', 'INT', { nullable: false }), col('code', 'VARCHAR(255)')],
          primaryKey: ['id'],
        })
        await execOk(`INSERT INTO ${t} VALUES (1, '10'), (2, '200'), (3, NULL)`)
        await runDdl({
          op: 'modifyColumn',
          table: t,
          name: 'code',
          column: col('code', 'INT'),
          previous: col('code', 'VARCHAR(255)'),
        })
        const described = await env.db.describeTable(ns, t)
        expect(described.columns.find((c) => c.name === 'code')?.dataType).toMatch(/^(int|integer)/i)
        const [r] = await exec(`SELECT code FROM ${t} ORDER BY id`)
        expect(r?.kind === 'rows' ? r.result.rows : []).toEqual([[10], [200], [null]])
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })
  })

  describe('routineDetail', () => {
    it('reads a routine back as the create form takes it, body escapes intact, and replaces it', async () => {
      const name = `${scratch}_rd`
      const body = dialect === 'mysql' ? "RETURN CONCAT('a\\'b', \"c\\\\d\", n)" : "BEGIN RETURN 'a''b' || n::text; END"
      const create = {
        op: 'createRoutine' as const,
        kind: 'function' as const,
        name,
        params: [{ mode: 'IN' as const, name: 'n', type: dialect === 'mysql' ? 'INT' : 'integer' }],
        returns: dialect === 'mysql' ? 'VARCHAR(30)' : 'text',
        body,
        language: dialect === 'mysql' ? 'sql' : 'plpgsql',
        deterministic: true,
        comment: "it's a note",
      }
      try {
        await runDdl(create)
        const detail = await env.db.routineDetail(ns, name, 'function')
        expect(detail).toMatchObject({ kind: 'function', name, comment: "it's a note", deterministic: true })
        expect(detail?.body.trim().replace(/;$/, '')).toBe(body.replace(/;$/, ''))
        expect(detail?.params.map((p) => [p.mode, p.name])).toEqual([['IN', 'n']])
        // Edit: change the body through replaceRoutine, from what was read back.
        if (!detail) throw new Error('no detail')
        const info = (await env.db.listRoutines(ns)).find((r) => r.name === name)
        await runDdl({
          op: 'replaceRoutine',
          ...detail,
          body: dialect === 'mysql' ? 'RETURN n + 1' : 'BEGIN RETURN (n + 1)::text; END',
          replaces: {
            kind: 'function',
            name,
            ...(dialect === 'postgres' ? { parameters: info?.parameters ?? '' } : {}),
          },
        })
        const after = await env.db.routineDetail(ns, name, 'function')
        expect(after?.body).toContain('n + 1')
        expect(after?.comment).toBe("it's a note")
      } finally {
        const info = (await env.db.listRoutines(ns)).find((r) => r.name === name)
        await exec(
          env.db.ddl
            .build(ns, {
              op: 'dropRoutine',
              kind: 'function',
              name,
              ...(dialect === 'postgres' ? { parameters: info?.parameters ?? '' } : {}),
            })
            .join(';\n'),
          { stopOnError: false }
        )
      }
    })
  })

  describe('triggerDetail', () => {
    it('reads a trigger back as the create form takes it, and replaces it with another event', async () => {
      const table = `${scratch}_trt`
      const trigger = `${scratch}_trg`
      const body =
        dialect === 'mysql' ? "SET NEW.s = CONCAT('x\\'y', \"z\\\\w\")" : "BEGIN NEW.s := 'x''y'; RETURN NEW; END"
      try {
        await execOk(`CREATE TABLE ${table} (id INT PRIMARY KEY, s VARCHAR(30))`)
        await runDdl({ op: 'createTrigger', name: trigger, table, timing: 'BEFORE', event: 'INSERT', body })
        const detail = await env.db.triggerDetail(ns, table, trigger)
        expect(detail).toMatchObject({ name: trigger, table, timing: 'BEFORE', event: 'INSERT' })
        expect(detail?.body.trim()).toBe(body)
        if (!detail) throw new Error('no detail')
        await runDdl({
          op: 'replaceTrigger',
          ...detail,
          event: 'UPDATE',
          replaces: { name: trigger, table },
        })
        expect(await env.db.triggerDetail(ns, table, trigger)).toMatchObject({ timing: 'BEFORE', event: 'UPDATE' })
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${table}`)
        if (dialect === 'postgres') await exec(`DROP FUNCTION IF EXISTS ${trigger}_fn()`, { stopOnError: false })
      }
    })
  })

  describe('eventDetail', () => {
    it('reads an event back (MySQL) and replaces its schedule; PostgreSQL has none', async () => {
      const name = `${scratch}_evd`
      if (dialect === 'postgres') {
        expect(await env.db.eventDetail(ns, name)).toBeNull()
        return
      }
      const body = "INSERT INTO users_log_none VALUES (1, 'q\\'r')"
      try {
        await execOk('CREATE TABLE IF NOT EXISTS users_log_none (id INT, s VARCHAR(20))')
        await runDdl({
          op: 'createEvent',
          name,
          schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2031-01-01 00:00:00' },
          body,
          enabled: false,
          comment: 'c',
        })
        const detail = await env.db.eventDetail(ns, name)
        expect(detail).toMatchObject({
          name,
          schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2031-01-01 00:00:00' },
          enabled: false,
          comment: 'c',
          preserve: false,
        })
        expect(detail?.body).toBe(body)
        if (!detail) throw new Error('no detail')
        await runDdl({
          op: 'replaceEvent',
          ...detail,
          schedule: { kind: 'every', interval: 2, unit: 'HOUR' },
          replaces: name,
        })
        expect((await env.db.eventDetail(ns, name))?.schedule).toMatchObject({
          kind: 'every',
          interval: 2,
          unit: 'HOUR',
        })
      } finally {
        await exec(`DROP EVENT IF EXISTS \`${name}\``, { stopOnError: false })
        await exec('DROP TABLE IF EXISTS users_log_none', { stopOnError: false })
      }
    })
  })

  describe('createTable options', () => {
    it('creates a table with its comment, and with its engine and collation on MySQL', async () => {
      const t = `${scratch}_copt`
      try {
        await runDdl({
          op: 'createTable',
          table: t,
          columns: [col('id', 'INT', { nullable: false })],
          primaryKey: ['id'],
          comment: "made 'with' options",
          ...(dialect === 'mysql' ? { engine: 'InnoDB', collation: 'utf8mb4_bin' } : {}),
        })
        const described = await env.db.describeTable(ns, t)
        expect(described.comment).toBe("made 'with' options")
        if (dialect === 'mysql') {
          expect(described.engine).toBe('InnoDB')
          expect(described.collation).toBe('utf8mb4_bin')
        }
      } finally {
        await execOk(`DROP TABLE IF EXISTS ${t}`)
      }
    })
  })

  describe('listPartitions', () => {
    it('partitions a table, adds, empties, analyses and removes partitions, and reads them back', async () => {
      const t = `${scratch}_part`
      const count = async () => {
        const [r] = await exec(`SELECT COUNT(*) FROM ${t}`)
        return r?.kind === 'rows' ? Number(r.result.rows[0]?.[0]) : -1
      }
      try {
        expect((await env.db.listPartitions(ns, 'users')).method).toBeNull()
        if (dialect === 'mysql') {
          await execOk(`CREATE TABLE ${t} (id INT NOT NULL, n INT)`)
          await runDdl({
            op: 'partitionTable',
            table: t,
            method: 'range',
            expression: 'id',
            partitions: [
              { name: 'p0', bound: 'VALUES LESS THAN (10)' },
              { name: 'p1', bound: 'VALUES LESS THAN (20)' },
            ],
          })
          await runDdl({ op: 'addPartition', table: t, partition: { name: 'p2', bound: 'VALUES LESS THAN (30)' } })
        } else {
          await runDdl({
            op: 'createTable',
            table: t,
            columns: [col('id', 'INT', { nullable: false }), col('n', 'INT')],
            primaryKey: [],
            partitionBy: { method: 'range', expression: 'id' },
          })
          await runDdl({
            op: 'addPartition',
            table: t,
            partition: { name: `${t}_p0`, bound: 'FOR VALUES FROM (0) TO (10)' },
          })
          await runDdl({
            op: 'addPartition',
            table: t,
            partition: { name: `${t}_p1`, bound: 'FOR VALUES FROM (10) TO (20)' },
          })
          await runDdl({ op: 'addPartition', table: t, partition: { name: `${t}_p2`, bound: 'DEFAULT' } })
        }
        const [p0, p1, p2] = dialect === 'mysql' ? ['p0', 'p1', 'p2'] : [`${t}_p0`, `${t}_p1`, `${t}_p2`]
        await execOk(`INSERT INTO ${t} (id, n) VALUES (1, 1), (15, 2), (25, 3)`)
        const parts = await env.db.listPartitions(ns, t)
        expect(parts.method).toBe('range')
        expect(parts.expression?.replaceAll('`', '')).toBe('id')
        expect(parts.partitions.map((p) => p.name)).toEqual([p0, p1, p2])
        expect(parts.partitions[0]?.bound).toBe(
          dialect === 'mysql' ? 'VALUES LESS THAN (10)' : 'FOR VALUES FROM (0) TO (10)'
        )
        if (dialect === 'postgres') expect(parts.partitions[2]?.bound).toBe('DEFAULT')

        await runDdl({ op: 'truncatePartition', table: t, name: p0 ?? '' })
        expect(await count()).toBe(2)
        await runDdl({ op: 'maintainPartition', table: t, name: p1 ?? '', action: 'analyze' })
        if (dialect === 'postgres') {
          // Detached, the partition is a table of its own with its rows.
          await runDdl({ op: 'detachPartition', table: t, name: p1 ?? '' })
          expect(await count()).toBe(1)
          await execOk(`DROP TABLE ${p1}`)
        }
        await runDdl({ op: 'dropPartition', table: t, name: p2 ?? '' })
        expect((await env.db.listPartitions(ns, t)).partitions.map((p) => p.name)).toEqual(
          dialect === 'mysql' ? [p0, p1] : [p0]
        )
        if (dialect === 'mysql') {
          await runDdl({ op: 'removePartitioning', table: t })
          expect(await env.db.listPartitions(ns, t)).toEqual({ method: null, expression: null, partitions: [] })
          expect(await count()).toBe(1)
        }
        await expect(env.db.listPartitions(ns, `${t}_missing`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      } finally {
        await exec(`DROP TABLE IF EXISTS ${t}`, { stopOnError: false })
      }
    })
  })

  describe('databaseGrants', () => {
    it('lists the accounts’ database-level privileges (MySQL), and none on PostgreSQL', async () => {
      const grants = await env.db.databaseGrants(ns.database)
      expect(Array.isArray(grants)).toBe(true)
      if (dialect === 'postgres') expect(grants).toEqual([])
      // Every entry names an account and only privileges a GRANT can carry.
      for (const g of grants) {
        expect(g.user).toEqual(expect.any(String))
        expect(g.privileges.every((p) => /^[A-Z][A-Z ]*$/.test(p))).toBe(true)
      }
      // A database nobody was granted anything on.
      expect(await env.db.databaseGrants(`${scratch}_nobody`)).toEqual([])
    })
  })
}
