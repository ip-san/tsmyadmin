import type { ColumnDef, ColumnSpec, Dialect } from '@tsmyadmin/shared'
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
}

export const TYPE_SUGGESTIONS: Record<Dialect, string[]> = {
  mysql: [
    'INT',
    'BIGINT',
    'VARCHAR(255)',
    'TEXT',
    'DATETIME',
    'TIMESTAMP',
    'DATE',
    'DECIMAL(10,2)',
    'BOOLEAN',
    'JSON',
    'BLOB',
  ],
  postgres: [
    'integer',
    'bigint',
    'varchar(255)',
    'text',
    'timestamp',
    'timestamptz',
    'date',
    'numeric(10,2)',
    'boolean',
    'jsonb',
    'bytea',
    'uuid',
  ],
}

export function toColumnSpec(v: ColumnFormValues): ColumnSpec {
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
  }
}

/** Prefills the form from catalog metadata. Existing defaults are kept as raw expressions so they round-trip. */
export function fromColumnDef(c: ColumnDef, dialect: Dialect): ColumnFormValues {
  const auto = c.extra.includes('auto_increment') || c.extra.includes('identity') || c.extra === 'serial'
  let defaultKind: DefaultKind = 'none'
  let defaultValue = ''
  if (c.default !== null && !auto) {
    const generated = dialect === 'mysql' && c.extra.toUpperCase().includes('DEFAULT_GENERATED')
    defaultKind = dialect === 'mysql' && !generated ? 'literal' : 'expression'
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
    // PostgreSQL emits only the clauses that change, so it needs neither; MySQL replaces the definition.
    collation: dialect === 'mysql' ? c.collation : null,
    onUpdate: dialect === 'mysql' ? onUpdateExpression(c.extra) : null,
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

/**
 * A new data type for the form. `collation` and `ON UPDATE` are carried invisibly (MySQL rewrites the whole
 * column on every change), so each follows the new type:
 * - the collation survives a type that can hold one (`VARCHAR(50)` → `VARCHAR(100)` keeps it; → `JSON` drops it,
 *   because MySQL rejects `JSON … COLLATE utf8mb4_bin`), and steps aside when the user types their own;
 * - `ON UPDATE` survives a TIMESTAMP / DATETIME, rewritten to that type's fractional precision — the clause is
 *   refused when the two disagree, and dropping it silently would lose an `updated_at` column's whole point.
 */
export function retypeColumn(v: ColumnFormValues, initial: ColumnFormValues, dataType: string): ColumnFormValues {
  const t = dataType.trim()
  const timestamp = TIMESTAMP_TYPE.exec(t)
  const typeFsp = timestamp ? (timestamp[1] ?? '') : null
  const keepsCollation = CHARACTER_TYPE.test(t) && !TYPED_COLLATION.test(t)
  return {
    ...v,
    dataType,
    collation: keepsCollation ? initial.collation : null,
    onUpdate:
      typeFsp === null || initial.onUpdate === null ? null : `CURRENT_TIMESTAMP${typeFsp === '' ? '' : `(${typeFsp})`}`,
  }
}

export function validateColumn(v: ColumnFormValues): string | null {
  if (v.name.trim() === '') return 'name'
  if (v.dataType.trim() === '') return 'dataType'
  return null
}
