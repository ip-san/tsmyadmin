import type { Dialect } from '@tsmyadmin/shared'
import { parseParameters } from '@/lib/routine-call.ts'

/** A PostgreSQL overload is named by its argument types: the printed list without DEFAULT tails. */
export function signatureOf(dialect: Dialect, parameters: string): string | undefined {
  if (dialect !== 'postgres') return undefined
  return parseParameters(parameters)
    .map((p) => `${p.mode} ${p.name} ${p.type}`.trim())
    .join(', ')
}
