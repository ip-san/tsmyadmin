import type { ObjectDependency, TriggerInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { dependencyGraph, dependencyId, dependencyLabel, dependentsOf } from './dependencies.ts'

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
      { from: id('trigger', 'audit', 'users'), to: id('table', 'users'), kind: 'fires' },
    ])
  })

  it('keeps triggers of one name on two tables apart (PostgreSQL names them per table)', () => {
    const g = dependencyGraph([], [trigger('stamp', 'users'), trigger('stamp', 'posts')])
    expect(g.nodes.filter((n) => n.kind === 'trigger').map((n) => n.on)).toEqual(['users', 'posts'])
    expect(dependentsOf(g, id('table', 'posts')).map((n) => n.id)).toEqual([id('trigger', 'stamp', 'posts')])
  })

  it('joins a trigger to a view the catalog lists nowhere else, given the names of the views', () => {
    // A view of constants depends on nothing, so the dependency report does not list it.
    const g = dependencyGraph([], [trigger('instead', 'constants')], ['constants'])
    expect(g.edges).toEqual([
      { from: id('trigger', 'instead', 'constants'), to: id('view', 'constants'), kind: 'fires' },
    ])
  })

  it('joins a trigger on a view to the view, not to a table of its name', () => {
    const g = dependencyGraph([view('everyone', ['table', 'users'])], [trigger('instead', 'everyone')])
    expect(g.nodes.filter((n) => n.name === 'everyone').map((n) => n.kind)).toEqual(['view'])
    expect(dependentsOf(g, id('view', 'everyone')).map((n) => n.name)).toEqual(['instead'])
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

describe('dependencyLabel', () => {
  it('names a node by kind and name, and a trigger by its table too', () => {
    const [t1] = dependencyGraph([], [trigger('stamp', 'users')]).nodes.filter((n) => n.kind === 'trigger')
    expect(dependencyLabel(t1 as never)).toBe(locale.dependencies.triggerNamed('stamp', 'users'))
    const users = graph.nodes.find((n) => n.id === id('table', 'users'))
    expect(dependencyLabel(users as never)).toBe(locale.dependencies.named(locale.dependencies.kinds.table, 'users'))
  })
})
