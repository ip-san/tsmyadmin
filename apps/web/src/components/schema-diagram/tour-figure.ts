import { frameOf } from './camera.ts'
import {
  boxHeight,
  DEFAULT_VIEW,
  fitText,
  HEADER_HEIGHT,
  makeWidthOf,
  ROW_HEIGHT,
  relationKey,
  relationPath,
  textRoom,
  textWidth,
} from './layout.ts'
import { sentences } from './narration.ts'
import { type diagramFor, TONE_STROKE, TONES, type Tone } from './overlay.ts'
import { spoken, type TourScene } from './tour.ts'

export type TourDiagram = ReturnType<typeof diagramFor>

/** The colours of the tones, fixed: the figure is drawn where neither the theme nor the page's stylesheet applies. */
export const COLOUR: Record<Tone, string> = {
  focus: '#4338ca',
  delete: '#b42318',
  nullify: '#b45309',
  blocked: '#1a1c1f',
  index: '#047857',
  scan: '#b45309',
}
export const CAMERA_MS = 900
export const RING = 8
/** Coming in, as on the page: a column of boxes after the one to its left. */
const ENTER_COLUMN = 280
const ENTER_COLUMNS = 10
const ENTER_STEP_MS = 120

export const xml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const round = (n: number) => Math.round(n * 10) / 10

/** When a box at `x` comes in, as the first scene draws the diagram. */
export const enterDelay = (x: number) => Math.min(Math.round(x / ENTER_COLUMN), ENTER_COLUMNS) * ENTER_STEP_MS

/** A scene as numbers into the figure: what it lights (by box and line), where the camera looks, and its words. */
export interface FigureScene {
  n: string
  said: string[]
  notes: readonly string[]
  hints: readonly string[]
  title: string
  text: string
  view: number[]
  fade: boolean
  enter: boolean
  /** `[box, tone]`, or `[box, tone, badge, badge width]`. */
  tables: (readonly [number, Tone] | readonly [number, Tone, string, number])[]
  keys: (readonly [number, Tone])[]
  flow: (readonly [number, 'forward' | 'back'])[]
  /** `[box, column]`: the columns marked. */
  cols: [number, number][]
  pulse: number[]
  legend: Tone[]
}

/** The figure of a tour: the diagram as SVG markup drawn once, each box's place and size, and the scenes over it. */
export interface TourFigure {
  /** The lines, the boxes, and an empty group for the rings. */
  markup: string
  /** `[x, y, width, height]` of each box. */
  boxes: [number, number, number, number][]
  /** When the lines come in, after the last column of boxes. */
  linesDelay: number
  scenes: FigureScene[]
}

/**
 * A tour as a figure that plays without the page: the diagram drawn once with the classes its scenes switch, and the
 * scenes as numbers into it. Names and words are escaped where they go into the markup; the scenes carry them as text.
 */
