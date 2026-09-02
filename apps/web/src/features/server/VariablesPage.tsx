import { useQuery } from '@tanstack/react-query'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { variablesQuery } from '@/lib/queries.ts'
import { KeyValueTable } from './KeyValueTable.tsx'

export function VariablesPage() {
  const vars = useQuery(variablesQuery)
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.server.variablesTitle}</h2>
      {vars.isPending ? (
        <Spinner />
      ) : vars.isError ? (
        <ErrorBox error={vars.error} onRetry={() => void vars.refetch()} />
      ) : (
        <KeyValueTable items={vars.data} label={locale.server.variablesTitle} />
      )}
    </section>
  )
}
