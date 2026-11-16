import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Test the code actually shipped in the client, never the staging helper file.
// Only this pure marked block executes: no client boot, DOM, DSH or services.
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const begin = '// BEGIN CONTEXT STUDIO EDGE HELPERS', end = '// END CONTEXT STUDIO EDGE HELPERS'
const start = client.indexOf(begin), finish = client.indexOf(end, start)
assert.ok(start >= 0 && finish > start, 'client.js must contain the complete geometry helper block')
assert.equal(client.indexOf(begin, start + begin.length), -1, 'helper block must be unique')
const api = vm.runInNewContext(client.slice(start, finish + end.length) + '\n({ roundedEdge, consoleEdgeGeometry, consoleOuterRoute, consoleSourceBus })', Object.create(null), { timeout: 1000 })
const plain = value => JSON.parse(JSON.stringify(value))
const geometry = graph => plain(api.consoleEdgeGeometry(graph))
const outer = (graph, from, to) => plain(api.consoleOuterRoute(graph, from, to))
const bus = (graph, record, target) => plain(api.consoleSourceBus(graph, record, target))
const id = trail => JSON.stringify(trail)
const node = (trail, row, extra = {}) => ({ id: id(trail), cardId: trail.at(-1), trail,
  x: 28 + (trail.length - 1) * 252, y: 54 + row * 216, w: 184, h: 174, ...extra })
function fork(count = 2) {
  const root = node(['a'], (count - 1) / 2), nodes = [root], edges = [], paths = []
  for (let i = 0; i < count; i++) {
    const branch = node(['a', `b${i}`], i), leaf = node(['a', `b${i}`, 'd'], i)
    nodes.push(branch, leaf)
    edges.push({ from: root.id, to: branch.id, kind: 'path' }, { from: branch.id, to: leaf.id, kind: 'path' })
    paths.push({ id: `p${i}`, nodes: leaf.trail })
  }
  return { nodes, edges, paths, width: 744, height: Math.max(...nodes.map(n => n.y + n.h)) + 38 }
}
function grid(columns = 3, rows = 4) {
  const nodes = []
  for (let col = 0; col < columns; col++) for (let row = 0; row < rows; row++) {
    nodes.push(node([], row, { id: `i${col}-${row}`, cardId: `c${col}-${row}`, x: 28 + col * 252 }))
  }
  return { nodes, edges: [], paths: [], width: 28 + (columns - 1) * 252 + 184 + 28,
    height: Math.max(...nodes.map(n => n.y + n.h)) + 38 }
}
const target = graph => ({ x: 200, y: graph.height + 92, w: 184, h: 112 })
const near = (a, b) => Math.abs(a - b) < 1e-7
const same = (a, b) => near(a.x, b.x) && near(a.y, b.y)

