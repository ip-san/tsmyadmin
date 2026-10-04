import { ApiErrorSchema, BrowseResultSchema, ImportEventSchema } from '@tsmyadmin/shared'
import { expect, it } from 'vitest'
import type { IntegrationContext } from './context.ts'

/** The API against the real servers: the import: CSV, spreadsheets, archives, pg_dump files and server-level dumps (in the order they have always run in). */
export function describeImport(c: IntegrationContext): void {
  const { dialect, req, app } = c
  const upload = async (db: string, fields: Record<string, string>, body: string | Uint8Array) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.set(k, v)
    fd.set('file', new File([body], 'f.sql'))
    const res = await app.request(`/api/databases/${db}/import`, {
      method: 'POST',
      body: fd,
      headers: { cookie: c.cookie, origin: 'http://localhost' },
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
    const res = await app.request(path, {
      method: 'POST',
      body: fd,
      headers: { cookie: c.cookie, origin: 'http://localhost' },
    })
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
      const { zipStream } = await import('../../lib/zip.ts')
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
}
