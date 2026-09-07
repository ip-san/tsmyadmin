import type { SqlRequest, SqlStreamEvent } from '@tsmyadmin/shared'
import { SqlStreamEventSchema } from '@tsmyadmin/shared'
import { api, enc } from './api.ts'
import { ndjsonEvents, streamError } from './ndjson.ts'

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
    { param: { db: enc(db) }, json: body },
    { init: signal ? { signal } : {} }
  )
  if (!res.ok || !res.body) throw await streamError(res)
  let done = false
  for await (const event of ndjsonEvents(res.body, SqlStreamEventSchema)) {
    if (event.type !== 'result') done = true
    yield event
  }
  if (!done) yield { type: 'fatal', message: 'connection closed before the run finished' }
}