// Independent SVG parser and analytic intersection checker. Check the actual
// rounded curve, including thin obstacles that point sampling could miss.
function svg(d) {
  assert.equal(typeof d, 'string')
  assert.equal(/NaN|Infinity|undefined/.test(d), false)
  const tokens = d.match(/[MLQ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) || []
  let i = 0, current, first
  const pieces = []
  const point = () => {
    const p = { x: Number(tokens[i++]), y: Number(tokens[i++]) }
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
    return p
  }
  while (i < tokens.length) {
    const command = tokens[i++]
    if (command === 'M') { current = point(); first ??= current }
    else if (command === 'L') { const b = point(); pieces.push({ a: current, b }); current = b }
    else if (command === 'Q') { const c = point(), b = point(); pieces.push({ a: current, c, b }); current = b }
    else assert.fail('unexpected SVG command ' + command)
  }
  return { first, last: current, pieces }
}
function at(p, t) {
  return p.c ? { x: (1 - t) ** 2 * p.a.x + 2 * (1 - t) * t * p.c.x + t ** 2 * p.b.x,
    y: (1 - t) ** 2 * p.a.y + 2 * (1 - t) * t * p.c.y + t ** 2 * p.b.y } :
    { x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t }
}
function roots(a, b, c) {
  if (near(a, 0)) return near(b, 0) ? [] : [-c / b]
  const delta = b * b - 4 * a * c
  return delta < 0 ? [] : [(-b - Math.sqrt(delta)) / (2 * a), (-b + Math.sqrt(delta)) / (2 * a)]
}
function enters(p, n) {
  const cuts = [0, 1]
  for (const [axis, limits] of [['x', [n.x, n.x + n.w]], ['y', [n.y, n.y + n.h]]]) {
    for (const bound of limits) {
      const a = p.c ? p.a[axis] - 2 * p.c[axis] + p.b[axis] : 0
      const b = p.c ? 2 * (p.c[axis] - p.a[axis]) : p.b[axis] - p.a[axis]
      cuts.push(...roots(a, b, p.a[axis] - bound).filter(t => t > 0 && t < 1))
    }
  }
  cuts.sort((a, b) => a - b)
  return cuts.slice(1).some((end, i) => {
    const v = at(p, (end + cuts[i]) / 2)
    return v.x > n.x + 1e-7 && v.x < n.x + n.w - 1e-7 && v.y > n.y + 1e-7 && v.y < n.y + n.h - 1e-7
  })
}
function avoids(d, nodes) {
  for (const piece of svg(d).pieces) for (const n of nodes) assert.equal(enters(piece, n), false, `${d} enters ${n.id}`)
}
function horizontal(d) {
  const value = svg(d)
  assert.equal(value.pieces.length, 1)
  assert.equal(value.pieces[0].c, undefined)
  assert.equal(value.first.y, value.last.y)
  assert.ok(value.last.x > value.first.x)
  return value
}
function noDuplicatePaint(segments) {
  assert.equal(new Set(segments.map(s => s.id)).size, segments.length)
  const pieces = segments.flatMap(s => svg(s.d).pieces), curves = new Set()
  pieces.forEach(p => {
    if (!p.c) return
    const one = JSON.stringify([p.a, p.c, p.b]), two = JSON.stringify([p.b, p.c, p.a]), key = [one, two].sort()[0]
    assert.equal(curves.has(key), false, 'same rounded bend painted twice'); curves.add(key)
  })
  const lines = pieces.filter(p => !p.c)
  for (let i = 0; i < lines.length; i++) for (const b of lines.slice(i + 1)) {
    const a = lines[i]
    for (const [fixed, varying] of [['x', 'y'], ['y', 'x']]) {
      if (!near(a.a[fixed], a.b[fixed]) || !near(a.a[fixed], b.a[fixed]) || !near(b.a[fixed], b.b[fixed])) continue
      const overlap = Math.min(Math.max(a.a[varying], a.b[varying]), Math.max(b.a[varying], b.b[varying])) -
        Math.max(Math.min(a.a[varying], a.b[varying]), Math.min(b.a[varying], b.b[varying]))
      assert.ok(overlap <= 1e-7, 'collinear shared track painted more than once')
    }
  }
}
function covered(d, segments) {
  const all = segments.flatMap(s => svg(s.d).pieces)
  for (const p of svg(d).pieces) assert.ok(all.some(s => {
    if (p.c) return s.c && same(p.c, s.c) && ((same(p.a, s.a) && same(p.b, s.b)) || (same(p.a, s.b) && same(p.b, s.a)))
    if (s.c) return false
    return ['x', 'y'].some(axis => {
      const other = axis === 'x' ? 'y' : 'x'
      return near(s.a[axis], s.b[axis]) && near(p.a[axis], s.a[axis]) && near(p.b[axis], s.a[axis]) &&
        Math.min(p.a[other], p.b[other]) >= Math.min(s.a[other], s.b[other]) - 1e-7 &&
        Math.max(p.a[other], p.b[other]) <= Math.max(s.a[other], s.b[other]) + 1e-7
    })
  }), 'rendered segments must cover every route primitive')
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

test('roundedEdge: empty/single/straight points and object/tuple forms have stable SVG output', () => {
  assert.equal(api.roundedEdge([]), '')
  assert.equal(api.roundedEdge([[1, 2]]), 'M1,2')
  assert.equal(api.roundedEdge([[0, 0], [10, 0], [10, 0], [20, 0]]), 'M0,0 L20,0')
  assert.equal(api.roundedEdge([{ x: 0, y: 0 }, { x: 20, y: 0 }]), 'M0,0 L20,0')
})

test('roundedEdge: radius is clamped to adjacent half-lengths and preserves endpoint locations', () => {
  assert.equal(api.roundedEdge([[0, 0], [20, 0], [20, 20]]), 'M0,0 L10,0 Q20,0 20,10 L20,20')
  const short = svg(api.roundedEdge([[0, 0], [4, 0], [4, 2]], 100))
  assert.deepEqual(short.pieces[1], { a: { x: 3, y: 0 }, c: { x: 4, y: 0 }, b: { x: 4, y: 1 } })
  assert.deepEqual(short.first, { x: 0, y: 0 }); assert.deepEqual(short.last, { x: 4, y: 2 })
  assert.equal(api.roundedEdge([[0, 0], [20, 0], [20, 20]], 0), 'M0,0 L20,0 L20,20')
  assert.equal(api.roundedEdge([[0, 0], [20, 0], [20, 20]], -5), 'M0,0 L20,0 L20,20')
})

test('roundedEdge: invalid coordinates cannot bridge a gap or emit NaN; reversals and diagonal corners remain finite', () => {
  for (const points of [null, {}, [[0, 0], null, [20, 0]], [[0, 0], [Infinity, 2]], [[0, 0], ['2', 3]], [[NaN, 0]]]) assert.equal(api.roundedEdge(points), '')
  assert.equal(api.roundedEdge([[0, 0], [10, 0], [0, 0]]), 'M0,0 L10,0 L0,0')
  for (const r of [undefined, NaN, Infinity, 0, 100]) {
    const value = svg(api.roundedEdge([[0, 0], [10, 10], [20, 0]], r))
    assert.deepEqual(value.first, { x: 0, y: 0 }); assert.deepEqual(value.last, { x: 20, y: 0 })
  }
})

test('path geometry: only actual path edges with immediate complete prefixes are routed; children is never trusted', () => {
  const graph = fork(), [root, b, d, c] = graph.nodes
  Object.defineProperty(root, 'children', { get() { assert.fail('must not read children') } })
  graph.edges.push(graph.edges[0], { from: root.id, to: d.id, kind: 'path' },
    { from: b.id, to: c.id, kind: 'path' }, { from: b.id, to: root.id, kind: 'path' },
    { from: root.id, to: root.id, kind: 'path' }, { from: root.id, to: 'missing', kind: 'path' },
    ...['shared', 'supports', 'depends_on', undefined].map(kind => ({ from: root.id, to: b.id, kind })))
  const result = geometry(graph)
  assert.equal(result.routes.length, 4)
  assert.equal(new Set(result.routes.map(r => r.id)).size, 4)
  assert.ok(result.routes.every(r => r.kind === 'path' && r.id === 'path:' + JSON.stringify([r.from, r.to])))
})

test('path membership: shared prefix includes matching paths, rejoining card IDs never share branch membership', () => {
  const graph = fork(), [root, b, d, c, otherD] = graph.nodes
  graph.paths.push({ id: 'short', nodes: ['a', 'b0'] }, { id: 'unrelated', nodes: ['elsewhere', 'b0', 'd'] })
  const result = geometry(graph)
  const edge = (from, to) => result.routes.find(r => r.from === from && r.to === to)
  assert.deepEqual(edge(root.id, b.id).paths, ['p0', 'short'])
  assert.deepEqual(edge(b.id, d.id).paths, ['p0'])
  assert.deepEqual(edge(root.id, c.id).paths, ['p1'])
  assert.deepEqual(edge(c.id, otherD.id).paths, ['p1'])
  assert.notEqual(edge(b.id, d.id).id, edge(c.id, otherD.id).id)
})

test('path geometry: shared stems/tracks are drawn once and all full routes remain covered', () => {
  for (const count of [1, 2, 3, 8]) {
    const graph = fork(count), result = geometry(graph)
    assert.equal(result.routes.length, count * 2)
    noDuplicatePaint(result.segments)
    for (const route of result.routes) { covered(route.d, result.segments); avoids(route.d, graph.nodes) }
    result.segments.forEach(s => avoids(s.d, graph.nodes))
    assert.equal(new Set(result.junctions.map(p => JSON.stringify(p))).size, result.junctions.length)
    if (count > 1) assert.ok(result.junctions.length > 0)
  }
})

test('branch hit areas: only exclusive terminal horizontals are clickable, with labels centered there', () => {
  const graph = fork(3), result = geometry(graph)
  for (const route of result.routes) {
    const a = graph.nodes.find(n => n.id === route.from), b = graph.nodes.find(n => n.id === route.to), hit = horizontal(route.hitD)
    assert.ok(hit.first.x > (a.x + a.w + b.x) / 2, 'hit excludes the vertical rail and bend')
    assert.equal(hit.last.x, b.x); assert.equal(hit.last.y, b.y + b.h / 2)
    assert.equal(route.x, (hit.first.x + hit.last.x) / 2); assert.equal(route.y, hit.last.y)
    avoids(route.hitD, graph.nodes)
  }
})

test('fork stems: only routed parents have targets, including a single successor; leaves never do', () => {
  const graph = fork(), result = geometry(graph)
  assert.deepEqual(result.forks.map(f => f.id), [graph.nodes[0].id, graph.nodes[1].id, graph.nodes[3].id])
  assert.deepEqual(result.forks.map(f => f.routes.length), [2, 1, 1])
  for (const f of result.forks) {
    const a = graph.nodes.find(n => n.id === f.from), stem = horizontal(f.d)
    assert.equal(f.id, f.from); assert.equal(stem.first.x, a.x + a.w); assert.equal(stem.first.y, a.y + a.h / 2)
    assert.equal(f.x, (stem.first.x + stem.last.x) / 2); assert.equal(f.y, stem.first.y)
    for (const routeId of f.routes) assert.equal(result.routes.find(r => r.id === routeId).from, f.id)
    covered(f.d, result.segments)
  }
})

test('path geometry: empty, unrelated, malformed and ambiguous endpoint data do not create routes', () => {
  for (const graph of [undefined, null, {}, { nodes: [], edges: [] }, { nodes: grid().nodes, edges: [{ from: 'i0-0', to: 'i1-0', kind: 'path' }] }]) {
    assert.deepEqual(geometry(graph), { routes: [], segments: [], forks: [], junctions: [] })
  }
  const graph = fork(), root = graph.nodes[0]
  graph.nodes.push({ ...root, x: NaN }) // even an invalid duplicate makes the ID ambiguous
  assert.equal(geometry(graph).routes.some(r => r.from === root.id), false)
  const badTrail = fork(); badTrail.nodes[1].trail = ['different', 'b0']
  assert.equal(geometry(badTrail).routes.some(r => r.to === badTrail.nodes[1].id), false)
})

test('outer association: exactly one routed path uses the bottom +26 corridor and never crosses grid cards', () => {
  const graph = grid()
  for (const a of graph.nodes) for (const b of graph.nodes) {
    if (a.id === b.id) continue
    const result = outer(graph, a.id, b.id)
    assert.ok(result, `${a.id} → ${b.id}`)
    assert.deepEqual(Object.keys(result).sort(), ['d', 'x', 'y'])
    const rendered = svg(result.d)
    assert.deepEqual(rendered.first, { x: a.x + a.w, y: a.y + a.h / 2 })
    assert.deepEqual(rendered.last, { x: b.x, y: b.y + b.h / 2 })
    assert.equal(result.y, graph.height + 26)
    assert.ok(rendered.pieces.some(p => !p.c && p.a.y === result.y && p.b.y === result.y && p.a.x !== p.b.x))
    assert.ok(result.x >= 0 && result.x <= graph.width)
    avoids(result.d, graph.nodes)
  }
})

test('outer association: adjacent columns get different lanes, even when endpoints share a row', () => {
  const graph = grid(2, 2), a = graph.nodes[0], b = graph.nodes[2], value = outer(graph, a.id, b.id)
  const vertical = svg(value.d).pieces.filter(p => !p.c && p.a.x === p.b.x)
  assert.equal(new Set(vertical.map(p => p.a.x)).size, 2)
  for (const p of vertical) assert.ok(p.a.x > a.x + a.w && p.a.x < b.x)
})

test('outer association: unknown, duplicate, same IDs or unsafe geometry return null', () => {
  const graph = grid()
  for (const [from, to] of [['missing', 'i0-0'], ['i0-0', 'missing'], ['i0-0', 'i0-0'], [null, 'i0-0']]) assert.equal(outer(graph, from, to), null)
  assert.equal(outer({ ...graph, height: NaN }, 'i0-0', 'i1-0'), null)
  assert.equal(outer({ ...graph, height: 0 }, 'i0-0', 'i1-0'), null)
  const duplicate = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0] }] }
  assert.equal(outer(duplicate, 'i0-0', 'i1-0'), null)
  const obstacle = { id: 'obstacle', cardId: 'block', x: 212, y: 140, w: 20, h: 2 }
  assert.equal(outer({ ...graph, nodes: [...graph.nodes, obstacle] }, 'i0-0', 'i1-0'), null)
})

