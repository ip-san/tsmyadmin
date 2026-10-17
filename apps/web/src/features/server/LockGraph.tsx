import type { LockWait } from '@tsmyadmin/shared'
import { NodeGraph } from '@/components/node-graph/NodeGraph.tsx'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { locale } from '@/config/locale-screens.ts'
import { lockGraph, lockSentences } from './lock-graph.ts'

/**
 * The lock waits as a picture: who waits for whom, where the chain starts and any deadlock, with the same in words
 * underneath. Killing stays in the table view, where each blocker has its button.
 */
export function LockGraph({ waits }: { waits: readonly LockWait[] }) {
  const model = lockGraph(waits)
  return (
    <div className="space-y-2">
      <NodeGraph nodes={model.nodes} arrows={model.arrows} label={locale.server.lockGraph} />
      <DiagramLegend
        tones={model.cycles.length > 0 ? ['focus', 'blocked'] : ['focus']}
        labels={{ focus: locale.server.lockLegendRoot, blocked: locale.server.lockLegendDeadlock }}
      />
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">
        {lockSentences(model).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <p className="text-xs text-ink-sub">{locale.server.lockGraphHint}</p>
    </div>
  )
}
