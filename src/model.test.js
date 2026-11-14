import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { BoxGeometry, Vector3 } from 'three';
import { positions, bounds, parseModel, transform, binarySTL, solidPositions } from './model.js';
import { processModel } from './solid.js';
import { multiMaterial3MF } from './three-mf.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { repairMesh } from './mesh-repair.js';

const module = await Module(); module.setup();
const config = { unit: 1, ratio: 1, rotation: [0, 0, 0], base: 0, minWall: .8, overhangAngle: 45, autoOrient: false, bed: [220, 220, 250], supportSpacing: 3, supportGap: .2, supportDiameter: 1.6 };
function box(w, h, d, x = 0, y = h / 2, z = 0) { const g = new BoxGeometry(w, h, d).translate(x, y, z); const p = positions(g); g.dispose(); return p; }
function run(parts, options = {}) { return processModel(module, parts, { ...config, ...options }); }

test('STL round trip keeps millimeters and exports Z up; parsing rejects invalid input', () => {
  const r = run([box(10, 20, 30)]);
  const stl = binarySTL(r.positions);
  const parsed = parseModel(stl.buffer, 'stl');
  const b = bounds(parsed), size = b.getSize(new Vector3());
  assert.deepEqual(size.toArray().map(Math.round), [10, 30, 20]);
  assert.ok(Math.abs(b.min.z) < .001);
  assert.equal(stl.byteLength, 84 + r.triangles * 50);
  assert.throws(() => parseModel(new ArrayBuffer(0), 'obj'));
  assert.throws(() => transform([box(1, 1, 1)], { ...config, ratio: 0 }));
  assert.throws(() => run([new Float32Array([NaN, 0, 0, 0, 1, 0, 0, 0, 1])]), /無效/);
});

test('strict mode rejects open meshes; bed contact is not an overhang', () => {
  const p = box(10, 10, 10);
  assert.throws(() => run([p.subarray(9)], { meshRepair: false }), /開口/);
  const r = run([p]);
  assert.equal(r.analysis.overhangFaces.length, 0);
  assert.equal(r.analysis.thinCount, 0);
  assert.equal(r.floating, 0);
});

test('import repairs missing triangles and planar faces before print preparation', () => {
  const original = box(10, 10, 10);
  for (const offset of [9, 18]) {
    const input = original.slice(offset), copy = input.slice();
    const result = run([input]);
    assert.equal(result.meshRepair.filledHoles, 1);
    assert.ok(Math.abs(result.volume - 1000) < .001);
    assert.ok(result.original);
    assert.deepEqual(input, copy);
    assert.ok(Math.abs(run([result.positions], { meshRepair: false }).volume - 1000) < .001);
  }
});

test('duplicate, degenerate and reversed faces are repaired without discarding valid geometry', () => {
  const p = box(10, 10, 10), flipped = p.slice();
  flipped.set(p.subarray(6, 9), 3); flipped.set(p.subarray(3, 6), 6);
  const input = Float32Array.from([...flipped, ...flipped.subarray(9, 18), ...Array(9).fill(0)]);
  const result = run([input]);
  assert.equal(result.meshRepair.removedFaces, 2);
  assert.equal(result.meshRepair.flippedFaces, 1);
  assert.ok(Math.abs(result.volume - 1000) < .001);
});

test('failed OBJ groups are stitched together and small seams can be welded', () => {
  const p = box(10, 10, 10);
  const fragments = Array.from({ length: 6 }, (_, i) => p.slice(i * 18, (i + 1) * 18));
  const joined = run(fragments);
  assert.equal(joined.meshRepair.repairedParts, 6);
  assert.equal(joined.meshRepair.filledHoles, 0);
  assert.ok(Math.abs(joined.volume - 1000) < .001);
  const seam = p.slice();
  for (let i = 0; i < 18; i += 3) seam[i] += .0004;
  const repaired = run([seam], { weldTolerance: .001 });
  assert.ok(Math.abs(repaired.volume - 1000) < .1);
});

test('repair preserves nested cavity volume when a surface has incorrect winding', () => {
  const outer = module.Manifold.cube([20, 20, 20]), inner = module.Manifold.cube([16, 16, 16]), placed = inner.translate([2, 2, 2]);
  const room = module.Manifold.difference(outer, placed), p = solidPositions(room), flipped = p.slice();
  flipped.set(p.subarray(6, 9), 3); flipped.set(p.subarray(3, 6), 6);
  const result = run([flipped]);
  assert.ok(Math.abs(result.volume - (8000 - 4096)) < .001);
  [room, placed, inner, outer].forEach(m => m.delete());
});

