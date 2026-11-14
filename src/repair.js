import { BufferGeometry, BufferAttribute, Vector3, Ray, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { solidPositions } from './model.js';
import { analyzePrintability } from './analysis.js';

export function repairSolid(module, source, config, keep) {
  let solid = source;
  const before = analyzePrintability(solidPositions(solid), config);
  const changes = { beforeThin: before.thinCount, beforeOverhangArea: before.overhangArea, expansion: 0, rotation: [0, 0, 0], notes: [] };
  if (before.thinCount) {
    if (source.numTri() > 20000) throw new Error('自動加厚目前支援最多 20,000 面。請先簡化模型，原模型已保留。');
    let check = before;
    // ponytail: global solid dilation preserves topology less than local remeshing; openings may shrink.
    for (let pass = 0; pass < 2 && check.thinCount; pass++) {
      const offset = Math.max(.05, (config.minWall - check.minThickness) / 2 + .025);
      const kernel = keep(module.Manifold.cube([2 * offset, 2 * offset, 2 * offset], true));
      solid = keep(solid.minkowskiSum(kernel));
      changes.expansion += offset;
      check = analyzePrintability(solidPositions(solid), config);
    }
    changes.notes.push(`整體向外加厚 ${changes.expansion.toFixed(3)} mm；窗洞、間隙可能縮小，外尺寸會增加。`);
  }
  const ground = m => {
    const b = m.boundingBox();
    return keep(m.translate([-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2]));
  };
  solid = ground(solid);
  if (config.autoOrient) {
    const rotations = [[0, 0, 0], [90, 0, 0], [180, 0, 0], [270, 0, 0], [0, 0, 90], [0, 0, 270]];
    let best = solid, bestScore = Infinity;
    for (const rotation of rotations) {
      const candidate = ground(keep(solid.rotate(rotation)));
      const b = candidate.boundingBox(), size = b.max.map((n, i) => n - b.min[i]);
      const margin = config.base ? 10 : 0;
      if (config.bed && (size[0] + margin > config.bed[0] || size[2] + margin > config.bed[1] || size[1] + config.base > config.bed[2])) continue;
      const p = solidPositions(candidate);
      let area = 0;
      const a = new Vector3(), ab = new Vector3(), ac = new Vector3(), n = new Vector3();
      for (let i = 0; i < p.length; i += 9) {
        a.fromArray(p, i); ab.fromArray(p, i + 3).sub(a); ac.fromArray(p, i + 6).sub(a); n.crossVectors(ab, ac);
        const length = n.length();
        if (length && n.y / length < -Math.cos(config.overhangAngle * Math.PI / 180) - 1e-6 && (p[i + 1] + p[i + 4] + p[i + 7]) / 3 > .05) area += length / 2;
      }
      if (area < bestScore - .0001) { best = candidate; bestScore = area; changes.rotation = rotation; }
    }
    solid = best;
  }
  changes.notes.push(`額外旋轉 X ${changes.rotation[0]}° / Y ${changes.rotation[1]}° / Z ${changes.rotation[2]}°（比較六個軸向）。`);
  return { solid, changes };
}

export function buildSupports(module, solid, analysis, config, keep) {
  const spacing = config.supportSpacing ?? 3, gap = config.supportGap ?? .2, diameter = config.supportDiameter ?? 1.6;
  const minGap = config.multiMaterial === true ? 0 : .05;
  if (!Number.isFinite(spacing) || spacing < 1 || spacing > 8 || !Number.isFinite(gap) || gap < minGap || gap > .5 || !Number.isFinite(diameter) || diameter < .8 || diameter > 4) throw new Error(`支撐間距需 1–8 mm，接觸間隙需 ${minGap}–0.5 mm，柱徑需 0.8–4 mm。`);
  const p = solidPositions(solid), geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(p, 3));
  const bvh = new MeshBVH(geometry, { indirect: true, maxDepth: 80 });
  const b = solid.boundingBox(), probes = new Map(), pillars = [];
  const ray = new Ray(new Vector3(), new Vector3(0, -1, 0));
  let truncated = false;
  function add(x, z) { probes.set(`${x.toFixed(3)},${z.toFixed(3)}`, [x, z]); }
  // Probe every downward face center first so small floating features do not fall between grid cells.
  for (const face of analysis.overhangFaces) {
    const i = face * 9;
    add((p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3);
  }
  const nx = Math.ceil((b.max[0] - b.min[0]) / spacing), nz = Math.ceil((b.max[2] - b.min[2]) / spacing);
  if (nx * nz > 20000 || probes.size > 20000) { geometry.dispose(); throw new Error('支撐取樣超過 20,000 點，請增大支撐間距或縮小模型。'); }
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) add(b.min[0] + (ix + .5) * spacing, b.min[2] + (iz + .5) * spacing);
  const used = new Set();
  for (const [x, z] of probes.values()) {
    ray.origin.set(x, b.max[1] + 1, z);
    const hits = bvh.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.face.normal.y >= -Math.cos(config.overhangAngle * Math.PI / 180) - 1e-6 || hit.point.y <= .05) continue;
      const lower = hits.slice(i + 1).find(h => h.point.y < hit.point.y - .01 && h.face.normal.y > .01);
      const bottom = lower ? lower.point.y + gap : 0, top = hit.point.y - gap;
      if (top - bottom < .3) continue;
      const key = `${Math.round(x / (diameter * .65))},${Math.round(z / (diameter * .65))},${Math.round(top / .1)}`;
      if (used.has(key)) continue;
      used.add(key);
      // ponytail: vertical breakaway posts, not tree supports; dense or enclosed cavities need slicer review.
      if (pillars.length >= 1200) { truncated = true; break; }
      const height = top - bottom, tip = Math.min(.8, height / 2);
      const trunk = keep(module.Manifold.cylinder(height - tip, Math.max(diameter / 2, height / 60), diameter / 2, 8));
      const tipShape = keep(module.Manifold.cylinder(tip, diameter / 2, Math.max(.2, diameter / 4), 8));
      const placedTip = keep(tipShape.translate([0, 0, height - tip]));
      const joined = keep(module.Manifold.union([trunk, placedTip]));
      const rotated = keep(joined.rotate([-90, 0, 0]));
      pillars.push(keep(rotated.translate([x, bottom, z])));
    }
    if (truncated) break;
  }
  geometry.dispose();
  if (!pillars.length) return { positions: new Float32Array(), count: 0, truncated, gap, spacing, diameter };
  const supports = keep(module.Manifold.union(pillars));
  // Subtract the complete model so support radii never fill adjacent walls or details.
  const trimmed = keep(module.Manifold.difference(supports, solid));
  return { positions: solidPositions(trimmed), count: pillars.length, truncated, gap, spacing, diameter };
}
