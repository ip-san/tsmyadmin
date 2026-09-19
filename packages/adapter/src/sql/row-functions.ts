import type { Dialect, RowFunction } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'

/**
 * Each allowed row function as SQL, per dialect. `arg` is the placeholder of the bound argument; the function
 * names come from this table only, never from the request. PostgreSQL has no SHA-1 without pgcrypto, so it is
 * refused rather than silently written as something else.
 */
const FUNCTIONS: Record<Dialect, Record<RowFunction, ((arg: string) => string) | null>> = {
  mysql: {
    now: () => 'NOW()',
    current_date: () => 'CURRENT_DATE',
    current_time: () => 'CURRENT_TIME',
    uuid: () => 'UUID()',
    md5: (a) => `MD5(${a})`,
    sha1: (a) => `SHA1(${a})`,
    sha256: (a) => `SHA2(${a}, 256)`,
    upper: (a) => `UPPER(${a})`,
    lower: (a) => `LOWER(${a})`,
    trim: (a) => `TRIM(${a})`,
  },
  postgres: {
    now: () => 'now()',
    current_date: () => 'CURRENT_DATE',
    current_time: () => 'CURRENT_TIME',
    uuid: () => 'gen_random_uuid()',
    md5: (a) => `md5(${a}::text)`,
    sha1: null,
    sha256: (a) => `encode(sha256(convert_to(${a}::text, 'UTF8')), 'hex')`,
    upper: (a) => `upper(${a}::text)`,
    lower: (a) => `lower(${a}::text)`,
    trim: (a) => `btrim(${a}::text)`,
  },
}

/** The SQL for `fn` with its argument at `arg` (a placeholder), or UNSUPPORTED where the dialect lacks it. */
export function rowFunctionSql(dialect: Dialect, fn: RowFunction, arg: () => string): string {
  const render = FUNCTIONS[dialect][fn]
  if (!render) throw new AdapterError('UNSUPPORTED', `${fn} is not available on ${dialect}`)
  return render.length === 0 ? render('') : render(arg())
}
