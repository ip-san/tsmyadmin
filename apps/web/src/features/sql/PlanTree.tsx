import type { PlanNode } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'
import { misestimate } from './plan-measure.ts'

const t = locale.plan

/** The tree as the server gave it; the node read at the current step is marked. */
export function PlanTree({ node, path, current }: { node: PlanNode; path: string; current: string | undefined }) {
  const here = path === current
  const ms = node.actual?.ms ?? null
  // A step far off its estimate is marked in the tree too, where the eye goes first.
  const off = misestimate(node)
  const facts = [
    node.table ? `${node.table}${node.alias ? ` ${node.alias}` : ''}` : null,
    node.index ? `[${node.index}]` : null,
    node.estRows === null ? null : t.rows(Math.round(node.estRows)),
    node.actual ? t.actual(node.actual.rows, node.actual.loops, ms === null ? null : t.duration(ms)) : null,
    off ? t.off(off.factor, off.more) : null,
  ].filter(Boolean)
  return (
    <li className="ml-3 border-l border-line pl-2">
      <span
        aria-current={here ? 'step' : undefined}
        className={`inline-block rounded px-1 ${here ? 'bg-row-hover font-semibold text-ink' : 'text-ink'}`}
      >
        {node.op}
        {facts.length > 0 ? <span className="text-ink-sub"> — {facts.join(' · ')}</span> : null}
      </span>
      {node.detail ? <div className="break-all text-ink-sub">{node.detail}</div> : null}
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((c, i) => (
            <PlanTree key={`${path}.${i}`} node={c} path={`${path}.${i}`} current={current} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
