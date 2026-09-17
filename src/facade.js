// Fill horizontal interior sections while retaining the original facade geometry.
export function exteriorOnly(module, source, config, keep) {
  const depth = config.facadeDepth ?? .6, opening = config.facadeOpening ?? 4, step = config.facadeStep ?? .5;
  if (!Number.isFinite(depth) || depth < .1 || depth > 5 || !Number.isFinite(opening) || opening < 0 || opening > 20 || !Number.isFinite(step) || step < .2 || step > 2) throw new Error('外立面深度需 0.1–5 mm、封口寬度需 0–20 mm、分層精度需 0.2–2 mm。');
  const upright = keep(source.rotate([90, 0, 0]));
  const box = upright.boundingBox(), bottom = box.min[2], height = box.max[2] - bottom;
  const layers = Math.ceil(height / step);
  if (layers > 800 || source.numTri() > 20000) throw new Error('外立面模式上限為 800 層與 20,000 面；請增加分層厚度、縮小或簡化模型。');
  const fills = [];
  const outerRings = section => section.toPolygons().filter(ring => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) > 0);
  let previous = null, signature = null, start = bottom, end = bottom;
  function flush() {
    if (!previous) return;
    if (!previous.isEmpty()) {
      const extrusion = keep(previous.extrude(end - start));
      fills.push(keep(extrusion.translate([0, 0, start])));
    }
    previous.delete(); previous = null;
  }
  try {
    for (let layer = 0; layer < layers; layer++) {
      const low = bottom + layer * step, high = Math.min(bottom + height, low + step);
      const local = [];
      const hold = x => { local.push(x); return x; };
      try {
        const section = hold(upright.slice((low + high) / 2));
        const originalOuter = hold(new module.CrossSection(outerRings(section)));
        let fill = originalOuter;
        if (opening > 0 && !section.isEmpty()) {
          const expand = hold(section.offset(opening / 2, 'Miter'));
          const close = hold(expand.offset(-opening / 2, 'Miter'));
          const envelope = hold(new module.CrossSection(outerRings(close)));
          const inset = hold(envelope.offset(-depth, 'Miter'));
          fill = hold(module.CrossSection.union([originalOuter, inset]));
        }
        const polygons = fill.toPolygons();
        const key = JSON.stringify(polygons);
        if (key !== signature) {
          flush(); previous = new module.CrossSection(polygons); signature = key; start = low;
        }
        end = high;
      } finally { local.reverse().forEach(x => x.delete()); }
    }
    flush();
    if (!fills.length) return { solid: source, note: '外立面模式未找到可填實的內部區域。' };
    const fillerZ = keep(module.Manifold.union(fills));
    const filler = keep(fillerZ.rotate([-90, 0, 0]));
    const solid = keep(module.Manifold.union([source, filler]));
    const added = Math.max(0, solid.volume() - source.volume());
    return { solid, note: `外立面模式：填實內部 ${ (added / 1000).toFixed(2) } cm³；外層保留深度 ${depth} mm，封口寬度 ${opening} mm，分層 ${step} mm。可能封閉天井、門窗並造成局部階梯；開口大於門檻的房間可能仍保留。實體內部可由切片軟體設定低密度填充。` };
  } finally { if (previous) previous.delete(); }
}
