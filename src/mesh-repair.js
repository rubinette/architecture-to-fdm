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

// Exact solids for the cells that welded faces enclose. Around each edge the faces are sorted by
// angle, and the two face sides bounding the wedge between neighbours lie on the same cell, so
// connected face sides are one cell's boundary. A cell with positive volume is bounded and becomes
// a solid, however its faces were wound and however many faces meet along its edges.
function cellSolids(module, p, vertex, normal, vertexCount, keep) {
  const F = vertex.length / 3, seen = new Set(), edges = new Map();
  for (let f = 0; f < F; f++) {
    const v = [vertex[f * 3], vertex[f * 3 + 1], vertex[f * 3 + 2]], key = [...v].sort((x, y) => x - y).join(',');
    if ((!normal[f * 3] && !normal[f * 3 + 1] && !normal[f * 3 + 2]) || seen.has(key)) continue;
    seen.add(key);
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], e = a < b ? a * vertexCount + b : b * vertexCount + a;
      let list = edges.get(e);
      if (!list) edges.set(e, list = []);
      list.push(f * 3 + k);
    }
  }
  // Per edge, entries f * 8 + k * 2 + up in angular order; `up` is the face side (0 front, 1 back)
  // that looks towards increasing angle.
  const side = new Int32Array(F * 2).map((_, i) => i), find = (set, x) => { while (set[x] !== x) x = set[x] = set[set[x]]; return x; };
  const rings = [];
  for (const list of edges.values()) {
    const f0 = list[0] / 3 | 0, k0 = list[0] % 3, u0 = vertex[f0 * 3 + k0], v0 = vertex[f0 * 3 + (k0 + 1) % 3], low = u0 < v0 ? k0 : (k0 + 1) % 3, high = u0 < v0 ? (k0 + 1) % 3 : k0;
    const a = f0 * 9 + low * 3, ex = p[f0 * 9 + high * 3] - p[a], ey = p[f0 * 9 + high * 3 + 1] - p[a + 1], ez = p[f0 * 9 + high * 3 + 2] - p[a + 2];
    let ux = 0, uy = 0, uz = 0, vx = 0, vy = 0, vz = 0;
    const ring = list.map((entry, i) => {
      const f = entry / 3 | 0, k = entry % 3, w = f * 9 + (k + 2) % 3 * 3, wx = p[w] - p[a], wy = p[w + 1] - p[a + 1], wz = p[w + 2] - p[a + 2];
      const along = (wx * ex + wy * ey + wz * ez) / (ex * ex + ey * ey + ez * ez), rx = wx - ex * along, ry = wy - ey * along, rz = wz - ez * along;
      const tx = ey * rz - ez * ry, ty = ez * rx - ex * rz, tz = ex * ry - ey * rx; // Direction of increasing angle at this face.
      if (!i) { ux = rx; uy = ry; uz = rz; vx = tx; vy = ty; vz = tz; }
      const up = tx * normal[f * 3] + ty * normal[f * 3 + 1] + tz * normal[f * 3 + 2] > 0 ? 0 : 1;
      return { code: f * 8 + k * 2 + up, angle: i ? Math.atan2((rx * vx + ry * vy + rz * vz) / Math.hypot(vx, vy, vz), (rx * ux + ry * uy + rz * uz) / Math.hypot(ux, uy, uz)) : 0 };
    });
    if (ring.length > 2) ring.sort((x, y) => x.angle - y.angle);
    const codes = ring.map(r => r.code);
    rings.push(codes);
    codes.forEach((code, i) => {
      const next = codes[(i + 1) % codes.length];
      side[find(side, (next >> 3) * 2 + 1 - (next & 1))] = find(side, (code >> 3) * 2 + (code & 1));
    });
  }
  // Signed volume with normals pointing out of the cell: positive for bounded cells.
  const volume = new Float64Array(F * 2), members = new Map();
  for (const f of new Set(rings.flatMap(codes => codes.map(code => code >> 3)))) {
    const t = f * 9, bx = p[t + 3] - p[t], by = p[t + 4] - p[t + 1], bz = p[t + 5] - p[t + 2], cx = p[t + 6] - p[t], cy = p[t + 7] - p[t + 1], cz = p[t + 8] - p[t + 2];
    const det = (p[t] - p[0]) * (by * cz - bz * cy) + (p[t + 1] - p[1]) * (bz * cx - bx * cz) + (p[t + 2] - p[2]) * (bx * cy - by * cx);
    const front = find(side, f * 2), back = find(side, f * 2 + 1);
    if (front === back) continue; // Both sides in one cell: a flap or buried sheet, not a boundary.
    volume[front] -= det / 6; volume[back] += det / 6;
    for (const h of [f * 2, f * 2 + 1]) { const r = h & 1 ? back : front; if (!members.has(r)) members.set(r, []); members.get(r).push(h); }
  }
  const bounded = h => { const r = find(side, h); return volume[r] > 1e-9 && find(side, h ^ 1) !== r; };
  // Mesh corners: joined across each edge with the neighbour that bounds the same wedge of the cell,
  // so a cell touching itself along an edge or at a vertex still gets a 2-manifold mesh.
  const corner = new Int32Array(F * 6).map((_, i) => i), bad = new Set();
  const at = (f, id) => vertex[f * 3] === id ? 0 : vertex[f * 3 + 1] === id ? 1 : 2;
  for (const codes of rings) {
    const f0 = codes[0] >> 3, k0 = codes[0] >> 1 & 3, a = vertex[f0 * 3 + k0], b = vertex[f0 * 3 + (k0 + 1) % 3], events = [];
    for (const code of codes) { // Going round the edge, each face shows its backward-looking side first.
      const f = code >> 3, up = code & 1;
      if (bounded(f * 2 + 1 - up)) events.push((f * 2 + 1 - up) * 2);
      if (bounded(f * 2 + up)) events.push((f * 2 + up) * 2 + 1);
    }
    events.forEach((event, i) => {
      if (!(event & 1)) return;
      const h = event >> 1, r = find(side, h);
      for (let step = 1; step <= events.length; step++) {
        const other = events[(i + step) % events.length], g = other >> 1;
        if (find(side, g) !== r) continue;
        if (other & 1 || g === h) bad.add(r);
        else for (const id of [a, b]) corner[find(corner, g * 3 + at(g >> 1, id))] = find(corner, h * 3 + at(h >> 1, id));
        return;
      }
    });
  }
  const solids = [], good = new Set();
  for (const [r, halves] of members) {
    if (!(volume[r] > 1e-9) || bad.has(r)) continue;
    const local = new Map(), vertProperties = [], triVerts = [];
    for (const h of halves) {
      const f = h >> 1, v = [0, 1, 2].map(k => {
        const id = find(corner, h * 3 + k);
        if (!local.has(id)) { local.set(id, local.size); vertProperties.push(p[f * 9 + k * 3], p[f * 9 + k * 3 + 1], p[f * 9 + k * 3 + 2]); }
        return local.get(id);
      });
      if (h & 1) triVerts.push(v[0], v[1], v[2]); else triVerts.push(v[0], v[2], v[1]);
    }
    try {
      const m = keep(new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: Float32Array.from(vertProperties), triVerts: Uint32Array.from(triVerts) })));
      if (!(m.volume() > 0)) continue;
      solids.push(m);
    } catch (error) { if (error.code !== 'NotManifold') throw error; continue; }
    good.add(r);
  }
  // Face sides (f * 2 front, f * 2 + 1 back) that look into a solid cell, sheets inside one included.
  const inCell = new Uint8Array(F * 2);
  for (const codes of rings) for (const code of codes) for (const h of [(code >> 3) * 2, (code >> 3) * 2 + 1]) if (good.has(find(side, h))) inCell[h] = 1;
  return { solids, inCell };
}

