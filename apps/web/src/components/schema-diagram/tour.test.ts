import { describe, expect, it } from 'vitest'
import { chaptersOf } from './tour.ts'

describe('chaptersOf', () => {
  it('has none where no scene opens one', () => {
    expect(chaptersOf([{}, {}])).toEqual([])
  })

  it('runs each chapter from the scene that opens it to the next, the scenes before the first in the first', () => {
    expect(chaptersOf([{}, { chapter: 'Roles' }, {}, { chapter: 'Hubs' }, {}, {}])).toEqual([
      { title: 'Roles', from: 0, to: 3 },
      { title: 'Hubs', from: 3, to: 6 },
    ])
    expect(chaptersOf([{ chapter: 'One' }])).toEqual([{ title: 'One', from: 0, to: 1 }])
  })
})
