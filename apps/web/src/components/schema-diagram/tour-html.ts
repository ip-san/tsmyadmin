import { TONES, type Tone } from './overlay.ts'
import type { TourScene } from './tour.ts'
import { CAMERA_MS, FIGURE_STYLE, RING, type TourDiagram, tourFigure, xml } from './tour-figure.ts'

/** The words of the file, in the language of the page it was saved from. */
export interface TourWords {
  lang: string
  title: string
  /** What the diagram is, for a screen reader. */
  label: string
  prev: string
  next: string
  play: string
  pause: string
  narrate: string
  noVoice: string
  /** The headings of what a scene says of the design, and of where it may cost time. */
  notes: string
  hints: string
  /** What ends a sentence: the title is read as one before the words. */
  stop: string
  keys: string
  sceneOf: (n: number, total: number) => string
  /** What each colour means on this tour. */
  tones: Partial<Record<Tone, string>>
}

const SCENE_MS = 6000

/** JSON that can sit in a `<script>`: a name with `</script>` in it does not end it. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/**
 * A tour as one HTML file that plays on its own, with no server and nothing fetched: the diagram drawn once, and the
 * scenes as data a short script lays over it (the camera's frame, what is lit, the words). The same keys as on the
 * page; a reader who has asked for less motion is shown each scene still. Names and words are escaped where they go.
 */