// Union of many solids. Small neighbours in space are merged first, level by level, so each
// boolean only meets the few solids around it; solids spanning much of the model join at the end.
function unionNearby(module, solids, keep) {
  const boxes = solids.map(m => m.boundingBox()), lo = [0, 1, 2].map(k => boxes.reduce((v, b) => Math.min(v, b.min[k]), Infinity));
  const size = Math.max(1e-9, ...[0, 1, 2].map(k => boxes.reduce((v, b) => Math.max(v, b.max[k]), -Infinity) - lo[k]));
  const spread = v => { v = (v | v << 16) & 0x030000ff; v = (v | v << 8) & 0x0300f00f; v = (v | v << 4) & 0x030c30c3; return (v | v << 2) & 0x09249249; };
  const code = boxes.map(b => { const [x, y, z] = [0, 1, 2].map(k => Math.min(1023, ((b.min[k] + b.max[k]) / 2 - lo[k]) / size * 1024 | 0)); return spread(x) | spread(y) << 1 | spread(z) << 2; });
  const large = [], small = [];
  boxes.forEach((b, i) => (Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) > size / 8 ? large : small).push(i));
  let level = small.sort((a, b) => code[a] - code[b]).map(i => solids[i]);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 4) {
      const group = level.slice(i, i + 4), m = group.length > 1 ? keep(module.Manifold.union(group)) : group[0];
      m.numTri(); // Evaluate now; a deferred union would flatten the tree back into one pass.
      next.push(m);
    }
    level = next;
  }
  const rest = [...level, ...large.map(i => solids[i])];
  return rest.length > 1 ? keep(module.Manifold.union(rest)) : rest[0];
}

