import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

export const MAX_TRIANGLES = 500000;
export function positions(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const result = new Float32Array(g.attributes.position.array);
  if (g !== geometry) g.dispose();
  return result;
}
export function validateParts(parts) {
  const count = parts.reduce((n, p) => n + p.length / 9, 0);
  if (!count || count > MAX_TRIANGLES) throw new Error('請使用 1–500,000 個三角面的模型。');
  for (const p of parts) if (p.length % 9 || !p.every(Number.isFinite)) throw new Error('模型含有無效座標或不完整三角面。');
  const box = bounds(parts);
  if (box.getSize(new THREE.Vector3()).length() < 1e-8) throw new Error('模型尺寸為零。');
  return parts;
}
export function parseModel(data, extension) {
  if (extension === 'stl') return validateParts([positions(new STLLoader().parse(data))]);
  if (extension !== 'obj') throw new Error('目前支援 STL 與 OBJ，請先從建築軟體匯出這些格式。');
  const object = new OBJLoader().parse(new TextDecoder().decode(data));
  object.updateMatrixWorld(true);
  const parts = [];
  object.traverse(child => {
    if (child.isMesh) {
      const geometry = child.geometry.clone().applyMatrix4(child.matrixWorld);
      parts.push(positions(geometry)); geometry.dispose(); child.geometry.dispose();
    }
  });
  return validateParts(parts);
}
export function bounds(parts) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of parts) for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.fromArray(p, i));
  return box;
}
export function transform(parts, config) {
  const { unit, ratio, rotation } = config;
  if (![1, 10, 1000].includes(unit) || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1000000 || !Array.isArray(rotation) || rotation.length !== 3 || !rotation.every(Number.isFinite)) throw new Error('請輸入有效單位、比例及旋轉角度。');
  const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation.map(x => x * Math.PI / 180)));
  matrix.scale(new THREE.Vector3().setScalar(unit / ratio));
  const v = new THREE.Vector3();
  const out = parts.map(p => {
    const a = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) v.fromArray(p, i).applyMatrix4(matrix).toArray(a, i);
    return a;
  });
  const box = bounds(out), center = box.getCenter(new THREE.Vector3());
  for (const p of out) for (let i = 0; i < p.length; i += 3) { p[i] -= center.x; p[i + 1] -= box.min.y; p[i + 2] -= center.z; }
  return out;
}
export function geometryFromPositions(array) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(array, 3));
  g.computeVertexNormals();
  return g;
}
export function binarySTL(array) {
  // STL exports use Z up; the interactive scene uses Y up.
  const geometry = geometryFromPositions(array).rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry);
  const result = new STLExporter().parse(mesh, { binary: true });
  geometry.dispose(); mesh.material.dispose();
  return result;
}
export function solidPositions(solid) {
  const mesh = solid.getMesh();
  const p = new Float32Array(mesh.triVerts.length * 3);
  for (let i = 0; i < mesh.triVerts.length; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = mesh.vertProperties[mesh.triVerts[i] * mesh.numProp + k];
  return p;
}
export function demoParts() {
  const pieces = [];
  function box(w, h, d, x, y, z) {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
    pieces.push(positions(g)); g.dispose();
  }
  box(18, .6, 14, 0, 0, 0);
  box(10.8, 13.8, 8.4, -2.6, .6, -1.4);
  box(6.8, 8.2, 10.6, 4.3, .6, 1);
  for (let floor = 0; floor < 5; floor++) box(11.5, .3, 9.1, -2.6, 1 + floor * 2.8, -1.4);
  for (let floor = 0; floor < 3; floor++) box(7.4, .3, 11.2, 4.3, 1 + floor * 2.8, 1);
  for (let i = 0; i < 7; i++) box(.26, 13.8, .6, -7.5 + i * 1.65, .6, 3);
  box(11.5, .45, 9.1, -2.6, 14.4, -1.4);
  box(7.4, .45, 11.2, 4.3, 8.8, 1);
  box(3.8, 1.1, 3.5, -3, 14.85, -2);
  return pieces;
}
