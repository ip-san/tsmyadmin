import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import type { routineDefinitionQuery } from '@/lib/queries.ts'

type DefinitionQuery = ReturnType<typeof routineDefinitionQuery>
type Source = { definition: string | null } | { query: DefinitionQuery }

function Definition({ definition }: { definition: string | null }) {
  if (definition === null)
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.routines.noDefinition}</span>
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950">
      {definition}
    </pre>
  )
}

function LazyDefinition({ query }: { query: DefinitionQuery }) {
  const q = useQuery(query)
  if (q.isPending) return <Spinner />
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
  return <Definition definition={q.data.definition} />
}

/**
 * Collapsible SQL definition. Pass `definition` when the list already carries it (triggers, events) or `query`
 * to fetch it on first expand (routines: one SHOW CREATE per routine on MySQL). null = the account may not read it.
 */
export function DefinitionToggle({ label, ...source }: { label: string } & Source) {
  const [open, setOpen] = useState(false)
  if ('definition' in source && source.definition === null) return <Definition definition={null} />
  return (
    <div>
      <Button
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}: ${open ? locale.routines.hide : locale.routines.show}`}
      >
        {open ? locale.routines.hide : locale.routines.show}
      </Button>
      {open ? (
        'definition' in source ? (
          <Definition definition={source.definition} />
        ) : (
          <LazyDefinition query={source.query} />
        )
      ) : null}
    </div>
  )
}