test('outer association: a narrow available lane still avoids a thin third-party obstacle', () => {
  const graph = grid(), obstacle = { id: 'obstacle', cardId: 'block', x: 213, y: 140, w: 20, h: 2 }
  graph.nodes.push(obstacle)
  const result = outer(graph, 'i0-0', 'i1-0')
  assert.ok(result)
  avoids(result.d, graph.nodes)
})

test('source bus: only explicitly matching instance/card pairs qualify; repeated card positions are not guessed', () => {
  const graph = fork(), [, , firstD, , secondD] = graph.nodes
  for (const record of [{ cards: ['d'] }, { cards: ['d'], instances: [], path: 'p0' }, { cards: ['d'], instances: ['d', 'missing'] }]) {
    const result = bus(graph, record, target(graph))
    assert.deepEqual(result.origins, []); assert.deepEqual(result.missing, ['d']); assert.deepEqual(result.segments, [])
  }
  const one = bus(graph, { cards: ['d'], instances: [secondD.id] }, target(graph))
  assert.deepEqual(one.origins, [secondD.id]); assert.deepEqual(one.missing, [])
  const both = bus(graph, { cards: ['d'], instances: [firstD.id, secondD.id, firstD.id] }, target(graph))
  assert.deepEqual(both.origins, [firstD.id, secondD.id]); assert.deepEqual(both.missing, [])
  noDuplicatePaint(both.segments)
})

