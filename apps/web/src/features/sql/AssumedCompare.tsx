import type { ExplainResult } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { IndexCandidate } from './plan-index.ts'
import { type AssumedCompare as Compare, type CompareRow, candidatesKey } from './use-assumed-compare.ts'

const t = locale.plan

/** Which of the row's indexes the server would read through, and which not, by the names given. */
const usedOf = (row: CompareRow) => {
  const used = (c: { name: string }) => row.result?.assumed?.includes(c.name) ?? false
  return {
    used: row.indexes.filter(used).map((c) => c.name),
    unused: row.indexes.filter((c) => !used(c)).map((c) => c.name),
  }
}

/**
 * The candidates set side by side without building any (PostgreSQL with HypoPG): the estimated cost with none, with
 * each alone, and with all of them together, and which the server would use. Not a ranking: candidates on different
 * tables may help together, and the cost is the server's estimate, not time.
 */
export function AssumedCompare({
  compared,
  before,
  candidates,
}: {
  compared: Compare
  /** The estimated plan, as it is. */
  before: ExplainResult
  candidates: readonly IndexCandidate[]
}) {
  const { running } = compared
  // Asked of other candidates (the plan changed since): not these ones'.
  const rows = compared.asked === candidatesKey(candidates) ? compared.rows : null
  const said = running
    ? t.compareRunning
    : rows?.length
      ? t.compareDone(rows.filter((r) => r.result).length, rows.filter((r) => r.error).length)
      : ''
  const failed = rows?.find((r) => r.error)?.error
  return (
    <section aria-label={t.compareGroup} className="space-y-2 border-line border-t pt-2">
      <h5 className="font-semibold text-ink">{t.compareGroup}</h5>
      <p className="text-ink-sub">{t.compareIntro}</p>
      <Button size="sm" aria-disabled={running || undefined} onClick={() => !running && compared.compare(candidates)}>
        {t.compareRun}
      </Button>
      <p role="status" className="text-ink-sub empty:sr-only">
        {said}
      </p>
      {rows?.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">{t.compareCaption}</caption>
              <thead className="text-ink-sub">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-normal">
                    {t.compareColIndexes}
                  </th>
                  <th scope="col" className="py-1 pr-2 font-normal">
                    {t.compareColCost}
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    {t.compareColUsed}
                  </th>
                </tr>
              </thead>
              <tbody className="text-ink">
                <tr className="border-line border-t">
                  <th scope="row" className="py-1 pr-2 font-normal">
                    {t.compareNone}
                  </th>
                  <td className="py-1 pr-2">{t.compareCost(null, before.plan.cost)}</td>
                  <td className="py-1" />
                </tr>
                {rows.map((r) => {
                  const { used, unused } = usedOf(r)
                  const [one] = r.indexes
                  return (
                    <tr key={r.indexes.map((c) => c.name).join('\0')} className="border-line border-t">
                      <th scope="row" className="py-1 pr-2 font-normal">
                        {r.indexes.length > 1 || !one ? t.compareAll : t.compareOne(one.name, one.table, one.columns)}
                      </th>
                      <td className="py-1 pr-2">
                        {r.result ? t.compareCost(before.plan.cost, r.result.plan.cost) : t.compareFailed}
                      </td>
                      <td className="py-1">
                        {r.result
                          ? used.length > 0
                            ? t.compareUsed(used, r.indexes.length > 1 ? unused : [])
                            : t.compareUnused
                          : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-ink-sub">{t.compareNote}</p>
          {failed ? <ErrorBox error={failed} /> : null}
        </>
      ) : null}
    </section>
  )
}
