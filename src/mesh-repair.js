import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Ray, ShapeUtils, Vector2, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
const failure = message => new Error(`網格自動修復未完成：${message} 原模型已保留。`);

export function repairMesh(parts, { weldTolerance = .001, maxHoleSize = 50 } = {}) {
  if (!Number.isFinite(weldTolerance) || weldTolerance < .000001 || weldTolerance > .1 || !Number.isFinite(maxHoleSize) || maxHoleSize < 0 || maxHoleSize > 500) throw new RangeError('接縫容差需為 0.000001–0.1 mm，補洞上限需為 0–500 mm。');
  const vertices = [], buckets = new Map(), faces = [], seen = new Set();
  const stats = { weldedVertices: 0, removedFaces: 0, flippedFaces: 0, filledHoles: 0, splitEdges: 0 };
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  function vertex(x, y, z) {
    const cell = [x, y, z].map(v => Math.floor(v / weldTolerance));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const id of buckets.get(`${cell[0] + dx},${cell[1] + dy},${cell[2] + dz}`) ?? []) {
        const p = vertices[id];
        if ((p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 <= weldTolerance ** 2) { stats.weldedVertices++; return id; }
      }
    }
    const key = cell.join(','), id = vertices.length;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(id); vertices.push(new Vector3(x, y, z)); return id;
  }
  for (const p of parts) for (let i = 0; i < p.length; i += 9) {
    const f = [0, 3, 6].map(j => vertex(p[i + j], p[i + j + 1], p[i + j + 2]));
    const key = [...f].sort((x, y) => x - y).join(',');
    a.subVectors(vertices[f[1]], vertices[f[0]]); b.subVectors(vertices[f[2]], vertices[f[0]]);
    if (new Set(f).size < 3 || c.crossVectors(a, b).lengthSq() <= weldTolerance ** 4 || seen.has(key)) { stats.removedFaces++; continue; }
    seen.add(key); faces.push(f);
  }
  if (!faces.length) throw failure('沒有剩餘的有效三角面。');
  const edges = new Map();
  faces.forEach((f, face) => f.forEach((v, i) => {
    const next = f[(i + 1) % 3], key = edgeKey(v, next);
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push({ face, from: v, to: next });
  }));
  const neighbors = faces.map(() => []);
  for (const edge of edges.values()) if (edge.length === 2) {
    const [a, b] = edge, same = a.from === b.from;
    neighbors[a.face].push([b.face, same]); neighbors[b.face].push([a.face, same]);
  }
  const component = new Int32Array(faces.length).fill(-1), flip = new Uint8Array(faces.length), groups = [];
  for (let seed = 0; seed < faces.length; seed++) {
    if (component[seed] >= 0) continue;
    const queue = [seed], id = groups.length; groups.push(queue); component[seed] = id;
    for (let i = 0; i < queue.length; i++) for (const [next, same] of neighbors[queue[i]]) {
      const required = flip[queue[i]] ^ Number(same);
      if (component[next] >= 0) { if (flip[next] !== required) throw failure('面向互相矛盾，無法形成可定向表面。'); }
      else { component[next] = id; flip[next] = required; queue.push(next); }
    }
  }
  // Separate edge-touching shells only when ordinary edges identify unambiguous pairs.
  for (const edge of edges.values()) if (edge.length > 2) {
    const counts = new Map();
    for (const e of edge) counts.set(component[e.face], (counts.get(component[e.face]) ?? 0) + 1);
    if ([...counts.values()].some(n => n !== 2)) throw failure(`有 ${edge.length} 個面共用一條邊，無法安全分離。請移除分叉內面或分開相交物件。`);
    stats.splitEdges++;
  }
  faces.forEach((f, i) => { if (flip[i]) { [f[1], f[2]] = [f[2], f[1]]; stats.flippedFaces++; } });
  const boundary = groups.map(() => new Map());
  for (const edge of edges.values()) if (edge.length === 1) {
    const e = edge[0], from = flip[e.face] ? e.to : e.from, to = flip[e.face] ? e.from : e.to;
    const map = boundary[component[e.face]];
    if (map.has(from)) throw failure('開口邊界分叉，不能確定補面範圍。');
    map.set(from, to);
  }
  const loops = [];
  boundary.forEach((map, group) => {
    while (map.size) {
      const start = map.keys().next().value, loop = []; let next = start;
      do {
        if (!map.has(next) || loop.length > 2048) throw failure('開口不是簡單閉合環，或超過 2,048 個邊界頂點。');
        loop.push(next); const to = map.get(next); map.delete(next); next = to;
      } while (next !== start);
      loop.reverse(); // Cap half-edges must oppose the existing surface half-edges.
      const box = new Box3().setFromPoints(loop.map(i => vertices[i]));
      const size = box.getSize(new Vector3()).length();
      if (maxHoleSize === 0 || size > maxHoleSize) throw failure(`開口包圍盒對角線 ${size.toFixed(2)} mm 超過補洞上限 ${maxHoleSize} mm；確認造型後可提高上限重試。`);
      const normal = new Vector3(), origin = vertices[loop[0]];
      for (let i = 0; i < loop.length; i++) {
        a.subVectors(vertices[loop[i]], origin); b.subVectors(vertices[loop[(i + 1) % loop.length]], origin); normal.add(c.crossVectors(a, b));
      }
      if (normal.lengthSq() < weldTolerance ** 4) throw failure('開口輪廓退化或自交。');
      normal.normalize();
      const planeTolerance = Math.max(.01, weldTolerance * 2);
      if (loop.some(i => Math.abs(a.subVectors(vertices[i], origin).dot(normal)) > planeTolerance)) throw failure('開口不在同一平面（偏差大於 ' + planeTolerance + ' mm），請先修整破面。');
      const u = a.subVectors(vertices[loop[1]], origin).normalize().clone(), v = new Vector3().crossVectors(normal, u);
      const points = loop.map(i => { a.subVectors(vertices[i], origin); return new Vector2(a.dot(u), a.dot(v)); });
      loops.push({ loop, group, normal, origin, u, v, points });
    }
  });
  // A nested rim needs a surface with holes; do not silently seal it with overlapping disks.
  const inside = (p, polygon) => {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result;
    }
    return result;
  };
  for (const cap of loops) {
    for (const other of loops) if (other !== cap && Math.abs(cap.normal.dot(other.normal)) > .99999 && Math.abs(a.subVectors(other.origin, cap.origin).dot(cap.normal)) < .01) {
      a.subVectors(other.origin, cap.origin);
      if (inside(new Vector2(a.dot(cap.u), a.dot(cap.v)), cap.points)) throw failure('發現嵌套開口；需保留內外輪廓，不能用單面安全補洞。');
    }
    const triangles = ShapeUtils.triangulateShape(cap.points, []);
    const area = triangles.reduce((sum, f) => sum + Math.abs(ShapeUtils.area(f.map(i => cap.points[i]))), 0);
    if (triangles.length !== cap.loop.length - 2 || Math.abs(area - Math.abs(ShapeUtils.area(cap.points))) > Math.max(1e-8, area * 1e-6)) throw failure('開口無法完整三角化，可能有自交或重複邊界。');
    for (const f of triangles) {
      const face = f.map(i => cap.loop[i]);
      a.subVectors(vertices[face[1]], vertices[face[0]]); b.subVectors(vertices[face[2]], vertices[face[0]]);
      if (c.crossVectors(a, b).dot(cap.normal) < 0) [face[1], face[2]] = [face[2], face[1]];
      groups[cap.group].push(faces.length); faces.push(face);
    }
    stats.filledHoles++;
  }
  // Keep cavities negative: determine containment instead of making every shell positive.
  const groupBoxes = groups.map(ids => new Box3().setFromPoints(ids.flatMap(i => faces[i].map(v => vertices[v]))));
  const soups = groups.map(ids => Float32Array.from(ids.flatMap(i => faces[i].flatMap(v => vertices[v].toArray()))));
  const geometries = soups.map(p => new BufferGeometry().setAttribute('position', new BufferAttribute(p, 3)));
  try {
    const bvhs = geometries.map(g => new MeshBVH(g)), direction = new Vector3(1, .371, .529).normalize();
    soups.forEach((p, group) => {
      a.fromArray(p, 0); b.fromArray(p, 3); c.fromArray(p, 6);
      const ray = new Ray(a.clone().add(b).add(c).multiplyScalar(1 / 3), direction);
      let depth = 0;
      groupBoxes.forEach((box, other) => {
        if (other === group || !box.containsBox(groupBoxes[group])) return;
        const hits = bvhs[other].raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
        const unique = hits.filter((h, i) => !i || h.distance - hits[i - 1].distance > weldTolerance);
        if (unique.length % 2) depth++;
      });
      let volume = 0;
      const origin = groupBoxes[group].getCenter(new Vector3());
      for (let i = 0; i < p.length; i += 9) { a.fromArray(p, i).sub(origin); b.fromArray(p, i + 3).sub(origin); c.fromArray(p, i + 6).sub(origin); volume += a.dot(b.cross(c)) / 6; }
      if (Math.abs(volume) <= weldTolerance ** 3) throw failure('表面沒有封閉體積，單層平面需要先建成有厚度的牆。');
      if ((volume > 0) !== (depth % 2 === 0)) {
        for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) [p[i + 3 + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + 3 + k]];
        for (const face of groups[group]) if (face < flip.length) stats.flippedFaces += flip[face] ? -1 : 1;
      }
    });
  } finally { geometries.forEach(g => g.dispose()); }
  // Each shell has its own indices, including shells which only touch along an edge.
  const properties = [], indices = [];
  for (const soup of soups) {
    const ids = new Map();
    for (let i = 0; i < soup.length; i += 3) {
      const key = `${soup[i]},${soup[i + 1]},${soup[i + 2]}`;
      if (!ids.has(key)) { ids.set(key, properties.length / 3); properties.push(soup[i], soup[i + 1], soup[i + 2]); }
      indices.push(ids.get(key));
    }
  }
  return { vertProperties: new Float32Array(properties), triVerts: new Uint32Array(indices), stats };
}

