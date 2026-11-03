import { z } from 'zod'
import { readPreference, removePreference, writePreference } from '@/lib/preferences.ts'

/**
 * Unsent editor text, per console and per browser tab. The key is shared with `SqlConsole`, which reads it on
 * mount: a page that wants to hand the console a script writes the draft and then navigates there.
 *
 * `scope` identifies the server (dialect.host.port) so two servers open in one browser keep separate drafts;
 * the server-level console is one editor whose target database can change, so its draft is not keyed by database.
 */
export function consoleDraftKey(scope: string, db: string, schema: string | undefined, draftId: string): string {
  return draftId === 'server' ? `sql.draft.${scope}.server` : `sql.draft.${scope}.${db}.${schema ?? ''}.${draftId}`
}

/** sessionStorage, so a draft dies with the tab; absent in a private window, where drafts simply do not persist. */
export function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** What the console does once with a statement handed to it: runs it, or draws its plan (which runs nothing). */
export type ConsoleArrival = 'run' | 'plan'

/** Puts `sql` in the database console's editor, replacing whatever draft was there, and what to do with it on arrival. */
export function setDatabaseConsoleDraft(
  scope: string,
  db: string,
  schema: string | undefined,
  sql: string,
  then?: ConsoleArrival
): void {
  const key = consoleDraftKey(scope, db, schema, 'db')
  writePreference(key, sql, sessionStore())
  if (then) writePreference(`${key}.auto${then}`, sql, sessionStore())
}

/** The statement a page asked the console to run (or draw the plan of) on arrival, once: reading it clears it. */
export function takeConsoleArrival(key: string, then: ConsoleArrival): string | null {
  const store = sessionStore()
  const sql = readPreference<string | null>(`${key}.auto${then}`, z.string().nullable(), null, store)
  removePreference(`${key}.auto${then}`, store)
  return sql
}
