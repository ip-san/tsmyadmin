import type { CentralColumnBody, ColumnDef, ColumnSpec, Dialect } from '@tsmyadmin/shared'
import { onUpdateExpression } from '@tsmyadmin/shared'

type DefaultKind = 'none' | 'literal' | 'expression'

export interface ColumnFormValues {
  name: string
  dataType: string
  nullable: boolean
  defaultKind: DefaultKind
  defaultValue: string
  autoIncrement: boolean
  comment: string
  /**
   * Not shown in the form, but MySQL rewrites the whole column on every change, so these travel with the values
   * and are emitted again. Without them a comment-only edit would drop the collation or the ON UPDATE clause.
   */
  collation: string | null
  onUpdate: string | null
  check: string | null
  /** A generated column's expression and whether it is stored; null for an ordinary column. */
  generated: { expression: string; stored: boolean } | null
}

export const EMPTY_COLUMN: ColumnFormValues = {
  name: '',
  dataType: '',
  nullable: true,
  defaultKind: 'none',
  defaultValue: '',
  autoIncrement: false,
  comment: '',
  collation: null,
  onUpdate: null,
  check: null,
  generated: null,
}

export type TypeGroupKey =
  | 'numeric'
  | 'text'
  | 'binary'
  | 'datetime'
  | 'boolean'
  | 'json'
  | 'network'
  | 'spatial'
  | 'other'

