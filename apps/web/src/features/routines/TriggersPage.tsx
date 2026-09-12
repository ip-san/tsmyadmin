import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { setDatabaseConsoleDraft } from '@/lib/console-draft.ts'
import { type EditDefinitionOptions, editDefinitionSql } from '@/lib/edit-definition.ts'
import { triggersQuery } from '@/lib/queries.ts'

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

export function TriggersPage({ db, schema, table }: { db: string; schema?: string | undefined; table?: string }) {
  const edit = useEditDefinition(db, schema)
  const triggers = useQuery(triggersQuery(db, schema, table))
  if (triggers.isPending) return <Spinner />
  if (triggers.isError) return <ErrorBox error={triggers.error} onRetry={() => void triggers.refetch()} />
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.triggers.title}</h2>
      {triggers.data.length === 0 ? (
        <Notice>{locale.triggers.none}</Notice>
      ) : (
        <Table aria-label={locale.triggers.title}>
          <thead>
            <tr>
              <Th>{locale.triggers.name}</Th>
              {table ? null : <Th>{locale.triggers.table}</Th>}
              <Th>{locale.triggers.timing}</Th>
              <Th>{locale.triggers.events}</Th>
              <Th>{locale.triggers.orientation}</Th>
              <Th>{locale.triggers.definition}</Th>
            </tr>
          </thead>
          <tbody>
            {triggers.data.map((t) => (
              <Tr key={`${t.table}:${t.name}`}>
                <Td className="font-medium">{t.name}</Td>
                {table ? null : <Td>{t.table}</Td>}
                <Td className="text-xs">{t.timing}</Td>
                <Td className="text-xs">{t.events}</Td>
                <Td className="text-xs">{t.orientation}</Td>
                <Td>
                  <DefinitionToggle
                    definition={t.definition}
                    label={t.name}
                    onEdit={(definition) => edit({ kind: 'trigger', name: t.name, definition, table: t.table })}
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
