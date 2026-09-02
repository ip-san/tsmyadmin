import type { KeyValue } from '@tsmyadmin/shared'
import { useDeferredValue, useState } from 'react'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'

export function filterKeyValues(items: KeyValue[], filter: string): KeyValue[] {
  const q = filter.trim().toLowerCase()
  if (!q) return items
  return items.filter((i) => i.name.toLowerCase().includes(q) || (i.description?.toLowerCase().includes(q) ?? false))
}

export function KeyValueTable({ items, label }: { items: KeyValue[]; label: string }) {
  const [filter, setFilter] = useState('')
  // Large lists (pg_settings ≈ 350 rows, SHOW VARIABLES ≈ 600) filter on a deferred value so typing stays responsive.
  const deferred = useDeferredValue(filter)
  const shown = filterKeyValues(items, deferred)
  const hasDescription = items.some((i) => i.description)
  return (
    <div className="space-y-2">
      <Input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={locale.server.filter}
        aria-label={locale.server.filter}
        className="max-w-sm"
      />
      <output aria-live="polite" className="sr-only">
        {filter.trim() !== '' ? locale.nav.matchCount(shown.length, items.length) : ''}
      </output>
      {shown.length === 0 ? (
        <Notice>{locale.server.noMatch}</Notice>
      ) : (
        <Table aria-label={label}>
          <thead>
            <tr>
              <Th>{locale.server.name}</Th>
              <Th>{locale.server.value}</Th>
              {hasDescription ? <Th>{locale.server.description}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <Tr key={i.name}>
                <Td className="font-mono text-xs">{i.name}</Td>
                <Td className="max-w-md break-all font-mono text-xs">{i.value}</Td>
                {hasDescription ? (
                  <Td className="text-xs text-zinc-500 dark:text-zinc-400">{i.description ?? ''}</Td>
                ) : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}
