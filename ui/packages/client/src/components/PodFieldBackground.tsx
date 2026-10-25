import { useEffect, useRef } from "react"

/**
 * The onboarding wizard's animated ASCII "pod field" (GH #318): a dim monospace
 * glyph scene — stickman with phone, wireless claim arc, hub, pods, wires with
 * traveling signals, a house with wifi arcs, radio rings — behind the wizard.
 * Ported as-is from the approved standalone prototype (variant 5 "everything"),
 * so it stays visually diffable against it. Vanilla canvas, no dependencies.
 *
 * Behavior contract (issue #318): DPR-aware; one static frame under
 * prefers-reduced-motion; the loop is not scheduled while the tab is hidden
 * (rAF stops firing) and dies with the component (fixed inset-0 layer, so it
 * cannot be off-screen while mounted — unmount is the off-screen pause).
 */

// Cell size in CSS pixels; the whole scene is laid out on this glyph grid.
const CW = 9
const CH = 16
const SMALL_FONT = "13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
const BIG_FONT = "26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
const BIG = 2

// Variant 5 "everything" from the prototype: man + phone, hub, 6 pods, a house,
// every signal type. Rates tuned there; density/speed tweaks are in-bounds.
const CFG = {
  dots: 1.1, pods: 6, houses: [{ fx: 0.82, fy: 0.6 }], man: { fx: 0.18, fy: 0.5 },
  hub: { fx: 0.5, fy: 0.32 }, wifi: true, phoneLink: true, houseWires: true, ringRate: 7, sigRate: 1.6,
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const ri = (a: number, b: number) => Math.floor(rnd(a, b + 1))
const DIM = (a: number) => `rgba(125,153,168,${a})`
const CYAN = (a: number) => `rgba(110,231,255,${a})`
const GREEN = (a: number) => `rgba(60,181,74,${a})`
const AMBER = (a: number) => `rgba(217,193,74,${a})`
const VIOLET = (a: number) => `rgba(180,74,224,${a})`

const SPRITES = {
  man: [
    " _\\|/^",
    "  (_oo /",
    " /-|--/",
    " \\ |",
    "   /--i",
    "  /   L",
    "  L",
  ],
  phone: [".-.", "|:|", "|:|", "'-'"],
  house: ["  /\\  ", " /  \\ ", "/----\\", "|[][]|", "|_[]_|"],
} as const

type Cell = { x: number; y: number }
type Glyph = Cell & { g: string; v?: boolean }
type Sprite = { x: number; y: number; s: number }
type Wire = { cells: Glyph[]; len: number }
type Signal = { w: Wire; dir: 1 | -1; t: number; v: number; col: (a: number) => string }
type Ring = { x: number; y: number; r: number; life: number; up?: boolean; wifi?: boolean }
type Link = { pts: Cell[]; signals: { t: number; v: number }[] }
type Dot = { x: number; y: number; base: number; ph: number }

function spriteCells(s: Sprite, rowsArr: readonly string[]) {
  const out: { cx: number; cy: number; ch: string }[] = []
  rowsArr.forEach((line, sy) => [...line].forEach((ch, sx) => {
    if (ch !== " ") out.push({ cx: s.x + sx * s.s, cy: s.y + sy * s.s, ch })
  }))
  return out
}

/** Dim L-path between two cells with a chamfered corner (the `-|/` wires). */
function mkPath(a: Cell, b: Cell): Wire {
  const cells: Glyph[] = []
  let x = a.x, y = a.y
  const sx = Math.sign(b.x - a.x), sy = Math.sign(b.y - a.y)
  const corner = { x: Math.round((a.x + b.x) / 2), y: b.y }
  while (x !== corner.x) { x += sx; cells.push({ x, y, g: "-" }) }
  while (y !== corner.y) { y += sy; cells.push({ x, y, g: "|", v: true }) }
  const hEnd = cells.findIndex(c => c.v)
  if (hEnd >= 2) {
    const c2 = cells[hEnd - 1], c3 = cells[hEnd]
    c2.g = (sx > 0) === (c3.y < c2.y) ? "\\" : "/"
  }
  while (x !== b.x) { x += sx; cells.push({ x, y, g: "-" }) }
  return { cells, len: cells.length }
}

/** Quadratic bezier over the glyph grid — the phone→hub wireless claim arc. */
function bez(p0: Cell, p1: Cell, p2: Cell, n: number): Cell[] {
  const pts: Cell[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t
    pts.push({ x: Math.round(u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x),
               y: Math.round(u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y) })
  }
  return pts
}

export function PodFieldBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    // jsdom (unit tests) has no canvas implementation — stay inert there.
    if (!ctx) return

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    let dpr = 1, cols = 0, rows = 0
    const cellPos = (fx: number, fy: number): Cell =>
      ({ x: Math.round(fx * cols), y: Math.round(fy * rows) })

    const devices: Cell[] = []
    const wires: Wire[] = []
    const signals: Signal[] = []
    const rings: Ring[] = []
    const links: Link[] = []
    let dots: Dot[] = []
    let man: Sprite | null = null
    let phone: Sprite | null = null
    let houses: (Sprite & { antenna: Cell; w: number })[] = []
    let hub: { pos: Cell }
    const pointer = { x: -999, y: -999 }

    function build() {
      devices.length = 0; wires.length = 0; signals.length = 0; rings.length = 0; links.length = 0
      dots = []; houses = []
      const mx = Math.max(8, Math.floor(cols * .14)), my = Math.max(5, Math.floor(rows * .14))

      hub = { pos: cellPos(CFG.hub.fx, CFG.hub.fy) }
      hub.pos.y = Math.max(my + 2, Math.min(rows - my - 2, hub.pos.y))

      const p = cellPos(CFG.man.fx, CFG.man.fy)
      man = { x: p.x, y: p.y, s: BIG }
      phone = { x: p.x + 8 * BIG, y: p.y + BIG, s: 1 } // in the outstretched hand

      for (const h of CFG.houses) {
        const hp = cellPos(h.fx, h.fy)
        const hs = { x: hp.x, y: hp.y, s: BIG, w: 7 * BIG, antenna: { x: hp.x + 3 * BIG, y: hp.y - 2 } }
        houses.push(hs)
      }

      let guard = 0
      while (devices.length < CFG.pods && guard++ < 300) {
        const x = ri(mx, cols - mx), y = ri(my, rows - my)
        let ok = Math.abs(x - hub.pos.x) > cols * .14 || Math.abs(y - hub.pos.y) > rows * .2
        for (const d of devices) if (Math.abs(d.x - x) < 10 && Math.abs(d.y - y) < 6) ok = false
        if (phone && Math.abs(x - phone.x) < 8 && Math.abs(y - phone.y) < 7) ok = false
        if (ok) devices.push({ x, y })
      }
      for (const d of devices) wires.push(mkPath(d, hub.pos))
      for (const hs of houses) wires.push(mkPath({ x: hs.x + hs.w + 1, y: hs.y + 3 * BIG }, hub.pos))

      const p0 = { x: phone.x + 3, y: phone.y - 1 }
      const p2 = { x: hub.pos.x, y: hub.pos.y }
      const p1 = { x: (p0.x + p2.x) >> 1, y: Math.min(p0.y, p2.y) - Math.max(6, Math.floor(rows * .18)) }
      links.push({ pts: bez(p0, p1, p2, 34), signals: [] })

      const density = Math.floor(cols * rows / 110) * CFG.dots
      for (let i = 0; i < density; i++)
        dots.push({ x: ri(0, cols - 1), y: ri(0, rows - 1), base: rnd(.04, .10), ph: rnd(0, 6.28) })
    }

    // Arrow consts (not hoisted declarations) so the non-null narrowing of
    // canvas/ctx above holds inside them.
    const resize = () => {
      dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = window.innerWidth + "px"
      canvas.style.height = window.innerHeight + "px"
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = SMALL_FONT
      ctx.textBaseline = "top"
      cols = Math.ceil(window.innerWidth / CW)
      rows = Math.ceil(window.innerHeight / CH)
      build()
    }

    let lastSpawn = 0, lastRing = 0, lastWifi = 0, lastPulse = 0
    function step(dt: number, now: number) {
      if (now - lastSpawn > rnd(240, 700) / CFG.sigRate) {
        lastSpawn = now
        if (wires.length) {
          const w = wires[ri(0, wires.length - 1)]
          const dir = Math.random() < .5 ? 1 : -1
          const roll = Math.random()
          signals.push({ w, dir: dir as 1 | -1, t: dir > 0 ? 0 : 1, v: rnd(.6, 1.4) / w.len * dir,
            col: roll < .62 ? CYAN : roll < .78 ? AMBER : roll < .9 ? GREEN : VIOLET })
        }
      }
      if (now - lastPulse > rnd(500, 1100) / CFG.sigRate) {
        lastPulse = now
        for (const L of links) L.signals.push({ t: 0, v: rnd(.25, .45) })
      }
      for (const L of links)
        for (let i = L.signals.length - 1; i >= 0; i--) {
          L.signals[i].t += L.signals[i].v * dt
          if (L.signals[i].t > 1) L.signals.splice(i, 1)
        }
      if (now - lastRing > 5000 / CFG.ringRate) {
        lastRing = now
        const emitters = devices.map(d => ({ x: d.x, y: d.y }))
        emitters.push({ x: hub.pos.x, y: hub.pos.y })
        const e = emitters[ri(0, emitters.length - 1)]
        rings.push({ x: e.x, y: e.y, r: 1.5, life: 1 })
      }
      if (CFG.wifi && houses.length && now - lastWifi > 2200) {
        lastWifi = now
        const hs = houses[ri(0, houses.length - 1)]
        rings.push({ x: hs.antenna.x, y: hs.antenna.y, r: 1, life: 1, up: true, wifi: true })
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i]
        r.r += dt * (r.wifi ? 5 : 7); r.life -= dt * (r.wifi ? .5 : .22)
        if (r.life <= 0) rings.splice(i, 1)
      }
      for (let i = signals.length - 1; i >= 0; i--) {
        const s = signals[i]
        s.t += s.v * dt
        if (s.t < -.05 || s.t > 1.05) signals.splice(i, 1)
      }
    }

    const glyph = (ch: string, x: number, y: number, style: string, big?: boolean) => {
      if (big) ctx.font = BIG_FONT
      ctx.fillStyle = style
      ctx.fillText(ch, x * CW, y * CH)
      if (big) ctx.font = SMALL_FONT
    }
    function nearPointer(x: number, y: number) {
      const dx = x - pointer.x, dy = y - pointer.y, d2 = dx * dx + dy * dy
      return d2 < 64 ? (1 - d2 / 64) * .16 : 0
    }

    const paint = (now: number) => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
      for (const d of dots) {
        const a = d.base + .03 * Math.sin(now / 900 + d.ph) + nearPointer(d.x, d.y)
        if (a > .02) glyph("·", d.x, d.y, DIM(a))
      }
      for (const w of wires)
        for (const c of w.cells) glyph(c.g, c.x, c.y, DIM(.10 + nearPointer(c.x, c.y)))
      for (const L of links) {
        L.pts.forEach((p, i) => { if (i % 2 === 0) glyph("˙", p.x, p.y, DIM(.08 + nearPointer(p.x, p.y))) })
        for (const s of L.signals) {
          const idx = Math.floor(s.t * (L.pts.length - 1))
          for (let k = 0; k <= 4; k++) {
            const j = idx - k
            if (j < 0 || j >= L.pts.length) continue
            glyph(k === 0 ? "•" : k < 2 ? "·" : "˙", L.pts[j].x, L.pts[j].y, CYAN(.85 - k * .18))
          }
        }
      }
      for (const r of rings) {
        const a = Math.max(0, r.life) * (r.wifi ? .55 : .5)
        const R = Math.ceil(r.r)
        for (let gy = Math.max(0, (r.y - R - 1) | 0); gy <= Math.min(rows - 1, r.y + R + 1); gy++) {
          if (r.up && gy > r.y) continue
          for (let gx = Math.max(0, (r.x - R * 3 - 1) | 0); gx <= Math.min(cols - 1, r.x + R * 3 + 1); gx++) {
            const dx = (gx - r.x) / 2.1, dy = gy - r.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (Math.abs(dist - r.r) < .6) {
              const ch = r.wifi ? (dx < 0 ? "(" : ")") : (dist < 3 ? "o" : dist < 7 ? "O" : gy < r.y ? "⌒" : "_")
              glyph(ch, gx, gy, (r.wifi ? GREEN : CYAN)(a * (.5 + Math.random() * .5)))
            }
          }
        }
      }
      for (const s of signals) {
        const pos = s.t * s.w.len
        for (let k = 0; k <= 7; k++) {
          const idx = Math.round(pos) - k * s.dir
          if (idx < 0 || idx >= s.w.len) continue
          const c = s.w.cells[idx]
          if (c) glyph(k === 0 ? "◉" : k < 3 ? "+" : k < 5 ? ":" : "·", c.x, c.y, s.col(.9 * (1 - k / 8) + .1))
        }
      }
      // hub
      glyph("⌂", hub.pos.x, hub.pos.y - 2, DIM(.25))
      const on = Math.sin(now / 500) > -0.2
      glyph(on ? "o" : "·", hub.pos.x, hub.pos.y - 3, on ? GREEN(.75) : DIM(.15))
      ;["[", "#", "]"].forEach((ch, i) => glyph(ch, hub.pos.x - 1 + i, hub.pos.y, DIM(.6)))
      ;["—", "—", "—"].forEach((ch, i) => glyph(ch, hub.pos.x - 1 + i, hub.pos.y + 1, DIM(.2)))
      // pods
      for (const d of devices) {
        glyph("^", d.x, d.y - 1, DIM(.22))
        const pon = Math.sin(now / 500 + d.x) > 0
        glyph(pon ? "o" : "·", d.x, d.y - 2, pon ? GREEN(.6) : DIM(.15))
        ;["[", "▪", "]"].forEach((ch, i) => glyph(ch, d.x - 1 + i, d.y, DIM(.5)))
      }
      // houses + antenna + beacon
      for (const hs of houses) {
        const flick = Math.sin(now / 1300 + hs.x) > .55
        for (const c of spriteCells(hs, SPRITES.house)) {
          const bright = "[,],_,/,\\".includes(c.ch) ? .45 : .32
          glyph(c.ch, c.cx, c.cy, DIM(bright + (flick && c.ch === "]" ? .15 : 0)), true)
        }
        glyph("|", hs.antenna.x, hs.antenna.y, DIM(.4))
        const bon = Math.sin(now / 700 + hs.y) > 0
        glyph(bon ? "o" : "·", hs.antenna.x, hs.antenna.y - 1, bon ? AMBER(.8) : DIM(.2))
      }
      // man + phone (arm is part of the sprite)
      if (man) for (const c of spriteCells(man, SPRITES.man)) glyph(c.ch, c.cx, c.cy, DIM(.55), true)
      if (phone) {
        const glow = Math.sin(now / 650) > 0
        for (const c of spriteCells(phone, SPRITES.phone)) {
          if (c.ch === ":") glyph(glow ? "▮" : "▪", c.cx, c.cy, CYAN(.7))
          else glyph(c.ch, c.cx, c.cy, DIM(.6), phone.s === BIG)
        }
      }
    }

    let raf = 0
    let last = 0
    function frame(now: number) {
      const dt = Math.min(.05, (now - last) / 1000 || .016)
      last = now
      if (!document.hidden) { step(dt, now); paint(now) }
      raf = requestAnimationFrame(frame)
    }

    const onMove = (e: PointerEvent) => { pointer.x = e.clientX / CW; pointer.y = e.clientY / CH }
    const onLeave = () => { pointer.x = pointer.y = -999 }
    window.addEventListener("pointermove", onMove, { passive: true })
    window.addEventListener("pointerleave", onLeave)
    window.addEventListener("resize", resize)

    resize()
    if (reduced) { step(.5, 0); paint(0) } // one static frame, no loop
    else raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("resize", resize)
    }
  }, [])

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0" style={{ background: "#05080c" }}>
      <canvas ref={canvasRef} style={{ opacity: 0.62 }} />
      {/* barely-there CRT finish, verbatim from the prototype */}
      <div className="absolute inset-0" style={{
        background: "repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0 2px, rgba(0,0,0,.13) 3px)",
        mixBlendMode: "multiply",
      }} />
      <div className="absolute inset-0" style={{
        background: "radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 30%, rgba(0,0,0,.55) 100%)",
      }} />
    </div>
  )
}