export function tourFigure(
  diagram: TourDiagram,
  scenes: readonly TourScene[],
  w: { sceneOf: (n: number, total: number) => string; stop: string }
): TourFigure {
  const at = (table: string) => diagram.positions[table] ?? { x: 0, y: 0 }
  const listed = (table: string) => diagram.columns.get(table) ?? []
  const widthOf = makeWidthOf(diagram)
  const size = (table: string) => ({ width: widthOf(table), height: boxHeight(listed(table).length) })
  const tableIndex = new Map(diagram.tables.map((x, i) => [x, i]))
  const keyIndex = new Map(diagram.relations.map((r, i) => [relationKey(r), i]))
  const view = DEFAULT_VIEW
  const linesDelay = Math.max(0, ...diagram.tables.map((x) => enterDelay(at(x).x))) + ENTER_STEP_MS

  const lines = diagram.relations.map((r, i) => {
    const d = relationPath(r, at, listed, view.lineStyle, view.compact, widthOf)
    return `<g class="k" data-k="${i}"><path class="base" d="${d}" style="animation-delay:${linesDelay}ms"/><path class="fl" d="${d}"/></g>`
  })
  const boxes = diagram.tables.map((name, i) => {
    const p = at(name)
    const room = textRoom(8, widthOf(name))
    const cut = (full: string, bold: boolean) => {
      const fitted = fitText(full, 12, room, bold)
      return fitted === full ? xml(full) : `${xml(fitted)}<title>${xml(full)}</title>`
    }
    const rows = listed(name).map((c, j) => {
      const y = HEADER_HEIGHT + j * ROW_HEIGHT
      return `<g class="c"><rect class="mk" x="1" y="${y}" width="${widthOf(name) - 2}" height="${ROW_HEIGHT}"/><text x="8" y="${y + 14}">${cut(c, false)}</text></g>`
    })
    return [
      `<g class="t" data-t="${i}" transform="translate(${p.x} ${p.y})"><g class="in" style="animation-delay:${enterDelay(p.x)}ms">`,
      `<rect class="box" width="${widthOf(name)}" height="${size(name).height}" rx="4"/>`,
      `<text class="name" x="8" y="18">${cut(name, true)}</text>`,
      `<line class="sep" x1="0" x2="${widthOf(name)}" y1="${HEADER_HEIGHT}" y2="${HEADER_HEIGHT}"/>`,
      ...rows,
      '<g class="badge" display="none"><rect height="18" rx="9"/><text y="13"></text></g>',
      '</g></g>',
    ].join('')
  })

  return {
    markup: [...lines, ...boxes, '<g id="rings" aria-hidden="true"></g>'].join('\n'),
    boxes: diagram.tables.map((x) => [at(x).x, at(x).y, size(x).width, size(x).height]),
    linesDelay,
    scenes: scenes.map((s, n) => {
      const frame = frameOf(s.frame, diagram.tables, at, size)
      const lit = [...s.overlay.tables].flatMap(([name, { tone, badge }]): FigureScene['tables'] => {
        const i = tableIndex.get(name)
        if (i === undefined) return []
        if (!badge) return [[i, tone]]
        const width = Math.min(widthOf(name), Math.ceil(textWidth(badge, 11, true) + 14))
        return [[i, tone, fitText(badge, 11, width - 8), width]]
      })
      const keyed = <T>(m: ReadonlyMap<string, T> | undefined) =>
        [...(m ?? [])].flatMap(([key, v]) => {
          const i = keyIndex.get(key)
          return i === undefined ? [] : [[i, v] as const]
        })
      return {
        n: w.sceneOf(n + 1, scenes.length),
        said: sentences(spoken(s, w.stop)),
        notes: s.notes ?? [],
        hints: s.hints ?? [],
        title: s.title,
        text: s.text,
        view: [frame.x, frame.y, frame.width, frame.height].map(round),
        fade: s.overlay.fade !== false,
        enter: s.overlay.enter === true,
        tables: lit,
        keys: keyed(s.overlay.relations),
        flow: keyed(s.overlay.flow),
        cols: [...s.overlay.columns].flatMap(([table, names]) => {
          const i = tableIndex.get(table)
          return i === undefined
            ? []
            : listed(table).flatMap((c, j): [number, number][] => (names.has(c) ? [[i, j]] : []))
        }),
        pulse: s.pulse.flatMap((x) => tableIndex.get(x) ?? []),
        legend: TONES.filter(
          (tone) =>
            [...s.overlay.tables.values()].some((x) => x.tone === tone) ||
            [...s.overlay.relations.values()].includes(tone)
        ),
      }
    }),
  }
}

const toneStyles = TONES.map((tone) => {
  const s = TONE_STROKE[tone]
  const rule = `stroke:${COLOUR[tone]};stroke-width:${s.width}${s.dash ? `;stroke-dasharray:${s.dash}` : ''}`
  return `.t.tone-${tone} .box,.k.tone-${tone} .base,line.k.tone-${tone}{${rule}}`
}).join('\n')

/** How the figure is drawn: the boxes, the lines, the tones and what moves. */
export const FIGURE_STYLE = `
.k .base,line.k{fill:none;stroke:#4338ca;stroke-width:1.5}
.k .fl{display:none;fill:none;stroke:#4338ca;stroke-width:4;stroke-linecap:round;stroke-dasharray:2 14}
.k.flow .fl{display:inline;animation:flow .9s linear 5}
.k.back .fl{animation-direction:reverse}
.box{fill:#fff;stroke:#83898f;stroke-width:1.5}
.name{font-size:12px;font-weight:600;fill:#1a1c1f}
.c text{font-size:12px;fill:#5b616b}
.c .mk{fill:transparent}
.c.on .mk{fill:#eef0fb}
.c.on text{fill:#1a1c1f;font-weight:600}
.sep{stroke:#e3e5e8}
.badge rect{fill:#fff;stroke:#83898f}
.badge text{font-size:11px;font-weight:600;fill:#1a1c1f;text-anchor:middle}
.t,.k{transition:opacity .3s}
.faint{opacity:.3}
${toneStyles}
.ring{fill:none;stroke:#4338ca;stroke-width:4;transform-box:fill-box;transform-origin:center;animation:pulse 1.2s ease-out 2 forwards}
/* On the boxes' inner group and the lines' path: the outer group is the one a scene fades. */
.entering .in,.entering .k .base{opacity:0;animation:enter .5s ease-out forwards}
@keyframes enter{from{opacity:0}to{opacity:1}}
@keyframes flow{to{stroke-dashoffset:-32}}
@keyframes pulse{from{opacity:.9;transform:scale(1)}to{opacity:0;transform:scale(1.18)}}
`
