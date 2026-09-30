/**
 * What the screens know about the server, in two shapes:
 *
 * - `*Query` (`queryOptions`): a read. They are definitions, not hooks, so `useQuery`, a prefetch and an
 *   invalidation all take the same object. A query key starts with a root name (`'session'`, `'servers'`, …) and a
 *   write refreshes queries by that root; `isDatabaseData` is the one shared rule about which roots a write leaves alone.
 * - `mutations`: a write, as a plain async function. The caller decides what to refetch afterwards.
 *
 * Every call goes through `api` (`hc<AppType>`) and `unwrap`, so the types come from the API's routes and the shared
 * Zod schemas rather than being written twice.
 *
 * The reads and writes sit in `queries/`, one file per part of the API (the split of `apps/api/src/routes`):
 * `session` (the connection and its second factors), `stored` (what is saved for an account or the server),
 * `databases`, `tables`, and `server` (with its accounts). This file only gathers them, so every import keeps the
 * path `@/lib/queries.ts`, and `mutations` is one object again.
 */
import { databaseMutations } from './queries/databases.ts'
import { serverMutations } from './queries/server.ts'
import { sessionMutations } from './queries/session.ts'
import { storedMutations } from './queries/stored.ts'
import { tableMutations } from './queries/tables.ts'

export { invalidateDatabaseData, isDatabaseData, type TableRef } from './queries/common.ts'
export * from './queries/databases.ts'
export * from './queries/server.ts'
export * from './queries/session.ts'
export * from './queries/stored.ts'
export * from './queries/tables.ts'

/** Every write, by name; each area's own writes sit beside its reads in `queries/`. */
export const mutations = {
  ...sessionMutations,
  ...storedMutations,
  ...databaseMutations,
  ...tableMutations,
  ...serverMutations,
}