/** The type names offered in the dropdown, by kind and most common first; length, values and attributes are typed beside it. */
export const TYPE_GROUPS: Record<Dialect, { key: TypeGroupKey; names: string[] }[]> = {
  mysql: [
    {
      key: 'numeric',
      names: [
        'INT',
        'BIGINT',
        'TINYINT',
        'SMALLINT',
        'MEDIUMINT',
        'INTEGER',
        'DECIMAL',
        'NUMERIC',
        'FLOAT',
        'DOUBLE',
        'DOUBLE PRECISION',
        'REAL',
        'BIT',
      ],
    },
    { key: 'text', names: ['VARCHAR', 'TEXT', 'CHAR', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'ENUM', 'SET'] },
    { key: 'binary', names: ['BLOB', 'VARBINARY', 'BINARY', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB'] },
    { key: 'datetime', names: ['DATETIME', 'TIMESTAMP', 'DATE', 'TIME', 'YEAR'] },
    { key: 'boolean', names: ['BOOLEAN'] },
    { key: 'json', names: ['JSON'] },
    {
      key: 'spatial',
      names: [
        'GEOMETRY',
        'POINT',
        'LINESTRING',
        'POLYGON',
        'MULTIPOINT',
        'MULTILINESTRING',
        'MULTIPOLYGON',
        'GEOMETRYCOLLECTION',
      ],
    },
  ],
  postgres: [
    {
      key: 'numeric',
      names: [
        'integer',
        'bigint',
        'smallint',
        'numeric',
        'decimal',
        'real',
        'double precision',
        'serial',
        'bigserial',
        'smallserial',
        'money',
        'int',
        'int2',
        'int4',
        'int8',
        'float4',
        'float8',
      ],
    },
    { key: 'text', names: ['varchar', 'text', 'char', 'character varying', 'character', 'name', 'xml'] },
    { key: 'binary', names: ['bytea', 'bit', 'bit varying', 'varbit'] },
    {
      key: 'datetime',
      names: [
        'timestamp',
        'timestamptz',
        'date',
        'time',
        'timetz',
        'interval',
        'timestamp without time zone',
        'timestamp with time zone',
        'time without time zone',
        'time with time zone',
      ],
    },
    { key: 'boolean', names: ['boolean', 'bool'] },
    { key: 'json', names: ['jsonb', 'json', 'jsonpath', 'uuid'] },
    { key: 'network', names: ['inet', 'cidr', 'macaddr', 'macaddr8'] },
    { key: 'spatial', names: ['point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle'] },
    {
      key: 'other',
      names: ['tsvector', 'tsquery', 'int4range', 'int8range', 'numrange', 'daterange', 'tsrange', 'tstzrange', 'oid'],
    },
  ],
}

export const TYPE_NAMES: Record<Dialect, string[]> = {
  mysql: TYPE_GROUPS.mysql.flatMap((g) => g.names),
  postgres: TYPE_GROUPS.postgres.flatMap((g) => g.names),
}

/** What a type usually needs after its name, filled in when it is picked (MySQL refuses a bare VARCHAR). */
const DEFAULT_TYPE_ARGS: Record<string, string> = {
  varchar: '(255)',
  varbinary: '(255)',
  decimal: '(10,2)',
  numeric: '(10,2)',
}

export const defaultArgs = (base: string): string => DEFAULT_TYPE_ARGS[base.toLowerCase()] ?? ''

/**
 * A type expression as its name and the rest (`(255)`, `(10,2) UNSIGNED`, `[]`). Whatever the server reports or the
 * user typed survives the round trip: an unlisted name is kept as it is, and text that starts with no name at all
 * stays whole in the rest.
 */
export function splitType(dialect: Dialect, dataType: string): { base: string; rest: string } {
  const t = dataType.trimStart()
  const lower = t.toLowerCase()
  let known = ''
  for (const name of TYPE_NAMES[dialect]) {
    if (
      name.length > known.length &&
      lower.startsWith(name.toLowerCase()) &&
      !/[a-z0-9_]/.test(lower[name.length] ?? '')
    ) {
      known = name
    }
  }
  if (known) return { base: known, rest: t.slice(known.length) }
  const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(t)?.[0] ?? ''
  return { base: word, rest: t.slice(word.length) }
}

export function joinType(base: string, rest: string): string {
  return `${base}${rest}`
}

/** Picking another name keeps what the user typed after the old one, unless it was only the old name's usual arguments. */
export function retypeName(dialect: Dialect, dataType: string, base: string): string {
  const cur = splitType(dialect, dataType)
  const rest = cur.rest === '' || cur.rest === defaultArgs(cur.base) ? defaultArgs(base) : cur.rest
  return joinType(base, rest)
}

export function toColumnSpec(v: ColumnFormValues): ColumnSpec {
  if (v.generated) {
    // The server computes it: no default, identity or ON UPDATE goes with it.
    return {
      name: v.name.trim(),
      dataType: v.dataType.trim(),
      nullable: v.nullable,
      default: null,
      autoIncrement: false,
      comment: v.comment.trim() === '' ? null : v.comment,
      collation: v.collation,
      onUpdate: null,
      check: v.check,
      generated: { expression: v.generated.expression.trim(), stored: v.generated.stored },
    }
  }
  return {
    name: v.name.trim(),
    dataType: v.dataType.trim(),
    nullable: v.nullable,
    default:
      v.defaultKind === 'none'
        ? null
        : v.defaultKind === 'literal'
          ? { kind: 'literal', value: v.defaultValue }
          : { kind: 'expression', sql: v.defaultValue },
    autoIncrement: v.autoIncrement,
    comment: v.comment.trim() === '' ? null : v.comment,
    collation: v.collation,
    onUpdate: v.onUpdate,
    check: v.check,
    generated: null,
  }
}

/** Prefills the form from catalog metadata. Existing defaults are kept as raw expressions so they round-trip. */
/** A central column as the starting values of a new column. */
export function fromCentralColumn(c: CentralColumnBody): ColumnFormValues {
  return {
    ...EMPTY_COLUMN,
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultKind: c.default === null ? 'none' : c.defaultIsExpression ? 'expression' : 'literal',
    defaultValue: c.default ?? '',
    comment: c.comment,
  }
}

export function fromColumnDef(c: ColumnDef, dialect: Dialect): ColumnFormValues {
  const auto = c.extra.includes('auto_increment') || c.extra.includes('identity') || c.extra === 'serial'
  let defaultKind: DefaultKind = 'none'
  let defaultValue = ''
  // A generated column's expression is not a default (PostgreSQL reports it in the same place).
  if (c.default !== null && !auto && !c.generated) {
    defaultKind = c.defaultIsExpression ? 'expression' : 'literal'
    defaultValue = c.default
  }
  return {
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultKind,
    defaultValue,
    autoIncrement: auto,
    comment: c.comment ?? '',
    // Both dialects: MySQL replaces the whole definition, PostgreSQL compares with the current one and emits
    // only what changed.
    collation: c.collation,
    onUpdate: dialect === 'mysql' ? onUpdateExpression(c.extra) : null,
    check: c.check,
    generated: c.generated,
  }
}

/**
 * MySQL accepts `COLLATE` only on a character string type; on anything else it is an error or meaningless.
 * `NATIONAL`/`N`-prefixed types are deliberately absent: they pin their own character set.
 */
const CHARACTER_TYPE =
  /^(?:CHAR|CHARACTER(?:\s+VARYING)?|VARCHAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|LONG(?:\s+VARCHAR)?|ENUM|SET)\b/i
/** A collation the user typed themselves wins; emitting the carried one too is "Multiple COLLATE clauses". */
const TYPED_COLLATION = /\b(?:COLLATE|CHARACTER\s+SET|CHARSET)\b/i
/** `ON UPDATE CURRENT_TIMESTAMP(n)` needs a TIMESTAMP / DATETIME, and `n` must match the type's precision. */
const TIMESTAMP_TYPE = /^(?:TIMESTAMP|DATETIME)\s*(?:\((\d)\))?/i
/** `CURRENT_TIMESTAMP(n)` as a default carries the same precision rule as the ON UPDATE clause. */
const CURRENT_TIMESTAMP = /^CURRENT_TIMESTAMP(\((\d)\))?$/i

/**
 * The type text with its comments and string literals blanked out, so `ENUM('collate')` is not read as a
 * COLLATE clause and `/* widen *\/ VARCHAR(100)` still starts with VARCHAR. Deliberately not the adapter's
 * lexer: `apps/web` may not import it, and a type expression is a far smaller language than a SQL script.
 */
function typeShape(dataType: string): string {
  let out = ''
  for (let i = 0; i < dataType.length; i++) {
    const c = dataType[i] as string
    if (c === '/' && dataType[i + 1] === '*') {
      const end = dataType.indexOf('*/', i + 2)
      i = end === -1 ? dataType.length : end + 1
      out += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < dataType.length) {
        if (dataType[j] === '\\') j += 2
        else if (dataType[j] === c && dataType[j + 1] === c) j += 2
        else if (dataType[j] === c) break
        else j++
      }
      i = Math.min(j, dataType.length)
      out += "''"
    } else out += c
  }
  return out.trim()
}

/**
 * A new data type for the form. `collation` and `ON UPDATE` are carried invisibly (MySQL rewrites the whole
 * column on every change), so each follows the new type:
 * - the collation survives a type that can hold one (`VARCHAR(50)` → `VARCHAR(100)` keeps it; → `JSON` drops it,
 *   because MySQL rejects `JSON … COLLATE utf8mb4_bin`), and steps aside when the user types their own;
 * - `ON UPDATE` survives a TIMESTAMP / DATETIME, rewritten to that type's fractional precision — the clause is
 *   refused when the two disagree, and dropping it silently would lose an `updated_at` column's whole point.
 */
export function retypeColumn(v: ColumnFormValues, initial: ColumnFormValues, dataType: string): ColumnFormValues {
  const t = typeShape(dataType)
  const timestamp = TIMESTAMP_TYPE.exec(t)
  const typeFsp = timestamp ? (timestamp[1] ?? '') : null
  const stamp = typeFsp === null ? null : `CURRENT_TIMESTAMP${typeFsp === '' ? '' : `(${typeFsp})`}`
  const keepsCollation = CHARACTER_TYPE.test(t) && !TYPED_COLLATION.test(t)
  // A `DEFAULT CURRENT_TIMESTAMP` is shown in the form, but MySQL wants its precision to match the type too,
  // so it follows the new type rather than leaving the user with "Invalid default value".
  const shownDefault =
    stamp !== null && v.defaultKind === 'expression' && CURRENT_TIMESTAMP.test(v.defaultValue.trim())
      ? { defaultValue: stamp }
      : {}
  return {
    ...v,
    ...shownDefault,
    dataType,
    collation: keepsCollation ? (v.collation ?? initial.collation) : null,
    onUpdate: stamp === null || v.onUpdate === null ? null : stamp,
  }
}

export function validateColumn(v: ColumnFormValues): string | null {
  if (v.name.trim() === '') return 'name'
  if (v.dataType.trim() === '') return 'dataType'
  if (v.generated && v.generated.expression.trim() === '') return 'generated'
  return null
}
