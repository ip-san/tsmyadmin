import type { ObjectDependency, TriggerInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { dependencyGraph, dependencyId, dependentsOf } from './dependencies.ts'

const view = (name: string, ...on: [ObjectDependency['dependsOn'][number]['kind'], string][]): ObjectDependency => ({
  kind: 'view',
  name,
  dependsOn: on.map(([kind, n]) => ({ kind, name: n })),
})
const trigger = (name: string, table: string) => ({ name, table }) as TriggerInfo

// active_users reads users; recent reads active_users and posts; calc (a routine) reads posts.
const objects: ObjectDependency[] = [
  view('active_users', ['table', 'users']),
  view('recent', ['view', 'active_users'], ['table', 'posts'], ['table', 'posts']),
  { kind: 'routine', name: 'calc', dependsOn: [{ kind: 'table', name: 'posts' }] },
]
const graph = dependencyGraph(objects, [trigger('audit', 'users')])
const id = dependencyId

describe('dependencyGraph', () => {
  it('has a node for each object and table that takes part, and an edge from the user to what it uses, once', () => {
    expect(graph.nodes.map((n) => `${n.kind}:${n.name}`).sort()).toEqual([
      'routine:calc',
      'table:posts',
      'table:users',
      'trigger:audit',
      'view:active_users',
      'view:recent',
    ])
    expect(graph.edges.filter((e) => e.from === id('view', 'recent')).map((e) => e.to)).toEqual([
      id('view', 'active_users'),
      id('table', 'posts'),
    ])
  })

  it('joins a trigger to its table only, as firing on it', () => {
    expect(graph.edges.filter((e) => e.kind === 'fires')).toEqual([
      { from: id('trigger', 'audit'), to: id('table', 'users'), kind: 'fires' },
    ])
  })

  it('tells a view and a routine of one name apart, and leaves out an object depending on itself', () => {
    const g = dependencyGraph([view('same', ['view', 'same']), { kind: 'routine', name: 'same', dependsOn: [] }], [])
    expect(g.nodes).toHaveLength(2)
    expect(g.edges).toEqual([])
  })
})

describe('dependentsOf', () => {
  it('reaches what uses a table directly and through views on it, each once, not the table', () => {
    expect(dependentsOf(graph, id('table', 'users')).map((n) => n.name)).toEqual(['active_users', 'audit', 'recent'])
    expect(dependentsOf(graph, id('table', 'posts')).map((n) => n.name)).toEqual(['recent', 'calc'])
  })

  it('reaches nothing from what nothing uses, and stops in a cycle', () => {
    expect(dependentsOf(graph, id('view', 'recent'))).toEqual([])
    const cycle = dependencyGraph([view('a', ['view', 'b']), view('b', ['view', 'a'])], [])
    expect(dependentsOf(cycle, id('view', 'a')).map((n) => n.name)).toEqual(['b'])
  })
})