// Fills sealed voids: drops inward-facing shells, anything floating inside them, and specks
// below 0.001 mm³. Returns null when there is nothing to drop.
function fillVoids(module, solid) {
  const mesh = solid.getMesh(), tri = mesh.triVerts, np = mesh.numProp, vp = mesh.vertProperties;
  const parent = Int32Array.from({ length: vp.length / np }, (_, i) => i), find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (let i = 0; i < tri.length; i += 3) { parent[find(tri[i + 1])] = find(tri[i]); parent[find(tri[i + 2])] = find(tri[i]); }
  const shells = new Map(), at = (i, k) => vp[tri[i] * np + k];
  for (let i = 0; i < tri.length; i += 3) {
    const r = find(tri[i]);
    let shell = shells.get(r);
    if (!shell) shells.set(r, shell = { volume: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], faces: [] });
    const a = [0, 1, 2].map(k => at(i, k)), b = [0, 1, 2].map(k => at(i + 1, k)), c = [0, 1, 2].map(k => at(i + 2, k));
    shell.volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) { if (v[k] < shell.min[k]) shell.min[k] = v[k]; if (v[k] > shell.max[k]) shell.max[k] = v[k]; }
    shell.faces.push(i);
  }
  const all = [...shells.values()], voids = all.filter(s => s.volume < -1e-3), drop = new Set(all.filter(s => !(s.volume > 1e-3)));
  // A solid shell lies in a void when a point on it is inside the void's wall: odd crossings on most of three rays.
  const directions = [[.5131, .3714, .7738], [-.6421, .7003, .3118], [.2672, -.5345, .8018]].map(d => new Vector3(...d).normalize());
  for (const wall of voids) {
    const inside = all.filter(s => s.volume > 1e-3 && !drop.has(s) && s.min.every((v, k) => v >= wall.min[k]) && s.max.every((v, k) => v <= wall.max[k]));
    if (!inside.length) continue;
    const positions = new Float32Array(wall.faces.length * 9);
    wall.faces.forEach((i, f) => { for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) positions[f * 9 + c * 3 + k] = at(i + c, k); });
    const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
    try {
      const bvh = new MeshBVH(geometry, { maxDepth: 80, verbose: false }), ray = new Ray();
      for (const shell of inside) {
        const i = shell.faces[0];
        ray.origin.set((at(i, 0) + at(i + 1, 0) + at(i + 2, 0)) / 3, (at(i, 1) + at(i + 1, 1) + at(i + 2, 1)) / 3, (at(i, 2) + at(i + 1, 2) + at(i + 2, 2)) / 3);
        let odd = 0;
        for (const direction of directions) {
          ray.direction.copy(direction);
          const hits = bvh.raycast(ray, DoubleSide).map(h => h.distance).sort((a, b) => a - b);
          odd += hits.filter((d, n) => !n || d - hits[n - 1] > 1e-6).length % 2;
        }
        if (odd > 1) drop.add(shell);
      }
    } finally { geometry.dispose(); }
  }
  if (!drop.size) return null;
  const kept = [];
  for (const shell of all) if (!drop.has(shell)) for (const i of shell.faces) kept.push(tri[i], tri[i + 1], tri[i + 2]);
  return new module.Manifold(new module.Mesh({ numProp: np, vertProperties: vp, triVerts: Uint32Array.from(kept) }));
}

