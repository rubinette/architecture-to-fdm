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

// Approximate rescue for branched/open surfaces: thicken the surface distance field.
// ponytail: at most 160 samples across the longest axis; finer detail needs adaptive meshing.
export function reconstructMesh(module, parts, { minWall = .8 } = {}) {
  if (!Number.isFinite(minWall) || minWall < .1 || minWall > 20) throw failure('壁厚需介於 0.1–20 mm。');
  const p = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { p.set(part, offset); offset += part.length; }
  const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(p, 3));
  try {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox.clone(), size = box.getSize(new Vector3());
    const step = Math.max(minWall / 2, Math.max(size.x, size.y, size.z) / 160);
    const radius = step;
    box.expandByScalar(radius + step * 2);
    const bvh = new MeshBVH(geometry), point = new Vector3(), target = {};
    const solid = module.Manifold.levelSet(x => {
      point.fromArray(x);
      const hit = bvh.closestPointToPoint(point, target, 0, radius + step);
      return radius - (hit ? hit.distance : radius + step);
    }, { min: box.min.toArray(), max: box.max.toArray() }, step);
    try { return { solid: solid.simplify(step / 10), step, radius, simplification: step / 10 }; }
    finally { solid.delete(); }
  } finally { geometry.dispose(); }
}
