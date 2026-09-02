import type { ColumnMeta } from '@tsmyadmin/shared'
import type { FieldPacket } from 'mysql2/promise'

const BINARY_CHARSET = 63
const ENUM_FLAG = 256
const SET_FLAG = 2048
const UNSIGNED_FLAG = 32

const TYPE_NAMES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'date',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
}

/** Friendly type name derived from the MySQL column definition packet. */
function mysqlTypeName(field: FieldPacket): string {
  const type = field.columnType ?? -1
  const flags = typeof field.flags === 'number' ? field.flags : 0
  const binary = field.characterSet === BINARY_CHARSET
  if (flags & ENUM_FLAG) return 'enum'
  if (flags & SET_FLAG) return 'set'
  switch (type) {
    case 249:
    case 250:
    case 251:
    case 252: {
      const base = TYPE_NAMES[type] ?? 'blob'
      return binary ? base : base.replace('blob', 'text')
    }
    case 253:
      return binary ? 'varbinary' : 'varchar'
    case 254:
      return binary ? 'binary' : 'char'
    default: {
      const name = TYPE_NAMES[type] ?? `type${type}`
      return flags & UNSIGNED_FLAG && UNSIGNED_TYPES.has(name) ? `${name} unsigned` : name
    }
  }
}

/** Types that carry an UNSIGNED qualifier in MySQL's own type syntax. */
const UNSIGNED_TYPES = new Set(['tinyint', 'smallint', 'int', 'mediumint', 'bigint', 'decimal', 'float', 'double'])

export function mysqlColumnMeta(field: FieldPacket): ColumnMeta {
  return { name: field.name, dataType: mysqlTypeName(field) }
}