test('unambiguous edge-touching shells can be separated; genuine branches are rejected', () => {
  const p = box(10, 10, 10), q = box(10, 10, 10, 10, 15);
  const repaired = repairMesh([p, q]);
  assert.ok(repaired.stats.splitEdges > 0);
  const solid = new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: repaired.vertProperties, triVerts: repaired.triVerts }));
  assert.ok(Math.abs(solid.volume() - 2000) < .001); solid.delete();
  const branch = Float32Array.from([...p, -5, 0, -5, -5, 10, -5, -9, 5, -5]);
  assert.throws(() => run([branch]), /共用一條邊/);
});

test('large or non-planar openings and zero-thickness sheets fail with actionable errors', () => {
  const p = box(10, 10, 10);
  assert.throws(() => run([p.slice(18)], { maxHoleSize: 5 }), /補洞上限 5/);
  assert.throws(() => run([p.slice(18)], { maxHoleSize: 0 }), /補洞上限 0/);
  assert.throws(() => run([p.slice(18)], { weldTolerance: NaN }), /接縫容差/);
  assert.throws(() => run([Float32Array.from([...p.slice(18, 36), ...p.slice(54)])]), /不在同一平面/);
  assert.throws(() => run([new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])]), /沒有封閉體積/);
});

test('thin walls are thickened in output geometry and original arrays stay unchanged', () => {
  const p = box(.4, 10, 10), copy = p.slice();
  const before = run([p]);
  const after = run([p], { repair: true });
  assert.ok(before.analysis.thinCount > 0);
  assert.equal(after.analysis.thinCount, 0);
  assert.ok(after.analysis.minThickness >= .8 - .001);
  assert.ok(bounds([after.positions]).getSize(new Vector3()).x > .8);
  assert.ok(after.changes.expansion > 0);
  assert.deepEqual(p, copy);
});

test('floating slab receives closed support geometry with top air gap', () => {
  const r = run([box(4, 1, 4, -10), box(8, 2, 8, 0, 16)], { repair: true });
  assert.equal(r.floating, 1);
  assert.ok(r.supports.count > 0);
  const b = bounds([r.supports.positions]);
  assert.ok(Math.abs(b.min.y) < .001);
  assert.ok(Math.abs(b.max.y - 14.8) < .002);
  // Round-trip generated posts through Manifold to verify closed positive solids.
  const verified = run([r.supports.positions]);
  assert.ok(verified.volume > 0);
  assert.equal(r.supports.truncated, false);
});

test('automatic orientation reduces cantilever overhang without exceeding bed', () => {
  const parts = [box(2, 15, 5), box(16, 2, 5, 5, 14)];
  const before = run(parts);
  const after = run(parts, { repair: true, autoOrient: true });
  assert.ok(after.analysis.overhangArea < before.analysis.overhangArea);
  assert.notDeepEqual(after.changes.rotation, [0, 0, 0]);
});

test('exterior-only fills internal room and removes internal roof supports', () => {
  const outer = module.Manifold.cube([20, 20, 20]);
  const inner = module.Manifold.cube([16, 16, 16]);
  const placed = inner.translate([2, 2, 2]);
  const room = module.Manifold.difference(outer, placed);
  const parts = [solidPositions(room)];
  const before = run(parts, { repair: true });
  const after = run(parts, { repair: true, facade: true, facadeDepth: .6, facadeOpening: 4, facadeStep: .5 });
  assert.ok(before.supports.count > 0);
  assert.equal(after.supports.count, 0);
  assert.ok(Math.abs(after.volume - 8000) < .01);
  assert.equal(after.analysis.overhangArea, 0);
  assert.deepEqual(bounds([after.positions]).getSize(new Vector3()).toArray(), [20, 20, 20]);
  [room, placed, inner, outer].forEach(m => m.delete());
});

test('exterior-only preserves a concave outside outline instead of using a convex hull', () => {
  const parts = [box(20, 10, 4), box(4, 10, 16, -8, 5, 6)];
  const before = run(parts);
  const after = run(parts, { facade: true, facadeOpening: 0, facadeStep: .5 });
  assert.ok(Math.abs(before.volume - after.volume) < .01);
});

