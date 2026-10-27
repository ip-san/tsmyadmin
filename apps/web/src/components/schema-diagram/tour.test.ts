import { describe, expect, it } from 'vitest'
import { chaptersOf, openChapter, type TourScene } from './tour.ts'

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

describe('openChapter', () => {
  const scene = (title: string) => ({ title }) as TourScene

  it('opens a chapter on the scene, without changing the scene given, and nothing past the last scene', () => {
    const first = scene('a')
    const scenes = [first, scene('b')]
    openChapter(scenes, 1, 'Two')
    openChapter(scenes, 2, 'None')
    expect(scenes.map((s) => s.chapter)).toEqual([undefined, 'Two'])
    expect(first.chapter).toBeUndefined()
    // A later part told on the same scene (the part before it told nothing) names it.
    openChapter(scenes, 1, 'Later')
    expect(scenes[1]?.chapter).toBe('Later')
  })
})
