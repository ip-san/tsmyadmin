import type { TriggerInfo } from '@tsmyadmin/shared'
import { createCommonExporter, type InsertStyle } from '../sql/export.ts'
import { pgLiteral } from '../sql/literal.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'
import { AdapterError, type ProgramStatement, type SqlExporter } from '../types.ts'

/**
 * Moves the sequence behind an identity / serial / nextval() column past the values now in the table. Nothing
 * happens for an empty table or when there is no sequence; the value is clamped to the sequence minimum (a
 * `MINVALUE 1000` sequence must not be set to 1, nor to a negative id) and never lowered (a sequence shared by
 * two tables, or restored to its own position already, keeps the higher value).
 */
export function pgAdvanceSequence(
  quotedTable: string,
  column: string,
  sequence?: string,
  /** The column's declared type: an exotic one (oid) is compared through a cast, which costs the index. */
  dataType = 'integer'
): string {
  const col = quoteIdent('postgres', column)
  const probe = NUMERIC_TYPE.test(dataType) ? col : `${col}::bigint`
  // An inheritance child owns no sequence: the one its inherited nextval() default names is advanced instead.
  const seq = sequence
    ? `${pgLiteral(sequence)}::regclass`
    : `pg_get_serial_sequence(${pgLiteral(quotedTable)}, ${pgLiteral(column)})::regclass`
  // A descending sequence (INCREMENT BY -1) moves the other way: past the smallest value, never raised. Only ids
  // inside the sequence's bounds count: a row outside them (typed in by hand) neither aborts the restore nor
  // exhausts the sequence.
  const last = 'pg_sequence_last_value(s.seqrelid)'
  const up = `GREATEST(m.max_id, s.seqmin, COALESCE(${last}, s.seqmin))`
  const down = `LEAST(m.min_id, s.seqmax, COALESCE(${last}, s.seqmax))`
  // Range-bounded MIN / MAX as plain scalar subqueries: the planner turns each into an index probe (an aggregate
  // FILTER or a cast on the column would force a full scan of a large table at every restore).
  const inRange = `${probe} BETWEEN s.seqmin AND s.seqmax`
  const extremes = `SELECT (SELECT MAX(${probe})::bigint FROM ${quotedTable} WHERE ${inRange}) AS max_id, (SELECT MIN(${probe})::bigint FROM ${quotedTable} WHERE ${inRange}) AS min_id`
  return `SELECT setval(s.seqrelid, CASE WHEN s.seqincrement > 0 THEN ${up} ELSE ${down} END, CASE WHEN s.seqincrement > 0 THEN m.max_id >= s.seqmin ELSE m.min_id <= s.seqmax END OR ${last} IS NOT NULL) FROM pg_sequence s CROSS JOIN LATERAL (${extremes}) m WHERE s.seqrelid = ${seq} AND m.max_id IS NOT NULL`
}

/** Column types the sequence bounds (bigint) compare with directly; anything else goes through a cast. */
const NUMERIC_TYPE =
  /^(?:smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|(?:small|big)?serial)\b/i

/** The sequence a `nextval('…'::regclass)` default names, as written. */
function sequenceOfDefault(def: string | null): string | undefined {
  const m = def === null ? null : /^nextval\('((?:[^']|'')*)'::regclass\)$/.exec(def)
  return m ? (m[1] ?? '').replace(/''/g, "'") : undefined
}

/** `name(identity arguments)` for DROP FUNCTION / PROCEDURE, read from a pg_get_functiondef statement. */
function pgRoutineSignature(statement: string): string | null {
  // The name may be quoted (and then contain spaces or parentheses) and schema-qualified.
  const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:"(?:[^"]|"")*"|[^\s("])+)\(/i.exec(statement)
  if (!m) return null
  // Argument list up to the matching parenthesis, split at top-level commas; DEFAULT expressions are not part
  // of a signature.
  const args: string[] = []
  let depth = 1
  let quote: string | null = null
  let current = ''
  let closed = false
  for (const ch of statement.slice(m[0].length)) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (depth === 0) {
      closed = true
      break
    }
    if (ch === ',' && depth === 1) {
      args.push(current)
      current = ''
    } else current += ch
  }
  if (!closed) return null
  if (current.trim().length > 0) args.push(current)
  const identity = args.map((a) => a.replace(/\s+DEFAULT\s[\s\S]*$/i, '').trim()).filter((a) => a.length > 0)
  return `${m[1]}(${identity.join(', ')})`
}

const id = (name: string) => quoteIdent('postgres', name)

const pgInsertStyle: InsertStyle = {
  verb: () => 'INSERT',
  needsKey: (kind) => kind !== 'insert',
  overriding: (options) => (options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''),
  conflict: (columns, keys, kind, options) => {
    const rest = columns.filter((c) => !keys.includes(c))
    if (kind === 'replace')
      return rest.length > 0
        ? ` ON CONFLICT (${keys.map(id).join(', ')}) DO UPDATE SET ${rest.map((c) => `${id(c)} = EXCLUDED.${id(c)}`).join(', ')}`
        : ' ON CONFLICT DO NOTHING'
    return options.ignore ? ' ON CONFLICT DO NOTHING' : ''
  },
}

/** The PostgreSQL dump statements: the common ones, and what only it has (search_path, sequences to advance, trigger modes). */
export const pgExporter: SqlExporter = {
  ...createCommonExporter('postgres', pgInsertStyle, pgRoutineSignature),
  // Nothing to strip: a PostgreSQL definition carries no DEFINER.
  withoutDefiner: (sql) => sql,
  // pg_get_functiondef is a CREATE OR REPLACE (a DROP would fail while a trigger depends on the function).
  routine: (_ns, _kind, _name, definition): ProgramStatement => ({ sql: definition }),
  trigger(ns, t: TriggerInfo): ProgramStatement {
    // A trigger switched off (or set to fire always / on replicas) comes back the same way.
    const mode = { origin: '', always: 'ENABLE ALWAYS', replica: 'ENABLE REPLICA', disabled: 'DISABLE' }[t.fireMode]
    const fire = mode ? `;\nALTER TABLE ${quoteTable('postgres', ns, t.table)} ${mode} TRIGGER ${id(t.name)}` : ''
    return {
      sql: `DROP TRIGGER IF EXISTS ${id(t.name)} ON ${quoteTable('postgres', ns, t.table)};\n${t.definition ?? ''}${fire}`,
    }
  },
  event: (): ProgramStatement => {
    throw new AdapterError('UNSUPPORTED', 'PostgreSQL has no events')
  },
  programBlock: (statements) => statements.map((s) => `${s.sql};\n\n`).join(''),
  // Index / view definitions are printed relative to the schema, so restore into it explicitly. Function bodies are
  // not validated at creation (pg_dump does the same) so their order does not matter.
  preamble: (ns) => [
    `SET search_path TO ${quoteIdent('postgres', ns.schema ?? 'public')};`,
    'SET check_function_bodies = false;',
    'SET standard_conforming_strings = on;',
  ],
  postamble: () => [],
  afterData: (ns, schema) => {
    const t = quoteTable('postgres', ns, schema.name)
    // Identity columns own their sequence; a serial or any other nextval() default names the sequence to advance
    // (a column may own several sequences, so the one its default calls is the one that moves).
    return schema.columns
      .filter((c) => c.extra.startsWith('identity') || sequenceOfDefault(c.default))
      .map(
        (c) =>
          `${pgAdvanceSequence(t, c.name, c.extra.startsWith('identity') ? undefined : sequenceOfDefault(c.default), c.dataType)};`
      )
  },
}
