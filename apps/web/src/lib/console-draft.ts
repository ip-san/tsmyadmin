import { writePreference } from '@/lib/preferences.ts'

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

/** Puts `sql` in the database console's editor, replacing whatever draft was there. */
export function setDatabaseConsoleDraft(scope: string, db: string, schema: string | undefined, sql: string): void {
  writePreference(consoleDraftKey(scope, db, schema, 'db'), sql, sessionStore())
}
