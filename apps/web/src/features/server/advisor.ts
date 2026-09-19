import type { Dialect, KeyValue } from '@tsmyadmin/shared'

const RULE_IDS = [
  'uptimeShort',
  'slowLogOff',
  'slowQueries',
  'threadCache',
  'maxConnections',
  'abortedConnects',
  'bufferPool',
  'tmpDisk',
  'fullJoin',
  'fullScan',
  'tableOpenCache',
  'lockWaits',
  'durability',
  'filePerTable',
  'pgCacheHit',
  'pgDeadlocks',
  'pgTempBytes',
  'pgConnections',
  'pgRollbacks',
  'pgFsyncOff',
  'pgAutovacuumOff',
  'pgSharedBuffers',
] as const
type RuleId = (typeof RULE_IDS)[number]

export interface Finding {
  id: RuleId
  level: 'warn' | 'info'
  /** Figures for the message's `{name}` placeholders. */
  values: Record<string, string>
  /** Status variables the finding is about: the Status tab marks them. */
  flags: string[]
}

export interface AdvisorInput {
  dialect: Dialect
  variables: readonly KeyValue[]
  status: readonly KeyValue[]
  uptimeSec: number | null
}

const asMap = (items: readonly KeyValue[]) => new Map(items.map((i) => [i.name.toLowerCase(), i.value]))

