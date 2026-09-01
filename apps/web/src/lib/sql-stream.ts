import { type SqlRequest, type SqlStreamEvent, SqlStreamEventSchema } from '@tsmyadmin/shared'
import { ApiError, api, isApiError } from './api.ts'

export type SqlStreamBody = Omit<SqlRequest, 'maxRows' | 'timeoutMs' | 'stopOnError'> & Partial<SqlRequest>

/**
 * Runs a script through POST /sql/stream and yields events as statements complete.
 * A stream that ends without a `done` event is reported as a fatal error (connection dropped).
 */
export async function* streamSql(
  db: string,
  body: SqlStreamBody,
  signal?: AbortSignal
): AsyncGenerator<SqlStreamEvent> {
  const res = await api.databases[':db'].sql.stream.$post(
    { param: { db }, json: body },
    { init: signal ? { signal } : {} }
  )
  if (!res.ok || !res.body) {
    const parsed = await res.json().catch(() => null)
    throw new ApiError(
      res.status,
      parsed && typeof parsed === 'object' && 'code' in parsed
        ? (parsed as ApiError)
        : { code: 'INTERNAL', message: `HTTP ${res.status}` }
    )
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let done = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += chunk.value
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          const event = SqlStreamEventSchema.parse(JSON.parse(line))
          if (event.type === 'done') done = true
          yield event
        }
        nl = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!done) yield { type: 'fatal', message: 'connection closed before the run finished' }
}

export { isApiError }