// Rescue for SketchUp-style triangle soups (open seams, branched edges, inverted or zero-thickness
// faces) that keeps the original faces as the visible surface:
// 1. Every cell the welded faces enclose becomes an exact solid (`cellSolids`).
// 2. A grid flood from outside decides which side of every remaining face is exterior. Openings
//    narrower than `sealGap` (at least two grid steps) stop it, so cracks do not let it into the
//    room behind.
// 3. Faces between the exterior and enclosed space are extruded inward, free-standing sheets become
//    slabs centred on the face, and enclosed space is filled by a coarse grid core that stays
//    behind every face, so grid surface only shows where it closes an opening.
export function reconstructMesh(module, parts, { minWall = .8, weldTolerance = .001, sealGap = 0 } = {}) {
  if (!Number.isFinite(minWall) || minWall < .1 || minWall > 20) throw failure('壁厚需介於 0.1–20 mm。');
  if (!Number.isFinite(sealGap) || sealGap < 0 || sealGap > 20) throw new RangeError('封閉開口寬度需為 0–20 mm。');
  const p = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { p.set(part, offset); offset += part.length; }
  const F = p.length / 9, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { const k = i % 3; if (p[i] < lo[k]) lo[k] = p[i]; if (p[i] > hi[k]) hi[k] = p[i]; }
  // Distances are tracked within `band`; two extra nodes of padding keep the grid border exterior.
  const bandFor = h => Math.max(h * 2, Math.max(h, sealGap / 2) + h), padFor = h => Math.ceil(bandFor(h) / h) + 2;
  const dimsFor = h => lo.map((l, k) => Math.ceil((hi[k] - l) / h) + 1 + padFor(h) * 2);
  let step = minWall / 2;
  while (dimsFor(step).reduce((a, b) => a * b) > MAX_NODES) step *= 1.05;
  const depth = Math.max(minWall, step * 4), seal = Math.max(step, sealGap / 2), band = bandFor(step);
  const dims = dimsFor(step), [nx, ny, nz] = dims, nxy = nx * ny, n = nxy * nz, origin = lo.map(l => l - step * padFor(step));
  const keep = [], owned = m => { keep.push(m); return m; };
  try {
    // Unit normals (zero for faces that are degenerate, also after welding) and welded vertex ids.
    const normal = new Float64Array(F * 3), vertex = new Int32Array(F * 3), ids = new Map(), first = [];
    for (let f = 0; f < F; f++) {
      const t = f * 9, ex1 = p[t + 3] - p[t], ey1 = p[t + 4] - p[t + 1], ez1 = p[t + 5] - p[t + 2], ex2 = p[t + 6] - p[t], ey2 = p[t + 7] - p[t + 1], ez2 = p[t + 8] - p[t + 2];
      const cx = ey1 * ez2 - ez1 * ey2, cy = ez1 * ex2 - ex1 * ez2, cz = ex1 * ey2 - ey1 * ex2, length = Math.hypot(cx, cy, cz);
      if (length > weldTolerance ** 2) { normal[f * 3] = cx / length; normal[f * 3 + 1] = cy / length; normal[f * 3 + 2] = cz / length; }
      for (let k = 0; k < 3; k++) {
        const i = t + k * 3, key = `${Math.round(p[i] / weldTolerance)},${Math.round(p[i + 1] / weldTolerance)},${Math.round(p[i + 2] / weldTolerance)}`;
        let id = ids.get(key);
        if (id === undefined) { ids.set(key, id = first.length); first.push(i); }
        vertex[f * 3 + k] = id;
      }
      if (vertex[f * 3] === vertex[f * 3 + 1] || vertex[f * 3 + 1] === vertex[f * 3 + 2] || vertex[f * 3] === vertex[f * 3 + 2]) normal[f * 3] = normal[f * 3 + 1] = normal[f * 3 + 2] = 0;
    }
    const flat = f => !normal[f * 3] && !normal[f * 3 + 1] && !normal[f * 3 + 2];
    // 1. Exact solids for every cell the welded faces enclose.
    const { solids, inCell } = cellSolids(module, p, vertex, normal, first.length, owned), cells = solids.length;
    // 2. Unsigned distance within the band, quantized to 254 levels; 255 = farther than the band.
    const dist = new Uint8Array(n).fill(255), qScale = 254 / band, state = new Uint8Array(n);
    const nodes = (f, reach, visit) => {
      const t = f * 9, range = k => {
        const a = Math.min(p[t + k], p[t + 3 + k], p[t + 6 + k]), b = Math.max(p[t + k], p[t + 3 + k], p[t + 6 + k]);
        return [Math.max(0, Math.floor((a - reach - origin[k]) / step)), Math.min(dims[k] - 1, Math.ceil((b + reach - origin[k]) / step))];
      };
      const [i0, i1] = range(0), [j0, j1] = range(1), [k0, k1] = range(2), cx = normal[f * 3], cy = normal[f * 3 + 1], cz = normal[f * 3 + 2], plane = !flat(f);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = origin[0] + i * step, y = origin[1] + j * step, z = origin[2] + k * step;
        const s = plane ? (x - p[t]) * cx + (y - p[t + 1]) * cy + (z - p[t + 2]) * cz : 0;
        if (s > reach || s < -reach) continue;
        const d2 = triangleDistanceSq(x, y, z, p, t);
        if (d2 <= reach * reach) visit(i + j * nx + k * nxy, s, d2);
      }
    };
    for (let f = 0; f < F; f++) nodes(f, band, (id, s, d2) => { const q = Math.round(Math.sqrt(d2) * qScale); if (q < dist[id]) dist[id] = q; });
    // Node state: 0 enclosed, 1 exterior (flooded from a padded corner through nodes farther than
    // `seal` from every face), 2 exterior next to a surface.
    const qSeal = Math.floor(seal * qScale);
    let queue = new Int32Array(1 << 20), head = 0, tail = 0, size = 0;
    const push = id => {
      if (state[id] || dist[id] <= qSeal) return;
      state[id] = 1;
      if (size === queue.length) { const grown = new Int32Array(queue.length * 2); for (let i = 0; i < size; i++) grown[i] = queue[(head + i) % queue.length]; queue = grown; head = 0; tail = size; }
      queue[tail] = id; tail = (tail + 1) % queue.length; size++;
    };
    push(0);
    while (size) {
      const id = queue[head]; head = (head + 1) % queue.length; size--;
      const i = id % nx, j = (id / nx | 0) % ny, k = id / nxy | 0;
      if (i > 0) push(id - 1); if (i < nx - 1) push(id + 1);
      if (j > 0) push(id - nx); if (j < ny - 1) push(id + nx);
      if (k > 0) push(id - nxy); if (k < nz - 1) push(id + nxy);
    }
    queue = null;
    // Give the exterior back the layer the flood kept clear of: a node joins when a flooded node
    // lies within `seal` plus a grid diagonal and their two clearances add up to more than their
    // distance, which cannot hold across a surface. Openings the flood did not pass stay closed.
    const rho = seal + step * .87, reach = Math.ceil(rho / step), offsets = [];
    for (let c = -reach; c <= reach; c++) for (let b = -reach; b <= reach; b++) for (let a = -reach; a <= reach; a++) {
      const length = Math.hypot(a, b, c) * step;
      if (length > 0 && length <= rho) offsets.push([length, a + b * nx + c * nxy]);
    }
    offsets.sort((x, y) => x[0] - y[0]);
    const jump = Int32Array.from(offsets, o => o[1]), needed = Float64Array.from(offsets, o => o[0] * qScale + 1);
    for (let k = reach; k < nz - reach; k++) for (let j = reach; j < ny - reach; j++) for (let i = reach, id = reach + j * nx + k * nxy; i < nx - reach; i++, id++) {
      if (state[id] || dist[id] > qSeal) continue;
      for (let o = 0; o < jump.length; o++) if (state[id + jump[o]] === 1 && dist[id] + dist[id + jump[o]] > needed[o]) { state[id] = 2; break; }
    }
    let enclosed = 0;
    for (let id = 0; id < n; id++) if (!state[id] && dist[id] === 255) enclosed++;
    // Which sides of each remaining face see the exterior: nodes 0.6–1.6 steps off the face vote,
    // unless another surface is nearer to them than this face.
    const ext = new Uint8Array(F * 2), votes = [0, 0, 0, 0];
    for (let f = 0; f < F; f++) {
      if (flat(f)) continue;
      votes.fill(0);
      nodes(f, step * 1.6, (id, s, d2) => {
        const d = Math.sqrt(d2), side = s > 0 ? 0 : 1;
        if (Math.abs(s) < step * .6 || d > Math.abs(s) * 1.25 || dist[id] < d * qScale - 1.5) return;
        votes[side * 2 + (state[id] ? 0 : 1)]++;
      });
      for (let side = 0; side < 2; side++) {
        if (votes[side * 2] + votes[side * 2 + 1]) { ext[f * 2 + side] = votes[side * 2] >= votes[side * 2 + 1] ? 1 : 0; continue; }
        const t = f * 9, sign = side ? -step : step, at = k => Math.min(dims[k] - 1, Math.max(0, Math.round(((p[t + k] + p[t + 3 + k] + p[t + 6 + k]) / 3 + normal[f * 3 + k] * sign - origin[k]) / step)));
        ext[f * 2 + side] = state[at(0) + at(1) * nx + at(2) * nxy] ? 1 : 0;
      }
    }
    // 3a. Skin. Each face side looks into the exterior (X), a solid cell (C) or other enclosed
    // space (R, filled by the core). kind 2: X on both sides, a slab centred on the face.
    // kind 1: X on one side and, within `depth` behind the face, enclosed space that no cell fills;
    // extruded inward to meet the core, but never through another surface that faces the exterior.
    // `out` is the unit normal towards the exterior (as wound for kind 2).
    const X = 1, C = 2, R = 3, look = h => inCell[h] ? C : ext[h] ? X : R;
    const kind = new Uint8Array(F), out = new Float64Array(F * 3), deep = new Float64Array(F).fill(depth), solo = new Uint8Array(F), trims = new Map();
    const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(Float32Array.from(p), 3));
    try {
      const bvh = new MeshBVH(geometry, { maxDepth: 80, verbose: false }), order = geometry.index.array, ray = new Ray(), near = Math.max(1e-3, weldTolerance * 10);
      for (let f = 0; f < F; f++) {
        if (flat(f)) continue;
        const front = look(f * 2), back = look(f * 2 + 1);
        if (front !== X && back !== X) continue;
        const sign = front === X ? 1 : -1;
        for (let k = 0; k < 3; k++) out[f * 3 + k] = normal[f * 3 + k] * sign;
        if (front === back) { kind[f] = 2; continue; }
        const t = f * 9, c = [0, 1, 2].map(k => (p[t + k] + p[t + 3 + k] + p[t + 6 + k]) / 3);
        if ((front === X ? back : front) !== R) continue; // A solid cell is behind it already.
        kind[f] = 1;
        ray.direction.set(-out[f * 3], -out[f * 3 + 1], -out[f * 3 + 2]);
        for (let sample = 0; sample < 4; sample++) {
          const w = sample < 3 ? .85 : 0, v = t + (sample % 3) * 3;
          ray.origin.set(c[0] + (p[v] - c[0]) * w, c[1] + (p[v + 1] - c[1]) * w, c[2] + (p[v + 2] - c[2]) * w);
          for (const hit of bvh.raycast(ray, DoubleSide, near, deep[f]).sort((a, b) => a.distance - b.distance)) {
            const g = order[hit.faceIndex * 3] / 3 | 0;
            if (hit.distance >= deep[f]) break;
            if (g === f || flat(g) || vertex[g * 3] === vertex[f * 3] || vertex[g * 3] === vertex[f * 3 + 1] || vertex[g * 3] === vertex[f * 3 + 2] || vertex[g * 3 + 1] === vertex[f * 3] || vertex[g * 3 + 1] === vertex[f * 3 + 1] || vertex[g * 3 + 1] === vertex[f * 3 + 2] || vertex[g * 3 + 2] === vertex[f * 3] || vertex[g * 3 + 2] === vertex[f * 3 + 1] || vertex[g * 3 + 2] === vertex[f * 3 + 2]) continue;
            const leaving = normal[g * 3] * ray.direction.x + normal[g * 3 + 1] * ray.direction.y + normal[g * 3 + 2] * ray.direction.z > 0 ? 0 : 1;
            if (look(g * 2 + leaving) === X) { deep[f] = hit.distance; break; }
          }
          // Exterior nodes behind the face mean it is a thin part: give it wall thickness only.
          for (const reach of [deep[f] / 2, deep[f]]) {
            const node = k => Math.min(dims[k] - 1, Math.max(0, Math.round((ray.origin.getComponent(k) + ray.direction.getComponent(k) * reach - origin[k]) / step)));
            if (state[node(0) + node(1) * nx + node(2) * nxy]) deep[f] = Math.min(deep[f], minWall);
          }
        }
      }
    } finally { geometry.dispose(); }
    const edges = new Map(), V = first.length;
    for (let f = 0; f < F; f++) {
      if (!kind[f]) continue;
      for (let k = 0; k < 3; k++) {
        const a = vertex[f * 3 + k], b = vertex[f * 3 + (k + 1) % 3], key = a < b ? a * V + b : b * V + a;
        let list = edges.get(key);
        if (!list) edges.set(key, list = []);
        list.push(f * 3 + k);
      }
    }
    // 3b. Core: fills enclosed space on a grid twice as coarse. It is built from nodes with no
    // exterior node within two steps on any axis, so it stays behind every face and the
    // extrusions hide it; it is only visible where it closes an opening the flood did not pass.
    let coreSolid = null;
    if (enclosed) {
      const deepNode = dist; // The distances are no longer needed.
      for (let id = 0; id < n; id++) deepNode[id] = state[id] ? 0 : 1;
      for (let pass = 0; pass < 2; pass++) for (const stride of [1, nx, nxy]) {
        for (let id = 0; id < n; id++) state[id] = deepNode[id] && id >= stride && id + stride < n && deepNode[id - stride] && deepNode[id + stride] ? 1 : 0;
        deepNode.set(state);
      }
      const even = dims.map(d => d - 1 - (d - 1) % 2);
      // Samples fall on grid nodes; averaging the 27 surrounding nodes gives flat faces a linear ramp.
      const core = owned(module.Manifold.levelSet(([x, y, z]) => {
        const i = Math.round((x - origin[0]) / step), j = Math.round((y - origin[1]) / step), k = Math.round((z - origin[2]) / step);
        if (i < 1 || j < 1 || k < 1 || i > nx - 2 || j > ny - 2 || k > nz - 2) return -.5;
        let sum = 0;
        for (let id = i - 1 + (j - 1) * nx + (k - 1) * nxy, c = 0; c < 3; c++, id += nxy) for (let b = 0; b < 3; b++) { const row = id + b * nx; sum += deepNode[row] + deepNode[row + 1] + deepNode[row + 2]; }
        return sum / 27 - .5;
      }, { min: origin, max: origin.map((o, k) => o + even[k] * step) }, step * 2));
      coreSolid = owned(core.simplify(step / 4));
    }
    const dot = (f, g) => out[f * 3] * out[g * 3] + out[f * 3 + 1] * out[g * 3 + 1] + out[f * 3 + 2] * out[g * 3 + 2];
    // Signed height of face g's vertex opposite corner slot `gk` above face f's plane.
    const above = (f, g, gk) => { const w = g * 9 + (gk + 2) % 3 * 3, t = f * 9; return (p[w] - p[t]) * out[f * 3] + (p[w + 1] - p[t + 1]) * out[f * 3 + 1] + (p[w + 2] - p[t + 2]) * out[f * 3 + 2]; };
    // Along a sharp ridge each extrusion would pierce the other face: extrude those faces on their own and trim them.
    const eps = Math.max(1e-6, weldTolerance);
    for (const list of edges.values()) {
      if (list.length !== 2) continue;
      const f = list[0] / 3 | 0, g = list[1] / 3 | 0;
      if (kind[f] !== 1 || kind[g] !== 1 || !(above(f, g, list[1] % 3) < -eps && above(g, f, list[0] % 3) < -eps && dot(f, g) < -.01)) continue;
      solo[f] = solo[g] = 1;
      if (!trims.has(f)) trims.set(f, []); if (!trims.has(g)) trims.set(g, []);
      trims.get(f).push(g); trims.get(g).push(f);
    }
    // Coplanar neighbours of the same kind and depth share one extrusion.
    const patch = Int32Array.from({ length: F }, (_, i) => i), root = x => { while (patch[x] !== x) x = patch[x] = patch[patch[x]]; return x; };
    for (const list of edges.values()) for (let i = 1; i < list.length; i++) {
      const f = list[0] / 3 | 0, g = list[i] / 3 | 0;
      if (kind[f] === kind[g] && !solo[f] && !solo[g] && Math.abs(deep[f] - deep[g]) < 1e-4 && dot(f, g) > 1 - 1e-6) patch[root(g)] = root(f);
    }
    const patches = new Map();
    for (let f = 0; f < F; f++) if (kind[f]) { const r = root(f); if (!patches.has(r)) patches.set(r, []); patches.get(r).push(f); }
    const extrude = faces => {
      const f0 = faces[0], top = kind[f0] === 2 ? minWall / 2 : 0, bottom = kind[f0] === 2 ? -minWall / 2 : -deep[f0];
      const local = new Map(), props = [], tris = [], half = new Set();
      for (const f of faces) {
        const v = [0, 1, 2].map(k => {
          const id = vertex[f * 3 + k];
          if (!local.has(id)) { local.set(id, local.size); props.push(p[first[id]], p[first[id] + 1], p[first[id] + 2]); }
          return local.get(id);
        });
        if (out[f * 3] * normal[f * 3] + out[f * 3 + 1] * normal[f * 3 + 1] + out[f * 3 + 2] * normal[f * 3 + 2] < 0) [v[1], v[2]] = [v[2], v[1]]; // Wind the top face towards `out`.
        tris.push(v);
        for (let k = 0; k < 3; k++) half.add(v[k] * 4294967296 + v[(k + 1) % 3]);
      }
      const count = local.size, o = [out[f0 * 3], out[f0 * 3 + 1], out[f0 * 3 + 2]], vertProperties = new Float32Array(count * 6), triVerts = [];
      for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) { vertProperties[i * 3 + k] = props[i * 3 + k] + o[k] * top; vertProperties[(count + i) * 3 + k] = props[i * 3 + k] + o[k] * bottom; }
      for (const [a, b, c] of tris) {
        triVerts.push(a, b, c, count + a, count + c, count + b);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) if (!half.has(v * 4294967296 + u)) triVerts.push(v, u, count + u, v, count + u, count + v);
      }
      return owned(new module.Manifold(new module.Mesh({ numProp: 3, vertProperties, triVerts: Uint32Array.from(triVerts) })));
    };
    let skinFaces = 0, extrusions = 0;
    for (const faces of patches.values()) {
      skinFaces += faces.length;
      let made;
      try { made = [extrude(faces)]; if (!(made[0].volume() > 0)) throw Object.assign(new Error(), { code: 'NotManifold' }); }
      catch (error) {
        if (error.code !== 'NotManifold') throw error;
        made = [];
        if (faces.length > 1) for (const f of faces) try { made.push(extrude([f])); } catch (inner) { if (inner.code !== 'NotManifold') throw inner; }
      }
      if (faces.length === 1) for (const g of trims.get(faces[0]) ?? []) {
        const t = g * 9;
        made = made.map(m => owned(m.trimByPlane([-out[g * 3], -out[g * 3 + 1], -out[g * 3 + 2]], -(p[t] * out[g * 3] + p[t + 1] * out[g * 3 + 1] + p[t + 2] * out[g * 3 + 2]))));
      }
      for (const m of made) if (!m.isEmpty()) { solids.push(m); extrusions++; }
    }
    if (!solids.length) throw failure('沒有可重建的表面。');
    if (coreSolid) solids.push(coreSolid);
    const merged = unionNearby(module, solids, owned);
    const outer = fillVoids(module, merged), filled = outer ? owned(outer) : merged;
    // Booleans leave many slivers on flat faces; loosen the tolerance only as far as needed.
    let simplification = Math.max(weldTolerance, 1e-3), simple = owned(filled.simplify(simplification));
    while (simple.numTri() > MAX_OUTPUT_TRIANGLES && simplification < step / 4) { simplification = Math.min(step / 4, simplification * 2.5); simple = owned(simple.simplify(simplification)); }
    const solid = fillVoids(module, simple) ?? simple.translate([0, 0, 0]); // Simplifying can invert specks.
    return { solid, step, seal, sealGap, depth, simplification, cells, skinFaces, extrusions, grid: dims, enclosedFraction: enclosed / n };
  } finally { keep.forEach(m => m.delete()); }
}
