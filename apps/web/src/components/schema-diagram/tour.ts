import type { RelationDef } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'
import { relationKey } from './layout.ts'
import type { DiagramOverlay, Tone } from './overlay.ts'

const t = locale.tour

/** Names said in a sentence; the rest are counted. */
const NAMES_SAID = 6

/** One scene of the tour: where the camera looks, what is lit, and the words said over it. */
export interface TourScene {
  title: string
  text: string
  /** The tables the camera frames; every table when empty. */
  frame: readonly string[]
  overlay: DiagramOverlay
  /** Tables a ring is drawn around as the scene opens: where to look first. */
  pulse: readonly string[]
  /** What the scene says of the design (why it is so, not only what it is), listed under its words. */
  notes?: readonly string[]
  /** Where the design may cost time (an index missing, types that differ), listed after what it says of the design. */
  hints?: readonly string[]
}

/** All a scene says, as it is read aloud: its title, its words, and what it says of the design. */
export const spoken = (scene: Pick<TourScene, 'title' | 'text' | 'notes' | 'hints'>, stop: string = t.stop) =>
  [scene.title, scene.text, ...(scene.notes ?? []), ...(scene.hints ?? [])].filter(Boolean).join(stop)

/** A scene of a video stays long enough to read what it says, and no shorter than a scene that plays on the page. */
const READ_MS_PER_CHAR = 90
const READ_MS = { least: 6000, most: 30000 }
export const readMs = (scene: Pick<TourScene, 'title' | 'text' | 'notes' | 'hints'>) =>
  Math.min(
    READ_MS.most,
    Math.max(
      READ_MS.least,
      [scene.title, scene.text, ...(scene.notes ?? []), ...(scene.hints ?? [])].join('').length * READ_MS_PER_CHAR
    )
  )

/** What a scene lights: tables (with a tone and a badge), keys, keys that flow, and columns marked. */
export interface Lit {
  tables?: readonly (readonly [string, Tone, string?])[]
  relations?: readonly (readonly [RelationDef, Tone])[]
  flow?: readonly (readonly [RelationDef, 'forward' | 'back'])[]
  columns?: readonly (readonly [string, readonly string[]])[]
}

/** The overlay of a scene, from what it lights; anything not named is drawn faint. */
export function overlay({ tables = [], relations = [], flow = [], columns = [] }: Lit): DiagramOverlay {
  const cols = new Map<string, Set<string>>()
  for (const [table, names] of columns) cols.set(table, new Set([...(cols.get(table) ?? []), ...names]))
  return {
    tables: new Map(tables.map(([name, tone, badge]) => [name, { tone, badge }])),
    relations: new Map(relations.map(([r, tone]) => [relationKey(r), tone])),
    columns: cols,
    flow: new Map(flow.map(([r, way]) => [relationKey(r), way])),
  }
}

/** The whole picture, nothing faded: where the tour starts (boxes and lines drawn in) and where it ends. */
export const whole = (enter: boolean): DiagramOverlay => ({
  tables: new Map(),
  relations: new Map(),
  columns: new Map(),
  fade: false,
  enter,
})

/** A few names of a list, and how many more. */
export const said = (names: readonly string[]) => t.names(names.slice(0, NAMES_SAID), names.length - NAMES_SAID)
export const unique = (names: Iterable<string>) => [...new Set(names)]
