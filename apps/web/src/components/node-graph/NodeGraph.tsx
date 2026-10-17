import { useId } from 'react'
import { Badge } from '@/components/schema-diagram/Badge.tsx'
import { fitText, layeredLayout, type Point, textWidth } from '@/components/schema-diagram/layout.ts'
import { FADE, FAINT, TONE_STROKE, type Tone } from '@/components/schema-diagram/overlay.ts'

/** A box of the graph: a session, a row. `sublabel` is a second, quieter line. */
export interface GraphNode {
  id: string
  label: string
  sublabel?: string | undefined
  tone?: Tone | undefined
  badge?: string | undefined
}

/** An arrow from one box to another: what it waits on, what it refers to. */
export interface GraphArrow {
  from: string
  to: string
  label?: string | undefined
  tone?: Tone | undefined
}

const MIN_WIDTH = 140
const MAX_WIDTH = 320
const HEIGHT = 44
const PAD = 40

/**
 * Boxes and arrows, laid out in layers (an arrow mostly runs right to left, to what it points at). A picture only:
 * one image to a screen reader, so the caller puts the same facts in words beside it. With `fadeUntoned`, boxes
 * and arrows that carry no tone are drawn faint, to bring the toned ones forward.
 */
export function NodeGraph({
  nodes,
  arrows,
  label,
  fadeUntoned = false,
}: {
  nodes: readonly GraphNode[]
  arrows: readonly GraphArrow[]
  label: string
  fadeUntoned?: boolean
}) {
  const markerId = `arrow${useId().replace(/\W/g, '')}`
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const drawn = arrows.filter((a) => byId.has(a.from) && byId.has(a.to))
  const widthOf = (id: string) => nodeWidth(byId.get(id))
  const positions = layeredLayout(
    nodes.map((n) => n.id),
    drawn,
    widthOf,
    () => HEIGHT
  )
  const at = (id: string): Point => positions[id] ?? { x: 0, y: 0 }
  const width = Math.max(...nodes.map((n) => at(n.id).x + widthOf(n.id))) + PAD
  const height = Math.max(...nodes.map((n) => at(n.id).y + HEIGHT)) + PAD
  const faint = (tone: Tone | undefined) => (fadeUntoned && !tone ? `${FADE} ${FAINT}` : FADE)
  return (
    <figure tabIndex={0} className="max-h-[70vh] overflow-auto rounded border border-line bg-surface-sub">
      <figcaption className="sr-only">{label}</figcaption>
      <svg width={width} height={height} role="img" aria-label={label} className="select-none">
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-ink-sub" />
          </marker>
        </defs>
        {drawn.map((a, i) => {
          const route = arrowRoute(at(a.from), widthOf(a.from), at(a.to), widthOf(a.to), a.from === a.to)
          const stroke = a.tone ? TONE_STROKE[a.tone] : undefined
          return (
            <g key={i} className={faint(a.tone)} data-tone={a.tone}>
              <path
                d={route.d}
                className={`fill-none ${stroke?.className ?? 'stroke-line-strong'}`}
                strokeWidth={stroke?.width ?? 1.5}
                strokeDasharray={stroke?.dash}
                markerEnd={`url(#${markerId})`}
              />
              {a.label ? (
                <text x={route.mid.x} y={route.mid.y - 6} textAnchor="middle" className="fill-ink-sub text-[10px]">
                  {fitText(a.label, 10, 220)}
                </text>
              ) : null}
            </g>
          )
        })}
        {nodes.map((n) => {
          const p = at(n.id)
          const w = widthOf(n.id)
          const stroke = n.tone ? TONE_STROKE[n.tone] : undefined
          return (
            <g key={n.id} transform={`translate(${p.x} ${p.y})`} className={faint(n.tone)} data-tone={n.tone}>
              <rect
                width={w}
                height={HEIGHT}
                rx={6}
                className={`fill-surface ${stroke?.className ?? 'stroke-line-strong'}`}
                strokeWidth={stroke?.width ?? 1.5}
                strokeDasharray={stroke?.dash}
              />
              <text x={10} y={n.sublabel ? 18 : 27} className="fill-ink text-xs font-semibold">
                {fitText(n.label, 12, w - 20, true)}
                {fitText(n.label, 12, w - 20, true) === n.label ? null : <title>{n.label}</title>}
              </text>
              {n.sublabel ? (
                <text x={10} y={35} className="fill-ink-sub text-[11px]">
                  {fitText(n.sublabel, 11, w - 20)}
                </text>
              ) : null}
              {n.badge ? <Badge text={n.badge} right={w} /> : null}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

/** As wide as the box's longer line needs, within bounds (a longer name is cut, and whole in its tooltip). */
export function nodeWidth(n: GraphNode | undefined): number {
  if (!n) return MIN_WIDTH
  const need = Math.max(textWidth(n.label, 12, true), textWidth(n.sublabel ?? '', 11)) + 20
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(need)))
}

/**
 * An arrow from the side of one box facing the other to the facing side of the other; between boxes of one column,
 * a curve out to the right and back; a box pointing at itself, a loop over its corner.
 */
export function arrowRoute(
  from: Point,
  fromWidth: number,
  to: Point,
  toWidth: number,
  self: boolean
): { d: string; mid: Point } {
  const fy = from.y + HEIGHT / 2
  const ty = to.y + HEIGHT / 2
  if (self) {
    const x = from.x + fromWidth
    return {
      d: `M ${x} ${fy - 8} C ${x + 40} ${fy - 40}, ${x + 40} ${fy + 40}, ${x} ${fy + 8}`,
      mid: { x: x + 30, y: fy },
    }
  }
  if (to.x + toWidth <= from.x) {
    const a = { x: from.x, y: fy }
    const b = { x: to.x + toWidth, y: ty }
    const bend = Math.max(30, (a.x - b.x) / 2)
    return {
      d: `M ${a.x} ${a.y} C ${a.x - bend} ${a.y}, ${b.x + bend} ${b.y}, ${b.x} ${b.y}`,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
  }
  if (from.x + fromWidth <= to.x) {
    const a = { x: from.x + fromWidth, y: fy }
    const b = { x: to.x, y: ty }
    const bend = Math.max(30, (b.x - a.x) / 2)
    return {
      d: `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
  }
  // One column (a cycle cut by the layout): out of the right side and back into it.
  const x = Math.max(from.x + fromWidth, to.x + toWidth)
  const out = 60 + Math.abs(ty - fy) / 4
  return {
    d: `M ${from.x + fromWidth} ${fy} C ${x + out} ${fy}, ${x + out} ${ty}, ${to.x + toWidth} ${ty}`,
    mid: { x: x + out * 0.75, y: (fy + ty) / 2 },
  }
}