/** A PostgreSQL setting as bytes: `16384 8kB` (pg_settings' setting and unit) or `128MB`. */
export function settingBytes(value: string | undefined): number | null {
  if (value === undefined) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(\d*)\s*(B|kB|MB|GB|TB)?\s*$/i.exec(value)
  if (!m?.[1]) return null
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
  const unit = units[(m[3] ?? 'B').toLowerCase()] ?? 1
  // `16384 8kB`: a count of 8 kB blocks.
  const block = m[2] ? Number(m[2]) : 1
  return Number(m[1]) * block * unit
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/**
 * What the server's own counters say about how it is set up, as the same kind of advice phpMyAdmin's Advisor gives.
 * Counters are read as totals since start, so the rules ask for a minimum of activity before they speak: a ratio
 * over a handful of events says nothing. Nothing here changes the server.
 */
export function advise(input: AdvisorInput): Finding[] {
  const status = asMap(input.status)
  const vars = asMap(input.variables)
  const n = (m: Map<string, string>, name: string): number | null => {
    const v = m.get(name.toLowerCase())
    if (v === undefined || v.trim() === '') return null
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  const out: Finding[] = []
  const add = (id: RuleId, level: Finding['level'], values: Record<string, string> = {}, flags: string[] = []) =>
    out.push({ id, level, values, flags })
  /** `a / b` when both are known and b is at least `min`. */
  const ratio = (a: number | null, b: number | null, min = 1): number | null =>
    a !== null && b !== null && b >= min ? a / b : null
  const off = (v: string | undefined) => v !== undefined && /^(off|0|false)$/i.test(v.trim())
  const hours = input.uptimeSec === null ? null : input.uptimeSec / 3600

  if (input.dialect === 'mysql') {
    if (input.uptimeSec !== null && input.uptimeSec < 86_400)
      add('uptimeShort', 'info', { hours: (input.uptimeSec / 3600).toFixed(1) })
    if (off(vars.get('slow_query_log'))) add('slowLogOff', 'info', { time: vars.get('long_query_time') ?? '' })
    const slow = ratio(n(status, 'Slow_queries'), n(status, 'Questions'), 1000)
    if (slow !== null && slow >= 0.05) add('slowQueries', 'warn', { ratio: pct(slow) }, ['Slow_queries'])
    const threads = ratio(n(status, 'Threads_created'), n(status, 'Connections'), 100)
    if (threads !== null && threads >= 0.1)
      add('threadCache', 'warn', { ratio: pct(threads), cache: vars.get('thread_cache_size') ?? '' }, [
        'Threads_created',
      ])
    const used = ratio(n(status, 'Max_used_connections'), n(vars, 'max_connections'))
    if (used !== null && used >= 0.8)
      add(
        'maxConnections',
        'warn',
        { used: String(n(status, 'Max_used_connections')), max: String(n(vars, 'max_connections')) },
        ['Max_used_connections']
      )
    const aborted = ratio(n(status, 'Aborted_connects'), n(status, 'Connections'), 100)
    if (aborted !== null && aborted >= 0.05)
      add('abortedConnects', 'warn', { ratio: pct(aborted) }, ['Aborted_connects'])
    const pool = ratio(n(status, 'Innodb_buffer_pool_reads'), n(status, 'Innodb_buffer_pool_read_requests'), 10_000)
    if (pool !== null && pool >= 0.01)
      add('bufferPool', 'warn', { ratio: pct(pool) }, ['Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests'])
    const tmp = ratio(n(status, 'Created_tmp_disk_tables'), n(status, 'Created_tmp_tables'), 100)
    if (tmp !== null && tmp >= 0.25) add('tmpDisk', 'warn', { ratio: pct(tmp) }, ['Created_tmp_disk_tables'])
    const joins = n(status, 'Select_full_join')
    if (joins !== null && joins > 0) add('fullJoin', 'warn', { count: String(joins) }, ['Select_full_join'])
    const scans = ratio(n(status, 'Select_scan'), n(status, 'Com_select'), 1000)
    if (scans !== null && scans >= 0.25) add('fullScan', 'info', { ratio: pct(scans) }, ['Select_scan'])
    const opened = n(status, 'Opened_tables')
    if (opened !== null && hours !== null && hours >= 1 && opened / hours > 12)
      add(
        'tableOpenCache',
        'warn',
        { perHour: (opened / hours).toFixed(0), cache: vars.get('table_open_cache') ?? '' },
        ['Opened_tables']
      )
    const waited = n(status, 'Table_locks_waited')
    const immediate = n(status, 'Table_locks_immediate')
    const locks = waited !== null && immediate !== null ? ratio(waited, waited + immediate, 100) : null
    if (locks !== null && locks >= 0.05) add('lockWaits', 'warn', { ratio: pct(locks) }, ['Table_locks_waited'])
    const flush = vars.get('innodb_flush_log_at_trx_commit')
    if (flush !== undefined && flush !== '1') add('durability', 'info', { value: flush })
    if (off(vars.get('innodb_file_per_table'))) add('filePerTable', 'info')
  } else {
    const hit = n(status, 'blks_hit')
    const read = n(status, 'blks_read')
    if (hit !== null && read !== null && hit + read >= 10_000 && hit / (hit + read) < 0.99)
      add('pgCacheHit', 'warn', { ratio: pct(hit / (hit + read)) }, ['blks_read', 'blks_hit'])
    const dead = n(status, 'deadlocks')
    if (dead !== null && dead > 0) add('pgDeadlocks', 'warn', { count: String(dead) }, ['deadlocks'])
    const temp = n(status, 'temp_bytes')
    if (temp !== null && temp > 0)
      add('pgTempBytes', 'info', { bytes: String(temp), workMem: vars.get('work_mem') ?? '' }, ['temp_bytes'])
    const conns = ratio(n(status, 'total_connections'), n(status, 'max_connections'))
    if (conns !== null && conns >= 0.8)
      add(
        'pgConnections',
        'warn',
        { used: String(n(status, 'total_connections')), max: String(n(status, 'max_connections')) },
        ['total_connections']
      )
    const commit = n(status, 'xact_commit')
    const rollback = n(status, 'xact_rollback')
    if (commit !== null && rollback !== null && commit + rollback >= 100 && rollback / (commit + rollback) >= 0.1)
      add('pgRollbacks', 'info', { ratio: pct(rollback / (commit + rollback)) }, ['xact_rollback'])
    if (off(vars.get('fsync'))) add('pgFsyncOff', 'warn')
    if (off(vars.get('autovacuum'))) add('pgAutovacuumOff', 'warn')
    const buffers = settingBytes(vars.get('shared_buffers'))
    if (buffers !== null && buffers < 128 * 1024 ** 2)
      add('pgSharedBuffers', 'info', { size: vars.get('shared_buffers') ?? '' })
  }
  return out
}

/** Fills `{name}` placeholders of a message from a finding's values. */
export const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