test('source bus: mixed source membership reports missing card IDs once in requested order', () => {
  const graph = fork(), [root, branch, leaf] = graph.nodes
  const result = bus(graph, { cards: ['missing', 'd', 'a', 'missing', 'not-selected-instance'], instances: [branch.id, leaf.id, 'unknown', root.id] }, target(graph))
  assert.deepEqual(result.origins, [leaf.id, root.id])
  assert.deepEqual(result.missing, ['missing', 'not-selected-instance'])
  assert.ok(result.segments.length)
})

test('source bus: right exits descend in column gaps to +48, merge tracks once and enter target top-center', () => {
  const graph = grid(), destination = target(graph)
  const record = { cards: graph.nodes.map(n => n.cardId), instances: graph.nodes.map(n => n.id) }
  const result = bus(graph, record, destination)
  assert.deepEqual(result.origins, record.instances); assert.deepEqual(result.missing, [])
  assert.equal(result.x, destination.x + destination.w / 2); assert.equal(result.y, graph.height + 48)
  noDuplicatePaint(result.segments)
  const pieces = result.segments.flatMap(s => svg(s.d).pieces)
  for (const n of graph.nodes) assert.ok(pieces.some(p => !p.c && (same(p.a, { x: n.x + n.w, y: n.y + n.h / 2 }) || same(p.b, { x: n.x + n.w, y: n.y + n.h / 2 }))))
  const drop = pieces.filter(p => !p.c && p.a.x === result.x && p.b.x === result.x && Math.max(p.a.y, p.b.y) === destination.y)
  assert.equal(drop.length, 1, 'target stem is drawn once')
  assert.ok(pieces.some(p => !p.c && p.a.y === result.y && p.b.y === result.y))
  result.segments.forEach(s => { avoids(s.d, graph.nodes); avoids(s.d, [{ ...destination, id: 'target' }]) })
  const trunks = pieces.filter(p => !p.c && p.a.x === p.b.x && p.a.x !== result.x)
  assert.equal(new Set(trunks.map(p => p.a.x)).size, 3)
  assert.equal(trunks.length, 3, 'same-x source rails are fully merged')
})

