import { fitText, textWidth } from './layout.ts'

/** A count or a name over a box's top-right corner (`right` is the box's width). */
export function Badge({ text, right }: { text: string; right: number }) {
  const w = Math.min(right, Math.ceil(textWidth(text, 11, true) + 14))
  return (
    <g transform={`translate(${right - w} -10)`}>
      <rect width={w} height={18} rx={9} className="fill-surface stroke-line-strong" />
      <text x={w / 2} y={13} textAnchor="middle" className="fill-ink text-[11px] font-semibold">
        {fitText(text, 11, w - 8)}
      </text>
    </g>
  )
}
