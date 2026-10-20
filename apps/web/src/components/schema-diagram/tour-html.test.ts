import { describe, expect, it } from 'vitest'
import { relation } from '@/test/schema-fixtures.ts'
import { diagramFor } from './overlay.ts'
import { overlay, type TourScene, whole } from './tour.ts'
import { type TourWords, tourHtml } from './tour-html.ts'

// users ← orders, with a name and words that would break out of the markup or the script were they not escaped.
const odd = 'a</script><b>&"'
const toUsers = relation('orders', ['user_id'], 'users')
const diagram = diagramFor(['users', 'orders', odd], [toUsers])
const scenes: TourScene[] = [
  { title: 'shop', text: 'all of it', frame: [], overlay: whole(true), pulse: [] },
  {
    title: `look at ${odd}`,
    text: '</script><script>alert(1)</script>',
    frame: ['orders', 'users'],
    overlay: overlay({
      tables: [
        ['users', 'focus', '2'],
        ['orders', 'index'],
      ],
      relations: [[toUsers, 'focus']],
      flow: [[toUsers, 'back']],
      columns: [['orders', ['user_id']]],
    }),
    pulse: ['users'],
  },
]
const words: TourWords = {
  lang: 'en',
  title: `Map of ${odd}`,
  label: 'The diagram',
  prev: 'Previous',
  next: 'Next',
  play: 'Play',
  pause: 'Pause',
  narrate: 'Read aloud',
  noVoice: 'No voice',
  stop: '. ',
  keys: 'keys',
  sceneOf: (n, total) => `${n} / ${total}`,
  tones: { focus: 'Looked at', index: 'Refers' },
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const dataOf = (doc: Document) => JSON.parse(doc.getElementById('tour')?.textContent ?? '')

describe('tourHtml', () => {
  const html = tourHtml(diagram, scenes, words)
  const doc = parse(html)

  it('keeps names and words as text: nothing in them ends the script or adds an element', () => {
    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(doc.querySelectorAll('script')).toHaveLength(2)
    expect(doc.querySelector('b')).toBeNull()
    expect(doc.title).toBe(words.title)
    expect([...doc.querySelectorAll('.name')].map((x) => x.textContent)).toContain(odd)
    const data = dataOf(doc)
    expect(data.scenes[1].title).toBe(`look at ${odd}`)
    expect(data.scenes[1].text).toBe('</script><script>alert(1)</script>')
  })

  it('draws the diagram once, and a scene says by number what it lights, flows and marks', () => {
    expect(doc.querySelectorAll('g.t')).toHaveLength(3)
    expect(doc.querySelectorAll('g.k')).toHaveLength(1)
    const [start, look] = dataOf(doc).scenes
    expect(start).toMatchObject({
      n: '1 / 2',
      enter: true,
      fade: false,
      tables: [],
      flow: [],
      said: ['shop.', 'all of it'],
    })
    expect(look).toMatchObject({
      n: '2 / 2',
      fade: true,
      enter: false,
      keys: [[0, 'focus']],
      flow: [[0, 'back']],
      // users is the first box, orders the second; orders lists user_id first.
      cols: [[1, 0]],
      pulse: [0],
      legend: ['focus', 'index'],
    })
    expect(look.tables).toEqual([
      [0, 'focus', '2', expect.any(Number)],
      [1, 'index'],
    ])
  })

  it('frames each scene as the page does: the whole first, then closer on the tables it is about', () => {
    const [start, look] = dataOf(doc).scenes
    expect(doc.querySelector('figure svg')?.getAttribute('viewBox')).toBe(start.view.join(' '))
    expect(look.view[2]).toBeLessThanOrEqual(start.view[2])
  })

  it('names the language, the diagram and the colours of this tour, and nothing it does not use', () => {
    expect(doc.documentElement.lang).toBe('en')
    expect(doc.querySelector('figure svg')?.getAttribute('aria-label')).toBe('The diagram')
    expect([...doc.querySelectorAll('#legend li')].map((li) => li.textContent)).toEqual(['Looked at', 'Refers'])
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
  })

  it('brings the lines in on their path, so a scene that fades them still can', () => {
    // The outer group of a key is what a scene fades: an animation filled forwards on it would undo the fade.
    expect(html).not.toMatch(/\.entering \.k[,{]/)
    expect(html).toMatch(/\.entering \.k \.base/)
  })
})