const MAX_NODES = 24_000_000, MAX_OUTPUT_TRIANGLES = 400_000;

// Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
function triangleDistanceSq(px, py, pz, t, o) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const abx = t[o + 3] - ax, aby = t[o + 4] - ay, abz = t[o + 5] - az, acx = t[o + 6] - ax, acy = t[o + 7] - ay, acz = t[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v; // p = a + u·ab + v·ac
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
  else {
    const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
    else if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - v; }
    else { const sum = va + vb + vc; if (!sum) { u = 0; v = 0; } else { u = vb / sum; v = vc / sum; } }
  }
  const dx = apx - u * abx - v * acx, dy = apy - u * aby - v * acy, dz = apz - u * abz - v * acz;
  return dx * dx + dy * dy + dz * dz;
}

// Closed, consistently oriented shells thinner than `thinBelow` (mullions, railings, panes) are
// below grid resolution; they are kept exactly instead of being blurred by the distance field.
function thinClosedShells(module, p, weldTolerance, thinBelow, keep) {
  const ids = new Map(), vertex = new Int32Array(p.length / 3);
  for (let i = 0; i < vertex.length; i++) {
    const key = `${Math.round(p[i * 3] / weldTolerance)},${Math.round(p[i * 3 + 1] / weldTolerance)},${Math.round(p[i * 3 + 2] / weldTolerance)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    vertex[i] = ids.get(key);
  }
  const parent = Int32Array.from({ length: ids.size }, (_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let i = 0; i < vertex.length; i += 3) { parent[find(vertex[i + 1])] = find(vertex[i]); parent[find(vertex[i + 2])] = find(vertex[i]); }
  const groups = new Map();
  for (let f = 0; f < vertex.length / 3; f++) {
    const root = find(vertex[f * 3]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  const shells = [], thinFace = new Uint8Array(vertex.length / 3);
  for (const faces of groups.values()) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of faces) for (let i = f * 9; i < f * 9 + 9; i++) { const k = i % 3; lo[k] = Math.min(lo[k], p[i]); hi[k] = Math.max(hi[k], p[i]); }
    if (Math.min(...hi.map((h, k) => h - lo[k])) >= thinBelow) continue;
    const half = new Set(); let closed = true;
    for (const f of faces) for (let k = 0; k < 3 && closed; k++) {
      const a = vertex[f * 3 + k], b = vertex[f * 3 + (k + 1) % 3], key = `${a},${b}`;
      if (a === b || half.has(key)) closed = false; else half.add(key);
    }
    if (!closed) continue;
    for (const key of half) { const [a, b] = key.split(','); if (!half.has(`${b},${a}`)) { closed = false; break; } }
    if (!closed) continue;
    const triVerts = new Uint32Array(faces.length * 3), local = new Map(), props = [];
    faces.forEach((f, i) => { for (let k = 0; k < 3; k++) {
      const v = vertex[f * 3 + k];
      if (!local.has(v)) { local.set(v, local.size); props.push(p[f * 9 + k * 3], p[f * 9 + k * 3 + 1], p[f * 9 + k * 3 + 2]); }
      triVerts[i * 3 + k] = local.get(v);
    } });
    let m;
    try { m = keep(new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: new Float32Array(props), triVerts }))); }
    catch (error) { if (error.code === 'NotManifold') continue; throw error; }
    if (m.volume() < 0) { // Inverted shell: reverse winding.
      for (let i = 0; i < triVerts.length; i += 3) [triVerts[i + 1], triVerts[i + 2]] = [triVerts[i + 2], triVerts[i + 1]];
      m = keep(new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: new Float32Array(props), triVerts })));
    }
    if (!(m.volume() > 0)) continue;
    shells.push(m);
    for (const f of faces) thinFace[f] = 1;
  }
  return { shells, thinFace };
}

// Approximate rescue for SketchUp-style triangle soups (open seams, branched edges, inverted or
// zero-thickness faces). Inside/outside comes from flood-filling the exterior on a grid, so face
// orientation and topology are ignored; the distance to the nearest triangle gives the surface
// sub-grid position. Openings narrower than `sealGap` (at least about two grid steps) are closed
// morphologically; wider ones let the exterior in and those spaces stay hollow.
export function reconstructMesh(module, parts, { minWall = .8, weldTolerance = .001, sealGap = 0 } = {}) {
  if (!Number.isFinite(minWall) || minWall < .1 || minWall > 20) throw failure('壁厚需介於 0.1–20 mm。');
  if (!Number.isFinite(sealGap) || sealGap < 0 || sealGap > 20) throw new RangeError('封閉開口寬度需為 0–20 mm。');
  const p = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { p.set(part, offset); offset += part.length; }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { const k = i % 3; if (p[i] < lo[k]) lo[k] = p[i]; if (p[i] > hi[k]) hi[k] = p[i]; }
  // Distances are tracked within `band`; two extra nodes of padding keep the grid border exterior.
  const bandFor = h => Math.max(h * 2, Math.max(h, sealGap / 2) + h), padFor = h => Math.ceil(bandFor(h) / h) + 2;
  const dimsFor = h => lo.map((l, k) => Math.ceil((hi[k] - l) / h) + 1 + padFor(h) * 2);
  let step = minWall / 2;
  while (dimsFor(step).reduce((a, b) => a * b) > MAX_NODES) step *= 1.05;
  const radius = step * .75, seal = Math.max(step, sealGap / 2), band = bandFor(step);
  const [nx, ny, nz] = dimsFor(step), nxy = nx * ny, n = nxy * nz, origin = lo.map(l => l - step * padFor(step));
  const keep = [], owned = m => { keep.push(m); return m; };
  try {
    const { shells, thinFace } = thinClosedShells(module, p, weldTolerance, step * 2, owned);
    // Unsigned distance within the band, quantized to 254 levels; 255 = farther than the band.
    // Node state: 0 unknown, 1 exterior, 2 exterior after un-sealing, 3 blocked by a thin exact shell.
    const dist = new Uint8Array(n).fill(255), qScale = 254 / band, state = new Uint8Array(n);
    for (let t = 0; t < p.length; t += 9) {
      const thin = thinFace[t / 9], reach = thin ? seal : band;
      const ex1 = p[t + 3] - p[t], ey1 = p[t + 4] - p[t + 1], ez1 = p[t + 5] - p[t + 2], ex2 = p[t + 6] - p[t], ey2 = p[t + 7] - p[t + 1], ez2 = p[t + 8] - p[t + 2];
      let cx = ey1 * ez2 - ez1 * ey2, cy = ez1 * ex2 - ex1 * ez2, cz = ex1 * ey2 - ey1 * ex2;
      const area = Math.hypot(cx, cy, cz); if (area > 0) { cx /= area; cy /= area; cz /= area; }
      const range = k => {
        const a = Math.min(p[t + k], p[t + 3 + k], p[t + 6 + k]), b = Math.max(p[t + k], p[t + 3 + k], p[t + 6 + k]);
        return [Math.max(0, Math.floor((a - reach - origin[k]) / step)), Math.min([nx, ny, nz][k] - 1, Math.ceil((b + reach - origin[k]) / step))];
      };
      const [i0, i1] = range(0), [j0, j1] = range(1), [k0, k1] = range(2);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = origin[0] + i * step, y = origin[1] + j * step, z = origin[2] + k * step;
        if (area > 0 && Math.abs((x - p[t]) * cx + (y - p[t + 1]) * cy + (z - p[t + 2]) * cz) > reach) continue;
        const d2 = triangleDistanceSq(x, y, z, p, t), id = i + j * nx + k * nxy;
        if (d2 > reach * reach) continue;
        if (thin) { state[id] = 3; continue; }
        const q = Math.round(Math.sqrt(d2) * qScale);
        if (q < dist[id]) dist[id] = q;
      }
    }
    const qSeal = Math.floor(seal * qScale), qRadius = Math.floor(radius * qScale);
    const flood = (seeds, enter, mark) => {
      let queue = new Int32Array(1 << 20), head = 0, tail = 0, size = 0;
      const push = (id, seed) => {
        if (!seed && !enter(id)) return;
        state[id] = mark;
        if (size === queue.length) { const grown = new Int32Array(queue.length * 2); for (let i = 0; i < size; i++) grown[i] = queue[(head + i) % queue.length]; queue = grown; head = 0; tail = size; }
        queue[tail] = id; tail = (tail + 1) % queue.length; size++;
      };
      for (const id of seeds) push(id, true);
      while (size) {
        const id = queue[head]; head = (head + 1) % queue.length; size--;
        const i = id % nx, j = (id / nx | 0) % ny, k = id / nxy | 0;
        if (i > 0) push(id - 1); if (i < nx - 1) push(id + 1);
        if (j > 0) push(id - nx); if (j < ny - 1) push(id + nx);
        if (k > 0) push(id - nxy); if (k < nz - 1) push(id + nxy);
      }
    };
    // Flood the exterior from a padded corner; nodes within `seal` of any triangle block it.
    flood([0], id => state[id] === 0 && dist[id] > qSeal, 1);
    // Closing: grow the exterior back by `seal`. Exterior nodes are farther than `seal` from every
    // triangle and each layer moves one step, so the growth cannot cross a surface; a sealed opening
    // keeps a cap, dimpled up to `seal` deep.
    const exterior = v => v === 1 || v === 2, unsealed = [];
    for (let layer = 0; layer < Math.floor(seal / step + 1e-9); layer++) {
      const added = [];
      for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const id = i + j * nx + k * nxy;
        if (!exterior(state[id]) && (exterior(state[id - 1]) || exterior(state[id + 1]) || exterior(state[id - nx]) || exterior(state[id + nx]) || exterior(state[id - nxy]) || exterior(state[id + nxy]))) added.push(id);
      }
      for (const id of added) { state[id] = 2; unsealed.push(id); }
    }
    // Thin exact shells block the flood but must not grow a grid surface around themselves.
    flood(unsealed, id => state[id] === 3 && dist[id] > qRadius, 2);
    let enclosed = 0;
    for (let id = 0; id < n; id++) if ((state[id] === 0 || state[id] === 3) && dist[id] === 255) enclosed++;
    // Positive inside: enclosed nodes, and every node within `radius` of a triangle (sheets become slabs).
    const field = id => { const d = dist[id] / qScale; return state[id] === 1 || state[id] === 2 ? radius - d : radius + d; };
    const approx = owned(module.Manifold.levelSet(([x, y, z]) => {
      const fx = Math.min(Math.max((x - origin[0]) / step, 0), nx - 1.000001), fy = Math.min(Math.max((y - origin[1]) / step, 0), ny - 1.000001), fz = Math.min(Math.max((z - origin[2]) / step, 0), nz - 1.000001);
      const i = fx | 0, j = fy | 0, k = fz | 0, u = fx - i, v = fy - j, w = fz - k, id = i + j * nx + k * nxy;
      const c00 = field(id) * (1 - u) + field(id + 1) * u, c10 = field(id + nx) * (1 - u) + field(id + nx + 1) * u;
      const c01 = field(id + nxy) * (1 - u) + field(id + nxy + 1) * u, c11 = field(id + nxy + nx) * (1 - u) + field(id + nxy + nx + 1) * u;
      return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
    }, { min: origin, max: origin.map((o, k) => o + ([nx, ny, nz][k] - 1) * step) }, step));
    // Simplify before the union so the exact shells are not re-simplified with the grid surface.
    let simplification = step / 10, reduced = owned(approx.simplify(simplification));
    // Each pass works on the previous result; accumulated deviation stays below 3 × the last tolerance.
    while (reduced.numTri() > MAX_OUTPUT_TRIANGLES && simplification < step) { simplification *= 1.5; reduced = owned(reduced.simplify(simplification)); }
    const solid = module.Manifold.union([reduced, ...shells]);
    return { solid, step, radius, seal, sealGap, simplification: simplification * 3, closedShells: shells.length, grid: [nx, ny, nz], enclosedFraction: enclosed / n };
  } finally { keep.forEach(m => m.delete()); }
}
