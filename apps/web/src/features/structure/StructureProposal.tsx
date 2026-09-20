import { useQueryClient } from '@tanstack/react-query'
import type { ColumnSpec, DdlOp, Dialect, TableSchema } from '@tsmyadmin/shared'
import { BROWSE_MAX_LIMIT } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { fromColumnDef, toColumnSpec } from '@/lib/column-spec.ts'
import { rowsQuery, type TableRef } from '@/lib/queries.ts'
import { proposeTypes, type TypeProposal } from './structure-proposal.ts'

const t = locale.ddl.proposal

interface Found {
  proposals: TypeProposal[]
  rows: number
}

/**
 * phpMyAdmin's "Propose table structure": reads the first rows of the table and suggests a narrower type for each
 * text column whose values all fit one. Nothing is changed here — the ticked suggestions go to the same preview as
 * any other change of columns.
 */
export function StructureProposal({
  tableRef,
  schema,
  dialect,
  onPreview,
}: {
  tableRef: TableRef
  schema: TableSchema
  dialect: Dialect
  onPreview: (op: DdlOp) => void
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<
    { status: 'idle' | 'loading' } | { status: 'error'; error: unknown } | { status: 'done'; found: Found }
  >({
    status: 'idle',
  })
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const propose = async () => {
    setState({ status: 'loading' })
    try {
      const page = await queryClient.fetchQuery({
        ...rowsQuery(tableRef, { offset: 0, limit: BROWSE_MAX_LIMIT, sort: [], filters: [] }),
        staleTime: 0,
      })
      const found = {
        proposals: proposeTypes(
          schema.columns,
          page.columns.map((c) => c.name),
          page.rows,
          dialect
        ),
        rows: page.rows.length,
      }
      setTicked(new Set(found.proposals.map((p) => p.column)))
      setState({ status: 'done', found })
    } catch (error) {
      setState({ status: 'error', error })
    }
  }
  const spec = (name: string, dataType: string): { column: ColumnSpec; previous: ColumnSpec } | null => {
    const def = schema.columns.find((c) => c.name === name)
    if (!def) return null
    const current = fromColumnDef(def, dialect)
    return { column: toColumnSpec({ ...current, dataType }), previous: toColumnSpec(current) }
  }
  const apply = (found: Found) => {
    const changes = found.proposals
      .filter((p) => ticked.has(p.column))
      .flatMap((p) => {
        const s = spec(p.column, p.to)
        return s ? [{ name: p.column, ...s }] : []
      })
    if (changes.length > 0) onPreview({ op: 'modifyColumns', table: schema.name, changes })
  }
  return (
    <div className="space-y-2 border-t border-line px-4 py-2 text-xs print:hidden">
      <Button size="sm" onClick={() => void propose()} disabled={state.status === 'loading'}>
        {t.button}
      </Button>
      {state.status === 'loading' ? <Spinner /> : null}
      {state.status === 'error' ? <ErrorBox error={state.error} /> : null}
      {state.status === 'done' ? (
        state.found.proposals.length === 0 ? (
          <Notice>{t.none(state.found.rows)}</Notice>
        ) : (
          <div className="space-y-2">
            <p className="text-ink-sub">{t.basis(state.found.rows)}</p>
            <Table aria-label={t.title}>
              <thead>
                <tr>
                  <Th>
                    <span className="sr-only">{locale.ddl.bulk.pick}</span>
                  </Th>
                  <Th>{locale.table.name}</Th>
                  <Th>{t.current}</Th>
                  <Th>{t.proposed}</Th>
                </tr>
              </thead>
              <tbody>
                {state.found.proposals.map((p) => (
                  <Tr key={p.column}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`${p.column}: ${locale.ddl.bulk.pick}`}
                        checked={ticked.has(p.column)}
                        onChange={(e) =>
                          setTicked((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(p.column)
                            else next.delete(p.column)
                            return next
                          })
                        }
                      />
                    </Td>
                    <Td className="font-medium">{p.column}</Td>
                    <Td className="font-mono">{p.from}</Td>
                    <Td className="font-mono">{p.to}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Button
              size="sm"
              variant="primary"
              disabled={ticked.size === 0}
              aria-haspopup="dialog"
              onClick={() => apply(state.found)}
            >
              {t.preview}
            </Button>
          </div>
        )
      ) : null}
    </div>
  )
}
