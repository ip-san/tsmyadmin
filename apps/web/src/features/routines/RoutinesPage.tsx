import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { setDatabaseConsoleDraft } from '@/lib/console-draft.ts'
import { type EditDefinitionOptions, editDefinitionSql } from '@/lib/edit-definition.ts'
import { routineDefinitionQuery, routinesQuery } from '@/lib/queries.ts'

/**
 * Hands the database SQL tab a script that replaces this object's definition and goes there. There is no
 * structured editor for a routine body: it is code in the server's own dialect, and the console shows exactly
 * what will run before it runs.
 */
function useEditDefinition(db: string, schema: string | undefined) {
  const navigate = useNavigate()
  const { session } = useRouteContext({ from: '/_app' })
  return (o: Omit<EditDefinitionOptions, 'dialect' | 'schema'>) => {
    const scope = `${session.dialect}.${session.host}.${session.port}`
    setDatabaseConsoleDraft(scope, db, schema, editDefinitionSql({ ...o, dialect: session.dialect, schema }))
    void navigate({ to: '/db/$db/sql', params: { db }, search: schema ? { schema } : {} })
  }
}

export function RoutinesPage({ db, schema }: { db: string; schema?: string | undefined }) {
  const edit = useEditDefinition(db, schema)
  const routines = useQuery(routinesQuery(db, schema))
  if (routines.isPending) return <Spinner />
  if (routines.isError) return <ErrorBox error={routines.error} onRetry={() => void routines.refetch()} />
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.routines.title}</h2>
      {routines.data.length === 0 ? (
        <Notice>{locale.routines.none}</Notice>
      ) : (
        <Table aria-label={locale.routines.title}>
          <thead>
            <tr>
              <Th>{locale.routines.name}</Th>
              <Th>{locale.routines.kind}</Th>
              <Th>{locale.routines.parameters}</Th>
              <Th>{locale.routines.returns}</Th>
              <Th>{locale.routines.language}</Th>
              <Th>{locale.routines.comment}</Th>
              <Th>{locale.routines.definition}</Th>
            </tr>
          </thead>
          <tbody>
            {routines.data.map((r) => (
              <Tr key={`${r.kind}:${r.name}:${r.parameters}`}>
                <Td className="font-medium">{r.name}</Td>
                <Td>{locale.routines.kinds[r.kind]}</Td>
                <Td className="font-mono text-xs">{r.parameters}</Td>
                <Td className="font-mono text-xs">{r.returns ?? ''}</Td>
                <Td className="text-xs">{r.language ?? ''}</Td>
                <Td className="text-xs">{r.comment ?? ''}</Td>
                <Td>
                  <DefinitionToggle
                    query={routineDefinitionQuery(db, r.name, r.kind, schema)}
                    label={r.name}
                    {...(r.kind === 'procedure' || r.kind === 'function'
                      ? {
                          // MariaDB packages are listed and dumped but never created here, so they get no editor.
                          onEdit: (definition: string) =>
                            edit({
                              kind: r.kind as 'procedure' | 'function',
                              name: r.name,
                              definition,
                              sqlMode: r.sqlMode,
                            }),
                        }
                      : {})}
                  />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
