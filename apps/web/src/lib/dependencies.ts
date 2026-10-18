import type { ObjectDependency, TriggerInfo } from '@tsmyadmin/shared'

/** What a node of the dependency graph is. */
export type DependencyKind = 'table' | 'view' | 'routine' | 'trigger'

export interface DependencyNode {
  id: string
  kind: DependencyKind
  name: string
}

/** `from` uses `to`: a view or routine reads it (`reads`), or a trigger is attached to the table (`fires`). */
interface DependencyEdge {
  from: string
  to: string
  kind: 'reads' | 'fires'
}

export interface DependencyGraph {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
}

/** A node's id: kinds have names of their own (a view and a routine may share one). */
export const dependencyId = (kind: DependencyKind, name: string) => JSON.stringify([kind, name])

/**
 * Who uses what among the views, routines and triggers of a namespace, and the tables they use. Only what takes
 * part is a node: a table nothing uses is left out (the Designer draws every table). Trigger bodies are not read
 * (the catalog does not say what they touch), so a trigger is joined to the table it is attached to only.
 */
export function dependencyGraph(
  objects: readonly ObjectDependency[],
  triggers: readonly TriggerInfo[]
): DependencyGraph {
  const nodes = new Map<string, DependencyNode>()
  const add = (kind: DependencyKind, name: string) => {
    const id = dependencyId(kind, name)
    if (!nodes.has(id)) nodes.set(id, { id, kind, name })
    return id
  }
  const edges: DependencyEdge[] = []
  for (const o of objects) {
    const from = add(o.kind, o.name)
    for (const d of o.dependsOn) {
      const to = add(d.kind, d.name)
      if (to !== from && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, kind: 'reads' })
    }
  }
  for (const tg of triggers) edges.push({ from: add('trigger', tg.name), to: add('table', tg.table), kind: 'fires' })
  return { nodes: [...nodes.values()], edges }
}

/**
 * What a change to `id` reaches: everything that uses it, directly or through others that do (a view on a view on
 * the table), each once, in the order they are reached. Not `id` itself.
 */
export function dependentsOf(graph: DependencyGraph, id: string): DependencyNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const reached = new Set<string>([id])
  const out: DependencyNode[] = []
  const queue = [id]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const e of graph.edges) {
      if (e.to !== next || reached.has(e.from)) continue
      reached.add(e.from)
      queue.push(e.from)
      const node = byId.get(e.from)
      if (node) out.push(node)
    }
  }
  return out
}
