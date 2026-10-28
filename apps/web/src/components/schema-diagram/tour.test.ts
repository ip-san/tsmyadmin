import { describe, expect, it } from 'vitest'
import { chapterAt, chaptersOf, openChapter, sceneNumber, type TourScene } from './tour.ts'

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

describe('chapterAt and sceneNumber', () => {
  const scenes = [{}, { chapter: 'Roles' }, {}, { chapter: 'Hubs' }, {}]
  const w = {
    sceneOf: (n: number, total: number) => `${n} / ${total}`,
    inChapter: (n: number, count: number, title: string) => `chapter ${n} of ${count}: ${title}`,
  }

  it('finds the chapter of a scene, the scenes before the first opener in the first', () => {
    const chapters = chaptersOf(scenes)
    expect(chapterAt(chapters, 0)).toEqual({ n: 1, count: 2, title: 'Roles' })
    expect(chapterAt(chapters, 2)).toEqual({ n: 1, count: 2, title: 'Roles' })
    expect(chapterAt(chapters, 3)).toEqual({ n: 2, count: 2, title: 'Hubs' })
    expect(chapterAt(chapters, 5)).toBeUndefined()
  })

  it('says nothing of a chapter where there is only one, or none', () => {
    expect(chapterAt(chaptersOf([{ chapter: 'One' }, {}]), 1)).toBeUndefined()
    expect(sceneNumber([{ chapter: 'One' }, {}], 1, w)).toBe('2 / 2')
    expect(sceneNumber([{}, {}], 0, w)).toBe('1 / 2')
  })

  it('numbers a scene with its chapter', () => {
    expect(sceneNumber(scenes, 4, w)).toBe('5 / 5 · chapter 2 of 2: Hubs')
  })
})