test('source bus: target alignment with a source rail does not duplicate that rail or lose the endpoint', () => {
  const graph = grid(1, 3), destination = { ...target(graph), x: 134, w: 184 }
  // Last column gap is 212..240, midpoint 226, also the target center.
  const result = bus(graph, { cards: graph.nodes.map(n => n.cardId), instances: graph.nodes.map(n => n.id) }, destination)
  assert.equal(result.x, 226)
  noDuplicatePaint(result.segments)
  assert.ok(result.segments.some(s => svg(s.d).pieces.some(p => same(p.b, { x: 226, y: destination.y }))))
  result.segments.forEach(s => avoids(s.d, graph.nodes))
})

test('source bus: no valid origins, unsafe target or ambiguous instance yields empty segments and explicit missing', () => {
  const graph = grid(), first = graph.nodes[0], record = { cards: [first.cardId], instances: [first.id] }
  for (const destination of [null, {}, { ...target(graph), x: NaN }, { ...target(graph), y: graph.height + 48 }, { ...target(graph), w: 0 }]) {
    const result = bus(graph, record, destination)
    assert.deepEqual(result.segments, []); assert.deepEqual(result.origins, []); assert.deepEqual(result.missing, [first.cardId])
  }
  assert.deepEqual(bus(graph, {}, target(graph)).segments, [])
  const ambiguous = bus({ ...graph, nodes: [...graph.nodes, { ...first }] }, record, target(graph))
  assert.deepEqual(ambiguous.origins, []); assert.deepEqual(ambiguous.missing, [first.cardId])
  const short = bus({ ...graph, height: 0 }, record, target(graph))
  assert.deepEqual(short.segments, []); assert.deepEqual(short.missing, [first.cardId])
})

test('all helpers: frozen inputs remain unchanged and repeated calculations are deterministic', () => {
  const graph = freeze(fork()), record = freeze({ cards: ['a', 'd'], instances: [graph.nodes[0].id, graph.nodes[2].id] }), destination = freeze(target(graph))
  const before = JSON.stringify([graph, record, destination])
  assert.deepEqual(geometry(graph), geometry(graph))
  assert.deepEqual(outer(graph, graph.nodes[0].id, graph.nodes[2].id), outer(graph, graph.nodes[0].id, graph.nodes[2].id))
  assert.deepEqual(bus(graph, record, destination), bus(graph, record, destination))
  api.roundedEdge(freeze([[0, 0], [20, 0], [20, 20]]))
  assert.equal(JSON.stringify([graph, record, destination]), before)
})
