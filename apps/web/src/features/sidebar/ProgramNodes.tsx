import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Dialect } from '@tsmyadmin/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { eventsQuery, routinesQuery } from '@/lib/queries.ts'

/** One branch ("Routines" or "Events") under a database: closed until opened, and read only then. */
function Branch({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        className="flex min-h-6 w-full items-center gap-1 rounded px-1 text-left text-xs font-medium text-ink-sub hover:bg-surface-sub"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        {label}
      </button>
      {open ? children : null}
    </li>
  )
}

function Names({
  names,
  to,
  db,
  schema,
}: {
  names: string[]
  to: '/db/$db/routines' | '/db/$db/events'
  db: string
  schema?: string | undefined
}) {
  if (names.length === 0) return <p className="ml-5 text-xs text-ink-faint">{locale.nav.noPrograms}</p>
  return (
    <ul className="ml-3 border-l border-line pl-2">
      {names.map((n) => (
        <li key={n}>
          <Link
            to={to}
            params={{ db }}
            search={schema ? { schema } : {}}
            className="block truncate rounded px-1 py-0.5 text-xs text-ink hover:bg-surface-sub"
            title={n}
          >
            {n}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** phpMyAdmin's tree shows a database's routines and events under its tables: opt-in here (a setting). */
export function ProgramNodes({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const [routinesOpen, setRoutinesOpen] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const routines = useQuery({ ...routinesQuery(db, schema), enabled: routinesOpen })
  const events = useQuery({ ...eventsQuery(db, schema), enabled: eventsOpen && dialect === 'mysql' })
  return (
    <ul className="ml-3 border-l border-line pl-2">
      <Branch label={locale.nav.routines} open={routinesOpen} onToggle={() => setRoutinesOpen((o) => !o)}>
        {routines.isPending ? (
          <Spinner />
        ) : routines.isError ? (
          <ErrorBox error={routines.error} onRetry={() => void routines.refetch()} />
        ) : (
          <Names
            names={[
              ...new Set(
                routines.data.filter((r) => r.kind === 'procedure' || r.kind === 'function').map((r) => r.name)
              ),
            ]}
            to="/db/$db/routines"
            db={db}
            schema={schema}
          />
        )}
      </Branch>
      {dialect === 'mysql' ? (
        <Branch label={locale.nav.events} open={eventsOpen} onToggle={() => setEventsOpen((o) => !o)}>
          {events.isPending ? (
            <Spinner />
          ) : events.isError ? (
            <ErrorBox error={events.error} onRetry={() => void events.refetch()} />
          ) : (
            <Names names={events.data.map((e) => e.name)} to="/db/$db/events" db={db} schema={schema} />
          )}
        </Branch>
      ) : null}
    </ul>
  )
}
