import type { KeyValue } from '@tsmyadmin/shared'
import { useDeferredValue, useState } from 'react'
import { CellValue } from '@/components/cells/CellValue.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Badge, Notice } from '@/components/ui/Feedback.tsx'
import { Input, Select } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'

export function filterKeyValues(items: KeyValue[], filter: string): KeyValue[] {
  const q = filter.trim().toLowerCase()
  if (!q) return items
  return items.filter((i) => i.name.toLowerCase().includes(q) || (i.description?.toLowerCase().includes(q) ?? false))
}

export function KeyValueTable({
  items,
  label,
  categorize,
  flags,
  onEdit,
  docUrl,
}: {
  items: KeyValue[]
  label: string
  /** A name's group, for the category filter (blank for none). */
  categorize?: (name: string) => string
  /** Names the advisor has something to say about, with what it says. */
  flags?: ReadonlyMap<string, string>
  /** When given, each row has a button that hands its item to this. */
  onEdit?: (item: KeyValue) => void
  /** When given, a name with a manual page gets a link to it (opens in a new tab). */
  docUrl?: (name: string) => string | null
}) {
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('')
  const categories = categorize ? [...new Set(items.map((i) => categorize(i.name)).filter((c) => c !== ''))].sort() : []
  // Large lists (pg_settings ≈ 350 rows, SHOW VARIABLES ≈ 600) filter on a deferred value so typing stays responsive.
  const deferred = useDeferredValue(filter)
  const shown = filterKeyValues(
    category && categorize ? items.filter((i) => categorize(i.name) === category) : items,
    deferred
  )
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
      {categories.length > 1 ? (
        <label className="ml-3 inline-flex items-center gap-1 text-xs text-ink-sub">
          {locale.server.category}
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto py-1">
            <option value="">{locale.server.allCategories}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
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
              {docUrl ? <Th data-print-hide>{locale.server.manual}</Th> : null}
              {onEdit ? <Th>{locale.ddl.actions}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <Tr key={i.name}>
                <Td className="font-mono text-xs">
                  {i.name}
                  {flags?.has(i.name) ? (
                    <>
                      {' '}
                      <Badge tone="warn" title={flags.get(i.name) ?? ''}>
                        {locale.server.warning}
                      </Badge>
                    </>
                  ) : null}
                </Td>
                <Td className="max-w-md font-mono text-xs">
                  <CellValue cell={i.value} />
                </Td>
                {hasDescription ? <Td className="text-xs text-ink-sub">{i.description ?? ''}</Td> : null}
                {docUrl ? (
                  <Td data-print-hide>
                    {docUrl(i.name) ? (
                      <a
                        href={docUrl(i.name) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${i.name}: ${locale.server.manual}`}
                        className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                      >
                        {locale.server.manual}
                        <span className="sr-only">{locale.nav.opensNewTab}</span>
                      </a>
                    ) : null}
                  </Td>
                ) : null}
                {onEdit ? (
                  <Td>
                    <Button
                      size="sm"
                      aria-haspopup="dialog"
                      aria-label={`${i.name}: ${locale.server.editVariable}`}
                      onClick={() => onEdit(i)}
                    >
                      {locale.server.editVariable}
                    </Button>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  )
}
