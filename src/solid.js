import { transform, validateParts, solidPositions } from './model.js';
import { analyzePrintability } from './analysis.js';
import { repairSolid, buildSupports } from './repair.js';
import { exteriorOnly } from './facade.js';
import { repairMesh, reconstructMesh } from './mesh-repair.js';

export function processModel(module, input, config) {
  validateParts(input);
  if (!Number.isFinite(config.base) || config.base < 0 || config.base > 20) throw new Error('底座厚度需介於 0–20 mm。');
  const parts = transform(input, config);
  const owned = [];
  const keep = m => { owned.push(m); return m; };
  let solid;
  try {
    const solids = [], failed = [];
    let meshRepair = null;
    for (const p of parts) {
      const mesh = new module.Mesh({ numProp: 3, vertProperties: p, triVerts: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) });
      mesh.merge();
      let m;
      try { m = keep(new module.Manifold(mesh)); }
      catch (error) { if (error.code !== 'NotManifold') throw error; failed.push(p); continue; }
      if (m.volume() < 0) {
        const flipped = p.slice();
        for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { flipped[i + 3 + k] = p[i + 6 + k]; flipped[i + 6 + k] = p[i + 3 + k]; }
        const fixed = new module.Mesh({ numProp: 3, vertProperties: flipped, triVerts: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) });
        fixed.merge(); m = keep(new module.Manifold(fixed));
      }
      solids.push(m);
    }
    if (failed.length) {
      if (config.meshRepair === false) throw new Error('模型存在開口、非流形邊或不一致面向。請啟用「自動修復匯入網格」後重試。');
      // Repair failed OBJ fragments together, so material/group boundaries can be stitched.
      try {
        const repaired = repairMesh(failed, config);
        solids.push(keep(new module.Manifold(new module.Mesh({ numProp: 3, vertProperties: repaired.vertProperties, triVerts: repaired.triVerts }))));
        meshRepair = { ...repaired.stats, repairedParts: failed.length };
      } catch (error) {
        if (error instanceof RangeError) throw error;
        if (error.code !== 'NotManifold' && !error.message.startsWith('網格自動修復未完成：')) throw error;
        if (!config.reconstruct) throw new Error(`${error.message} 可啟用「近似重建破碎表面」重試；細節與尺寸會改變。`);
        const rebuilt = reconstructMesh(module, failed, config);
        solids.push(keep(rebuilt.solid));
        meshRepair = { reconstructed: true, repairedParts: failed.length, step: rebuilt.step, radius: rebuilt.radius, simplification: rebuilt.simplification, reason: error.message };
      }
    }
    solid = keep(module.Manifold.union(solids));
    if (meshRepair?.reconstructed) solid = keep(solid.translate([0, -solid.boundingBox().min[1], 0]));
    const original = meshRepair ? Float32Array.from(parts.flatMap(p => Array.from(p))) : config.repair || config.facade ? solidPositions(solid) : null;
    let changes = null;
    let facadeNote = null;
    if (config.facade) ({ solid, note: facadeNote } = exteriorOnly(module, solid, config, keep));
    if (config.repair) ({ solid, changes } = repairSolid(module, solid, config, keep));
    if (facadeNote) {
      changes ??= { notes: [] };
      changes.notes.unshift(facadeNote);
    }
    if (config.base > 0) {
      const box = solid.boundingBox(), width = box.max[0] - box.min[0], depth = box.max[2] - box.min[2];
      const plate = keep(module.Manifold.cube([width + 10, config.base, depth + 10]));
      const placed = keep(plate.translate([box.min[0] - 5, 0, box.min[2] - 5]));
      const raised = keep(solid.translate([0, config.base - Math.min(.05, config.base / 2), 0]));
      solid = keep(module.Manifold.union([raised, placed]));
    }
    if (solid.isEmpty() || solid.volume() <= 0) throw new Error('模型沒有可列印的實體體積。');
    const positions = solidPositions(solid);
    const components = solid.decompose();
    const shells = components.length;
    const floating = components.filter(m => m.boundingBox().min[1] > .05).length;
    components.forEach(m => m.delete());
    const analysis = analyzePrintability(positions, config);
    const supports = config.repair ? buildSupports(module, solid, analysis, config, keep) : null;
    if (changes && supports) {
      changes.afterThin = analysis.thinCount;
      changes.afterOverhangArea = analysis.overhangArea;
      changes.notes.push(`已生成 ${supports.count} 根支撐，接觸間隙 ${supports.gap} mm。${supports.truncated ? '已達 1,200 根上限，尚未完整覆蓋。' : '請檢查支撐密度、側向接觸與拆除空間。'}`);
    }
    return { positions, original, meshRepair, changes, supports, volume: solid.volume(), shells, floating, triangles: positions.length / 9, analysis };
  } catch (error) {
    if (error.code === 'NotManifold') throw new Error('後續幾何運算產生非流形連接。請調整外立面或自動加厚設定後重試；原模型已保留。');
    throw error;
  } finally { owned.reverse().forEach(m => m.delete()); }
}
