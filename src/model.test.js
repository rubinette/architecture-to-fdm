import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { BoxGeometry, Vector3 } from 'three';
import { positions, bounds, parseModel, transform, binarySTL, solidPositions } from './model.js';
import { processModel } from './solid.js';

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

test('open meshes are rejected; bed contact is not an overhang', () => {
  const p = box(10, 10, 10);
  assert.throws(() => run([p.subarray(9)]), /開口/);
  const r = run([p]);
  assert.equal(r.analysis.overhangFaces.length, 0);
  assert.equal(r.analysis.thinCount, 0);
  assert.equal(r.floating, 0);
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