test('base union keeps model grounded and validates repair parameters', () => {
  const r = run([box(10, 10, 10)], { base: 2 });
  const b = bounds([r.positions]);
  assert.equal(r.shells, 1);
  assert.equal(b.min.y, 0);
  assert.ok(Math.abs(b.max.y - 11.95) < .001);
  assert.throws(() => run([box(2, 2, 2)], { repair: true, supportGap: -1 }), /接觸間隙/);
  assert.throws(() => run([box(2, 2, 2)], { facade: true, facadeDepth: -1 }), /外立面/);
});

test('dual-material 3MF keeps two material-assigned parts in one aligned assembly', () => {
  const model = box(8, 3, 6, 7, 13, -4), support = box(2, 10, 2, 7, 5, -4);
  const before = model.slice();
  const options = { name: '模型 <A> & B', modelMaterial: 'PLA "白色"', supportMaterial: 'PVA & 支撐' };
  const zip = unzipSync(multiMaterial3MF(model, support, options));
  assert.deepEqual(Object.keys(zip).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
  const xml = strFromU8(zip['3D/3dmodel.model']);
  assert.match(strFromU8(zip['_rels/.rels']), /Target="\/3D\/3dmodel.model"/);
  assert.match(strFromU8(zip['[Content_Types].xml']), /application\/vnd.ms-package.3dmanufacturing-3dmodel\+xml/);
  assert.match(xml, /unit="millimeter"/);
  assert.match(xml, /模型 &lt;A&gt; &amp; B/);
  assert.match(xml, /PLA &quot;白色&quot;/);
  assert.match(xml, /PVA &amp; 支撐/);
  assert.match(xml, /<components><component objectid="2"\/><component objectid="3"\/><\/components>/);
  assert.match(xml, /<build><item objectid="4"\/><\/build>/);
  for (const [partIndex, input] of [model, support].entries()) {
    const part = xml.match(new RegExp(`<object id="${partIndex + 2}"[^>]*>[\\s\\S]*?<\\/object>`))[0];
    assert.match(part, new RegExp(`pid="1" pindex="${partIndex}"`));
    const vertices = [...part.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(m => m.slice(1).map(Number));
    const triangles = [...part.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].map(m => m.slice(1).map(Number));
    assert.equal(vertices.length, 8); // Shared vertex indices form watertight edges.
    assert.equal(triangles.length, input.length / 9);
    const edges = new Map();
    const reconstructed = triangles.flatMap(triangle => {
      for (let i = 0; i < 3; i++) {
        const a = triangle[i], b = triangle[(i + 1) % 3], key = [a, b].sort((a, b) => a - b).join(',');
        const edge = edges.get(key) ?? { count: 0, orientation: 0 }; edge.count++; edge.orientation += a < b ? 1 : -1; edges.set(key, edge);
      }
      return triangle.flatMap(index => { const [x, y, z] = vertices[index]; return [x, z, -y]; });
    });
    assert.deepEqual(new Float32Array(reconstructed), input); // All positions/winding, not only dimensions.
    for (const edge of edges.values()) assert.deepEqual(edge, { count: 2, orientation: 0 });
  }
  assert.deepEqual(model, before);
  assert.throws(() => multiMaterial3MF(model, new Float32Array(), options), /有效/);
  assert.throws(() => multiMaterial3MF(model, support, { ...options, supportMaterial: ' ' }), /材質/);
  assert.throws(() => multiMaterial3MF(new Float32Array([NaN, 0, 0]), support, options), /有效/);
});

test('zero contact gap is opt-in for separate-material supports, with no volume overlap', () => {
  const parts = [box(4, 1, 4, -10), box(8, 2, 8, 0, 16)];
  assert.throws(() => run(parts, { repair: true, supportGap: 0 }), /接觸間隙/);
  const result = run(parts, { repair: true, supportGap: 0, multiMaterial: true });
  assert.ok(result.supports.count > 0);
  assert.ok(Math.abs(bounds([result.supports.positions]).max.y - 15) < .001);
  const mesh = p => { const m = new module.Mesh({ numProp: 3, vertProperties: p, triVerts: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) }); m.merge(); return new module.Manifold(m); };
  const model = mesh(result.positions), supports = mesh(result.supports.positions), overlap = module.Manifold.intersection(model, supports);
  assert.ok(supports.volume() > 0);
  assert.ok(Math.abs(overlap.volume()) < .0001);
  [overlap, supports, model].forEach(m => m.delete());
});


test('approximate reconstruction is opt-in, closes branched sheets and survives strict STL reimport', () => {
  const p = new Float32Array([0,0,0, 4,0,0, 0,4,0, 0,0,0, 0,0,4, 4,0,0, 0,0,0, 4,0,0, 0,-4,0]);
  const original = p.slice();
  assert.throws(() => run([p]), /近似重建/);
  assert.throws(() => run([p], { reconstruct: true, weldTolerance: NaN }), /容差/);
  const r = run([p], { reconstruct: true });
  assert.equal(r.meshRepair.reconstructed, true);
  assert.ok(r.volume > 0);
  assert.ok(Math.abs(bounds([r.positions]).min.y) < 1e-5);
  assert.deepEqual(p, original);
  const reimported = run(parseModel(binarySTL(r.positions).buffer, 'stl'), { meshRepair: false });
  assert.equal(reimported.meshRepair, null);
  assert.ok(Math.abs(reimported.volume - r.volume) < r.volume * 1e-5);
});

test('reconstruction fills cracked, partly inverted shells and keeps sub-grid closed shells exact', () => {
  const cube = box(20, 20, 20);
  for (let i = 37; i < 54; i += 3) cube[i] += .3; // Lift the top face: a 0.3 mm crack on every top edge.
  cube.set(cube.slice(60, 63), 57); cube.set(box(20, 20, 20).slice(57, 60), 60); // Reverse one side triangle.
  const soup = Float32Array.from([...cube, ...box(.2, .2, .2, 15, 20.5, 0)]); // One STL part, as SketchUp exports.
  assert.throws(() => run([soup], { maxHoleSize: 0 }), /近似重建/);
  const r = run([soup], { maxHoleSize: 0, reconstruct: true });
  assert.equal(r.meshRepair.reconstructed, true);
  assert.equal(r.meshRepair.closedShells, 1);
  assert.ok(r.meshRepair.enclosedFraction > 0);
  const outer = 20 + 2 * r.meshRepair.step;
  assert.ok(r.volume > 20 ** 3 * .95 && r.volume < outer ** 3 + 1, `volume ${r.volume}`); // Solid, not a hollow skin.
  const b = bounds([r.positions]);
  assert.ok(Math.abs(b.max.x - 12.55) < 1e-4, `max x ${b.max.x}`); // Centered tiny box face, not inflated by the grid.
});
test('reconstruction seal width decides whether a wide opening stays hollow', () => {
  const cube = box(20, 20, 20);
  for (let i = 37; i < 54; i += 3) cube[i] += 1.5; // 1.5 mm gap under the whole roof.
  const open = run([cube], { maxHoleSize: 0, reconstruct: true });
  const sealed = run([cube], { maxHoleSize: 0, reconstruct: true, sealGap: 4 });
  assert.ok(open.volume < 20 ** 3 * .5, `open ${open.volume}`);
  assert.ok(sealed.volume > 20 ** 3 * .95, `sealed ${sealed.volume}`);
  assert.equal(sealed.meshRepair.sealGap, 4);
  assert.throws(() => run([cube], { maxHoleSize: 0, reconstruct: true, sealGap: -1 }), /封閉開口/);
});

const realSTL = [new URL('../test.stl', import.meta.url), new URL('../test_modes/test.stl', import.meta.url)].find(existsSync) ?? new URL('../test.stl', import.meta.url);
test('local test.stl imports, reconstructs and reimports without repair', { skip: !existsSync(realSTL) }, () => {
  const bytes = readFileSync(realSTL);
  const parts = parseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'stl');
  const r = run(parts, { ratio: 25, rotation: [-90, 0, 0], reconstruct: true });
  assert.equal(r.meshRepair.reconstructed, true);
  assert.ok(r.volume > 0);
  const stl = binarySTL(r.positions);
  assert.ok(stl.byteLength < 25 * 1024 * 1024);
  const verified = run(parseModel(stl.buffer, 'stl'), { meshRepair: false });
  assert.equal(verified.meshRepair, null);
  assert.ok(Math.abs(verified.volume - r.volume) < r.volume * 1e-5);
  assert.deepEqual(readFileSync(realSTL), bytes);
});
