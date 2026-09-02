import { useQuery } from '@tanstack/react-query'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { triggersQuery } from '@/lib/queries.ts'
import { DefinitionToggle } from './DefinitionToggle.tsx'

export function TriggersPage({ db, schema, table }: { db: string; schema?: string | undefined; table?: string }) {
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
                  <DefinitionToggle definition={t.definition} label={t.name} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
