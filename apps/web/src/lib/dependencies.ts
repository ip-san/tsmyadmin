import type { ObjectDependency, TriggerInfo } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'

/** What a node of the dependency graph is. */
export type DependencyKind = 'table' | 'view' | 'routine' | 'trigger'

export interface DependencyNode {
  id: string
  kind: DependencyKind
  name: string
  /** A trigger's table: trigger names are unique per table only (PostgreSQL), so it names the trigger too. */
  on?: string | undefined
}

/** `from` uses `to`: a view or routine reads it (`reads`), or a trigger is attached to it (`fires`). */
interface DependencyEdge {
  from: string
  to: string
  kind: 'reads' | 'fires'
}

export interface DependencyGraph {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
}

/** A node as it is named in pictures and sentences: its kind and name, and a trigger's table. */
export const dependencyLabel = (n: DependencyNode): string => {
  const t = locale.dependencies
  return n.on === undefined ? t.named(t.kinds[n.kind], n.name) : t.triggerNamed(n.name, n.on)
}

/** A node's id: kinds have names of their own (a view and a routine may share one), a trigger is its table's. */
export const dependencyId = (kind: DependencyKind, name: string, on?: string) =>
  JSON.stringify(on === undefined ? [kind, name] : [kind, on, name])

/**
 * Who uses what among the views, routines and triggers of a namespace, and the tables they use. Only what takes
 * part is a node: a table nothing uses is left out (the Designer draws every table). Trigger bodies are not read
 * (the catalog does not say what they touch), so a trigger is joined to what it is attached to only: a view when
 * there is a view of that name (PostgreSQL's INSTEAD OF triggers), a table otherwise.
 */
export function dependencyGraph(
  objects: readonly ObjectDependency[],
  triggers: readonly TriggerInfo[],
  /** The views of the namespace (the catalog lists only those that depend on something). */
  viewNames: Iterable<string> = []
): DependencyGraph {
  const nodes = new Map<string, DependencyNode>()
  const add = (kind: DependencyKind, name: string, on?: string) => {
    const id = dependencyId(kind, name, on)
    if (!nodes.has(id)) nodes.set(id, { id, kind, name, ...(on === undefined ? {} : { on }) })
    return id
  }
  const edges = new Map<string, DependencyEdge>()
  const link = (from: string, to: string, kind: DependencyEdge['kind']) => {
    if (from !== to) edges.set(JSON.stringify([from, to]), { from, to, kind })
  }
  for (const o of objects) {
    const from = add(o.kind, o.name)
    for (const d of o.dependsOn) link(from, add(d.kind, d.name), 'reads')
  }
  const views = new Set([...viewNames, ...[...nodes.values()].filter((n) => n.kind === 'view').map((n) => n.name)])
  for (const tg of triggers) {
    link(add('trigger', tg.name, tg.table), add(views.has(tg.table) ? 'view' : 'table', tg.table), 'fires')
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

/**
 * What a change to `id` reaches: everything that uses it, directly or through others that do (a view on a view on
 * the table), each once, in the order they are reached. Not `id` itself.
 */
export function dependentsOf(graph: DependencyGraph, id: string): DependencyNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const users = new Map<string, string[]>()
  for (const e of graph.edges) users.set(e.to, [...(users.get(e.to) ?? []), e.from])
  const reached = new Set<string>([id])
  const out: DependencyNode[] = []
  const queue = [id]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const from of users.get(next) ?? []) {
      if (reached.has(from)) continue
      reached.add(from)
      queue.push(from)
      const node = byId.get(from)
      if (node) out.push(node)
    }
  }
  return out
}
