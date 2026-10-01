/**
 * Whether an error means the session store itself cannot be used right now, as opposed to a bug or a bad request:
 * Redis that does not answer (ioredis gives up a command after its retries) or a SQLite file that is locked, cannot
 * be opened or cannot be written. The caller can only retry later, so the API answers 503 instead of an unexplained
 * 500.
 *
 * Recognised by shape, because the drivers' own error classes are not exported. Every shape here was taken from the
 * real driver, under Bun and under Node alike: ioredis with a Redis stopped under a live connection, and
 * `node:sqlite` on a missing, locked and read-only file. A constraint violation or "no such table" is a bug, and is
 * deliberately not among them.
 */

/**
 * SQLite result codes that say the file, not the statement, is the problem (the primary code is the low byte of
 * `errcode`, which also carries an extended code in the higher bits).
 */
const SQLITE_FILE_PROBLEMS = new Set([
  5, // SQLITE_BUSY: another connection holds the lock
  6, // SQLITE_LOCKED
  8, // SQLITE_READONLY
  10, // SQLITE_IOERR
  11, // SQLITE_CORRUPT
  13, // SQLITE_FULL: the disk is full
  14, // SQLITE_CANTOPEN
  26, // SQLITE_NOTADB
])

export function isStoreUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // ioredis: `maxRetriesPerRequest` reached while the server is down; and a command sent after the connection ended.
  if (err.name === 'MaxRetriesPerRequestError' || err.message === 'Connection is closed.') return true
  const { code, errcode } = err as { code?: unknown; errcode?: unknown }
  return code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && SQLITE_FILE_PROBLEMS.has(errcode & 0xff)
}