export function tourHtml(diagram: TourDiagram, scenes: readonly TourScene[], w: TourWords): string {
  const figure = tourFigure(diagram, scenes, w)
  const data = {
    boxes: figure.boxes,
    play: w.play,
    pause: w.pause,
    sceneMs: SCENE_MS,
    lang: w.lang,
    noVoice: w.noVoice,
    cameraMs: CAMERA_MS,
    ring: RING,
    scenes: figure.scenes,
  }
  const first = data.scenes[0]?.view ?? [0, 0, 720, 420]
  const legend = TONES.filter((tone) => w.tones[tone] !== undefined).map(
    (tone) =>
      `<li data-tone="${tone}" hidden><svg width="28" height="10" aria-hidden="true"><line class="k tone-${tone}" x1="2" x2="26" y1="5" y2="5"/></svg>${xml(w.tones[tone] ?? '')}</li>`
  )
  return `<!doctype html>
<html lang="${xml(w.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xml(w.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${xml(w.title)}</h1></header>
<main>
<figure><svg role="img" aria-label="${xml(w.label)}" viewBox="${first.join(' ')}" preserveAspectRatio="xMidYMid meet">
${figure.markup}
</svg></figure>
<ul id="legend">${legend.join('')}</ul>
<section aria-live="polite" aria-atomic="true" tabindex="0"><p id="n"></p><h2 id="h"></h2><p id="x"></p><div id="notes" class="list" hidden><h3>${xml(w.notes)}</h3><ul></ul></div><div id="hints" class="list" hidden><h3>${xml(w.hints)}</h3><ul></ul></div></section>
<nav><button type="button" id="prev">${xml(w.prev)}</button> <button type="button" id="play">${xml(w.play)}</button> <button type="button" id="next">${xml(w.next)}</button> <button type="button" id="narrate" aria-pressed="false">${xml(w.narrate)}</button></nav>
<p id="voice" role="status"></p>
<p class="keys">${xml(w.keys)}</p>
</main>
<script type="application/json" id="tour">${scriptJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

const STYLE = `${FIGURE_STYLE}
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;padding:16px;gap:12px;font-family:system-ui,sans-serif;background:#f4f5f7;color:#1a1c1f}
h1{margin:0;font-size:14px;color:#5b616b}
main{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px}
figure{flex:1;min-height:0;margin:0;border:1px solid #e3e5e8;border-radius:4px;background:#f7f8f9}
figure svg{display:block;width:100%;height:100%}
#legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;padding:0;list-style:none;font-size:12px;color:#5b616b}
#legend li{display:flex;align-items:center;gap:6px}
#legend li[hidden]{display:none}
section{min-height:9rem}
#voice{margin:0;font-size:14px}
#n{margin:0;font-size:14px;color:#5b616b}
#h{margin:4px 0;font-size:24px}
#x{margin:0;font-size:18px}
#notes h3,#hints h3{margin:8px 0 2px;font-size:14px;color:#4338ca}
#hints h3{color:#b42318}
.list ul{margin:0;padding-left:20px;font-size:16px}
button{font:inherit;font-size:14px;padding:4px 12px;border:1px solid #83898f;border-radius:8px;background:#fff;color:#1a1c1f;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
button:focus-visible{outline:2px solid #4338ca;outline-offset:2px}
.keys{margin:0;font-size:12px;color:#5b616b}
@media (min-width:1024px){
main{display:grid;grid-template-columns:minmax(0,1fr) 28rem;grid-template-rows:minmax(0,1fr) auto auto auto auto}
figure{grid-column:1;grid-row:1}
#legend{grid-column:1;grid-row:2}
section{grid-column:2;grid-row:1/3;overflow-y:auto}
nav,#voice,.keys{grid-column:1/3}
}
@media (prefers-reduced-motion:reduce){
.k.flow .fl,.ring,.entering .in,.entering .k .base{animation:none}
.entering .in,.entering .k .base{opacity:1}
.ring{opacity:0}
.t,.k{transition:none}
}
`

/** Lays each scene over the diagram. Text goes in as text (`textContent`), never as markup. */
const SCRIPT = `
(function () {
  var D = JSON.parse(document.getElementById('tour').textContent)
  var svg = document.querySelector('figure svg')
  var T = svg.querySelectorAll('.t'), K = svg.querySelectorAll('g.k'), rings = document.getElementById('rings')
  var prev = document.getElementById('prev'), next = document.getElementById('next'), play = document.getElementById('play')
  var still = window.matchMedia('(prefers-reduced-motion: reduce)')
  var NS = 'http://www.w3.org/2000/svg'
  var i = 0, timer = null, frame = 0, view = D.scenes[0].view.slice()
  function setView(v) { svg.setAttribute('viewBox', v.join(' ')) }
  function move(to) {
    cancelAnimationFrame(frame)
    if (still.matches) { view = to.slice(); setView(view); return }
    var from = view.slice(), t0 = performance.now()
    function step(now) {
      var k = Math.min(1, (now - t0) / D.cameraMs)
      var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      view = from.map(function (a, j) { return a + (to[j] - a) * e })
      setView(view)
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }
  function show(n) {
    i = Math.max(0, Math.min(D.scenes.length - 1, n))
    var s = D.scenes[i], lit = {}, on = {}, fl = {}, cols = {}
    s.tables.forEach(function (x) { lit[x[0]] = x })
    s.keys.forEach(function (x) { on[x[0]] = x[1] })
    s.flow.forEach(function (x) { fl[x[0]] = x[1] })
    s.cols.forEach(function (x) { (cols[x[0]] = cols[x[0]] || {})[x[1]] = true })
    T.forEach(function (g, t) {
      var l = lit[t]
      g.setAttribute('class', 't' + (l ? ' tone-' + l[1] : '') + (s.fade && !l ? ' faint' : ''))
      g.querySelectorAll('.c').forEach(function (c, j) { c.setAttribute('class', cols[t] && cols[t][j] ? 'c on' : 'c') })
      var b = g.querySelector('.badge')
      if (l && l[2]) {
        b.removeAttribute('display')
        b.setAttribute('transform', 'translate(' + (D.boxes[t][2] - l[3]) + ' -10)')
        b.firstChild.setAttribute('width', l[3])
        b.lastChild.setAttribute('x', l[3] / 2)
        b.lastChild.textContent = l[2]
      } else b.setAttribute('display', 'none')
    })
    K.forEach(function (g, k) {
      g.setAttribute('class', 'k' + (on[k] ? ' tone-' + on[k] : '') + (s.fade && !on[k] ? ' faint' : '') +
        (fl[k] ? ' flow' + (fl[k] === 'back' ? ' back' : '') : ''))
      var f = g.querySelector('.fl')
      g.replaceChild(f.cloneNode(), f)
    })
    svg.classList.remove('entering')
    if (s.enter) { void svg.getBoundingClientRect(); svg.classList.add('entering') }
    rings.textContent = ''
    s.pulse.forEach(function (t) {
      var b = D.boxes[t], r = document.createElementNS(NS, 'rect')
      r.setAttribute('class', 'ring')
      r.setAttribute('x', b[0] - D.ring); r.setAttribute('y', b[1] - D.ring)
      r.setAttribute('width', b[2] + 2 * D.ring); r.setAttribute('height', b[3] + 2 * D.ring); r.setAttribute('rx', 10)
      rings.appendChild(r)
    })
    document.querySelectorAll('#legend li').forEach(function (li) {
      li.hidden = s.legend.indexOf(li.getAttribute('data-tone')) < 0
    })
    document.getElementById('n').textContent = s.n
    document.getElementById('h').textContent = s.title
    document.getElementById('x').textContent = s.text
    ;[['notes', s.notes], ['hints', s.hints]].forEach(function (p) {
      var box = document.getElementById(p[0]), list = box.querySelector('ul')
      list.textContent = ''
      p[1].forEach(function (n) { var li = document.createElement('li'); li.textContent = n; list.appendChild(li) })
      box.hidden = p[1].length === 0
    })
    prev.disabled = i === 0
    next.disabled = i === D.scenes.length - 1
    move(s.view)
    speak()
  }
  // Read aloud only in a voice the device speaks itself: one that is not sends the words (the names) out.
  var synth = window.speechSynthesis || null, voice = null, narrating = false, reading = 0, held = null
  function pickVoice() {
    var fits = (synth ? synth.getVoices() : []).filter(function (v) {
      return v.localService && v.lang.toLowerCase().split(/[-_]/)[0] === D.lang
    })
    var now = fits.filter(function (v) { return v.default })[0] || fits[0] || null
    var same = voice && now && voice.name === now.name && voice.lang === now.lang
    if (same) return
    voice = now
    // Voices listed late (Chrome): reading asked for before they came starts now.
    if (narrating) { said(); speak(); schedule() }
  }
  if (synth) { pickVoice(); synth.addEventListener('voiceschanged', pickVoice) }
  var reads = function () { return narrating && voice !== null }
  // A sentence at a time (a long one is cut off by some browsers); a scene read through moves on while playing.
  function speak() {
    if (!synth) return
    var mine = ++reading, parts = D.scenes[i].said, k = 0
    synth.cancel()
    if (!reads()) return
    ;(function say() {
      if (mine !== reading) return
      if (k >= parts.length) { if (playing) step(); return }
      // Held while read: Chrome can let an utterance nothing holds go before its end is heard.
      var u = held = new SpeechSynthesisUtterance(parts[k++])
      u.voice = voice; u.lang = voice.lang; u.onend = say
      // A voice that fails: the scene's time instead, rather than rushing on through every scene.
      u.onerror = function (e) {
        if (mine !== reading || e.error === 'canceled' || e.error === 'interrupted' || !playing) return
        clearTimeout(timer)
        timer = setTimeout(step, D.sceneMs)
      }
      synth.speak(u)
    })()
  }
  var playing = false
  // Read aloud, a scene lasts as long as its words; otherwise its time.
  function schedule() { clearTimeout(timer); timer = playing && !reads() ? setTimeout(step, D.sceneMs) : null }
  // As on the page: the last scene shown stops playing (the button says Play at once).
  function step() {
    show(i + 1)
    if (i >= D.scenes.length - 1) stop(); else schedule()
  }
  function stop() { playing = false; clearTimeout(timer); timer = null; play.textContent = D.play }
  // One scene does not play; played, the scene shown is read again before the next.
  function toggle() {
    // Paused, the voice stops too.
    if (playing) { stop(); reading++; if (synth) synth.cancel(); return }
    if (D.scenes.length < 2) return
    playing = true
    play.textContent = D.pause
    if (i === D.scenes.length - 1) show(0); else speak()
    schedule()
  }
  var narrate = document.getElementById('narrate')
  function said() { document.getElementById('voice').textContent = narrating && !voice ? D.noVoice : '' }
  narrate.onclick = function () {
    narrating = !narrating
    narrate.setAttribute('aria-pressed', String(narrating))
    said()
    speak()
    schedule()
  }
  function full() {
    var asked = document.fullscreenElement ? document.exitFullscreen()
      : document.documentElement.requestFullscreen ? document.documentElement.requestFullscreen() : null
    if (asked) asked.catch(function () {})
  }
  // Moved by hand, it stops playing, as on the page: the next scene does not come while this one is read.
  function go(n) { stop(); show(n) }
  prev.onclick = function () { go(i - 1) }
  next.onclick = function () { go(i + 1) }
  play.onclick = toggle
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    var onButton = e.target instanceof HTMLButtonElement
    var key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    var act = {
      ArrowRight: function () { go(i + 1) }, PageDown: function () { go(i + 1) },
      ArrowLeft: function () { go(i - 1) }, PageUp: function () { go(i - 1) },
      Home: function () { go(0) }, End: function () { go(D.scenes.length - 1) },
      ' ': onButton ? null : function () { go(i + 1) }, p: toggle, f: full
    }[key]
    if (!act) return
    e.preventDefault()
    act()
  })
  show(0)
  // As on the page: it plays from the start, unless the reader has asked for less motion.
  if (!still.matches) toggle()
})()
`
