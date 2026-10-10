import { describe, expect, it } from 'vitest'
import { groupDependencies, joinParts, str, strOrNull } from './format.ts'

describe('groupDependencies', () => {
  it('groups the rows of one object, in the order they first appear', () => {
    expect(
      groupDependencies([
        { kind: 'view', name: 'v', refKind: 'table', refName: 'a' },
        { kind: 'routine', name: 'r', refKind: 'table', refName: 'b' },
        { kind: 'view', name: 'v', refKind: 'view', refName: 'w' },
      ])
    ).toEqual([
      {
        kind: 'view',
        name: 'v',
        dependsOn: [
          { kind: 'table', name: 'a' },
          { kind: 'view', name: 'w' },
        ],
      },
      { kind: 'routine', name: 'r', dependsOn: [{ kind: 'table', name: 'b' }] },
    ])
  })

  it('keeps a view and a routine of the same name apart', () => {
    const out = groupDependencies([
      { kind: 'view', name: 'x', refKind: 'table', refName: 'a' },
      { kind: 'routine', name: 'x', refKind: 'table', refName: 'a' },
    ])
    expect(out.map((o) => o.kind)).toEqual(['view', 'routine'])
  })

  it('drops an object depending on itself, but not on a different kind of the same name', () => {
    expect(groupDependencies([{ kind: 'view', name: 'x', refKind: 'view', refName: 'x' }])).toEqual([])
    expect(groupDependencies([{ kind: 'routine', name: 'x', refKind: 'routine', refName: 'x' }])).toEqual([])
    expect(groupDependencies([{ kind: 'view', name: 'x', refKind: 'table', refName: 'x' }])).toEqual([
      { kind: 'view', name: 'x', dependsOn: [{ kind: 'table', name: 'x' }] },
    ])
    expect(groupDependencies([{ kind: 'view', name: 'x', refKind: 'view', refName: 'y' }])).toHaveLength(1)
    expect(groupDependencies([])).toEqual([])
  })
})

describe('str, strOrNull and joinParts', () => {
  it('reads nothing as empty or null, and anything else as its text', () => {
    expect(str(null)).toBe('')
    expect(str(undefined)).toBe('')
    expect(str(0)).toBe('0')
    expect(str(false)).toBe('false')
    expect(str('a')).toBe('a')
    expect(strOrNull(null)).toBeNull()
    expect(strOrNull(undefined)).toBeNull()
    expect(strOrNull(0)).toBe('0')
    expect(strOrNull('')).toBe('')
  })

  it('joins the parts that are there with a slash, or gives null when none is', () => {
    expect(joinParts('a', 'b')).toBe('a / b')
    expect(joinParts('a', null, '', undefined, 'b')).toBe('a / b')
    expect(joinParts(null, 'only')).toBe('only')
    expect(joinParts(0, 'x')).toBe('0 / x')
    expect(joinParts(null, undefined, '')).toBeNull()
    expect(joinParts()).toBeNull()
  })
})
