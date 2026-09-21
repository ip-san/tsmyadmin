import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { setDatabaseConsoleDraft } from '@/lib/console-draft.ts'
import { type EditDefinitionOptions, editDefinitionSql } from '@/lib/edit-definition.ts'

/** Puts a statement in the database's SQL tab, replacing its draft, and goes there. It runs on arrival only if `run`. */
export function useOpenInDatabaseConsole(db: string, schema: string | undefined) {
  const navigate = useNavigate()
  const { session } = useRouteContext({ from: '/_app' })
  return (sql: string, run = false) => {
    setDatabaseConsoleDraft(`${session.dialect}.${session.host}.${session.port}`, db, schema, sql, run)
    void navigate({ to: '/db/$db/sql', params: { db }, search: schema ? { schema } : {} })
  }
}

/**
 * Hands the database SQL tab a script that replaces an object's definition. There is no structured editor for a
 * routine or trigger body: it is code in the server's own dialect, and the console shows exactly what will run.
 */
export function useEditDefinition(db: string, schema: string | undefined) {
  const open = useOpenInDatabaseConsole(db, schema)
  const { session } = useRouteContext({ from: '/_app' })
  return (o: Omit<EditDefinitionOptions, 'dialect' | 'schema'>) =>
    open(editDefinitionSql({ ...o, dialect: session.dialect, schema }))
}
