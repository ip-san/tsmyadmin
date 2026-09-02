import pg from 'pg'

const BYTEA = 17
const BOOL = 16
const INT8 = 20
/** Only these are parsed to JS numbers; everything else stays as the server's text form. */
const NUMBER_OIDS = new Set([21, 23, 26, 700, 701])

/** int8: number when it fits JS precision, otherwise the exact text (same rule as the MySQL driver). */
function parseInt8(value: string): number | string {
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : value
}

/**
 * Type parser set: keeps values lossless on the wire. int8/numeric/dates/json/arrays/enums/uuid
 * all arrive as text; bytea as Buffer; small ints, floats and booleans as JS primitives.
 */
function parseNumberOrText(value: string): number | string {
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

export const pgTypes: pg.CustomTypesConfig = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format === 'binary') return pg.types.getTypeParser(oid, format)
    if (oid === BYTEA || oid === BOOL) return pg.types.getTypeParser(oid, 'text')
    // float4/float8: JSON has no NaN/Infinity, so those stay as the server's text ('NaN', 'Infinity', '-Infinity').
    if (NUMBER_OIDS.has(oid)) return parseNumberOrText
    if (oid === INT8) return parseInt8
    return (value: string) => value
  },
}

export const PG_TYPE_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  27: 'tid',
  114: 'json',
  142: 'xml',
  600: 'point',
  700: 'float4',
  701: 'float8',
  790: 'money',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1560: 'bit',
  1562: 'varbit',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  199: 'json[]',
  1000: 'bool[]',
  1007: 'int4[]',
  1009: 'text[]',
  1015: 'varchar[]',
  1016: 'int8[]',
  1021: 'float4[]',
  1022: 'float8[]',
  1182: 'date[]',
  1115: 'timestamp[]',
  1185: 'timestamptz[]',
  1231: 'numeric[]',
  2951: 'uuid[]',
  3807: 'jsonb[]',
}
