import { BufferGeometry, BufferAttribute, Vector3, Ray, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export function analyzePrintability(positions, { minWall = .8, overhangAngle = 45 } = {}) {
  if (!Number.isFinite(minWall) || minWall < .1 || minWall > 20 || !Number.isFinite(overhangAngle) || overhangAngle < 5 || overhangAngle > 85) throw new Error('壁厚需介於 0.1–20 mm，懸垂角度需介於 5–85°。');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const bvh = new MeshBVH(geometry, { indirect: true, maxDepth: 80 });
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3(), normal = new Vector3(), center = new Vector3();
  const ray = new Ray(), overhangFaces = [], thinFaces = [];
  let overhangArea = 0, samples = 0, measured = 0, thinCount = 0, minThickness = Infinity;
  const count = positions.length / 9;
  // ponytail: bounded centroid sampling can miss local thin features; use adaptive surface sampling for certification.
  const stride = Math.max(1, Math.ceil(count / 3000));
  const epsilon = Math.min(.001, minWall / 1000);
  for (let face = 0; face < count; face++) {
    const i = face * 9;
    a.fromArray(positions, i); b.fromArray(positions, i + 3); c.fromArray(positions, i + 6);
    ab.subVectors(b, a); ac.subVectors(c, a); normal.crossVectors(ab, ac);
    const area = normal.length() / 2;
    if (area < 1e-12) continue;
    normal.normalize(); center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    // Angle is measured from the horizontal plane; bed-contact faces need no support.
    if (normal.y < -Math.cos(overhangAngle * Math.PI / 180) - 1e-6 && center.y > .05) {
      overhangArea += area; overhangFaces.push(face);
    }
    if (face % stride) continue;
    samples++;
    ray.direction.copy(normal).negate(); ray.origin.copy(center).addScaledVector(ray.direction, epsilon);
    const hit = bvh.raycastFirst(ray, DoubleSide, 0, Infinity);
    if (!hit) continue;
    const thickness = hit.distance + epsilon;
    measured++; minThickness = Math.min(minThickness, thickness);
    if (thickness < minWall - 1e-4) { thinCount++; thinFaces.push(face); }
  }
  geometry.dispose();
  return { overhangArea, overhangFaces, thinFaces, thinCount, samples, measured, totalFaces: count, minThickness: Number.isFinite(minThickness) ? minThickness : null, minWall, overhangAngle };
}
