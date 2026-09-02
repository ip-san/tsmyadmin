import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Dialect } from '@tsmyadmin/shared'
import { ChevronDown, ChevronRight, Database } from 'lucide-react'
import { useRef, useState } from 'react'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { databasesQuery, schemasQuery } from '@/lib/queries.ts'
import { useShortcuts } from '@/lib/shortcuts.ts'
import { TableList } from './TableList.tsx'

function SchemaNodes({ db, filter }: { db: string; filter: string }) {
  const schemas = useQuery(schemasQuery(db))
  const [open, setOpen] = useState<Record<string, boolean>>({ public: true })
  if (schemas.isPending) return <Spinner />
  if (schemas.isError) return <ErrorBox error={schemas.error} onRetry={() => void schemas.refetch()} />
  return (
    <ul className="ml-3 border-l border-zinc-200 pl-2 dark:border-zinc-700">
      {schemas.data.map((s) => (
        <li key={s}>
          <div className="flex items-center">
            <button
              type="button"
              className="inline-flex min-h-6 min-w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              aria-expanded={open[s] ?? false}
              aria-label={locale.nav.expand(s)}
              onClick={() => setOpen((o) => ({ ...o, [s]: !o[s] }))}
            >
              {open[s] ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden />
              )}
            </button>
            {/* The schema itself is a destination: its structure / SQL / export tabs live under ?schema=. */}
            <Link
              to="/db/$db"
              params={{ db }}
              search={{ schema: s }}
              className="flex min-w-0 flex-1 items-center truncate rounded px-1 py-0.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              activeProps={{ className: 'text-blue-800 dark:text-blue-200' }}
              activeOptions={{ exact: true, includeSearch: true }}
              onClick={() => setOpen((o) => ({ ...o, [s]: true }))}
            >
              <span className="truncate">{s}</span>
            </Link>
          </div>
          {open[s] ? <TableList db={db} schema={s} filter={filter} /> : null}
        </li>
      ))}
    </ul>
  )
}

export function DbTree({ dialect, activeDb }: { dialect: Dialect; activeDb?: string | undefined }) {
  const databases = useQuery(databasesQuery)
  const [open, setOpen] = useState<Record<string, boolean>>(activeDb ? { [activeDb]: true } : {})
  // Navigating to another database (server list, FK link) expands it (state-from-props reset pattern).
  const [prevActive, setPrevActive] = useState(activeDb)
  if (prevActive !== activeDb) {
    setPrevActive(activeDb)
    if (activeDb) setOpen((o) => ({ ...o, [activeDb]: true }))
  }
  const [filter, setFilter] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useShortcuts([{ keys: 'mod+k', global: true, handler: () => searchRef.current?.focus() }])
  if (databases.isPending)
    return (
      <div className="p-3">
        <Spinner />
      </div>
    )
  if (databases.isError)
    return (
      <div className="p-3">
        <ErrorBox error={databases.error} onRetry={() => void databases.refetch()} />
      </div>
    )
  return (
    <div className="p-2">
      <Input
        ref={searchRef}
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={locale.nav.filterTables}
        aria-label={locale.nav.filterTables}
        className="mb-2"
      />
      <ul>
        {databases.data.map((d) => {
          const expanded = open[d.name] ?? false
          return (
            <li key={d.name}>
              <div className="flex items-center">
                <button
                  type="button"
                  className="inline-flex min-h-6 min-w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  aria-expanded={expanded}
                  aria-label={locale.nav.expand(d.name)}
                  onClick={() => setOpen((o) => ({ ...o, [d.name]: !expanded }))}
                >
                  {expanded ? (
                    <ChevronDown className="size-3.5" aria-hidden />
                  ) : (
                    <ChevronRight className="size-3.5" aria-hidden />
                  )}
                </button>
                <Link
                  to="/db/$db"
                  params={{ db: d.name }}
                  className="flex min-w-0 flex-1 items-center gap-1 truncate rounded px-1 py-0.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  activeProps={{ className: 'text-blue-800 dark:text-blue-200' }}
                  activeOptions={{ exact: true, includeSearch: false }}
                  onClick={() => setOpen((o) => ({ ...o, [d.name]: true }))}
                >
                  <Database className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{d.name}</span>
                </Link>
              </div>
              {expanded ? (
                dialect === 'postgres' ? (
                  <SchemaNodes db={d.name} filter={filter} />
                ) : (
                  <TableList db={d.name} filter={filter} />
                )
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
