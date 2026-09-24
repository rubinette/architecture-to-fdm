import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

const xml = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

function meshXML(positions) {
  if (!(positions instanceof Float32Array) || !positions.length || positions.length % 9 || !positions.every(Number.isFinite)) throw new Error('3MF 需要有效的模型與支撐三角網格。');
  const vertices = [], triangles = [], indices = new Map();
  for (let i = 0; i < positions.length; i += 9) {
    const face = [];
    for (let j = i; j < i + 9; j += 3) {
      // Same Y-up -> Z-up rotation as STL; never center the two parts separately.
      const [x, y, z] = [positions[j], -positions[j + 2], positions[j + 1]];
      const key = `${x},${y},${z}`;
      if (!indices.has(key)) {
        indices.set(key, vertices.length);
        vertices.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
      }
      face.push(indices.get(key));
    }
    triangles.push(`<triangle v1="${face[0]}" v2="${face[1]}" v3="${face[2]}"/>`);
  }
  return `<mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>`;
}

export function multiMaterial3MF(model, supports, { name, modelMaterial, supportMaterial }) {
  if ([modelMaterial, supportMaterial].some(value => typeof value !== 'string' || !value.trim() || value.length > 80)) throw new Error('請填寫模型與支撐材質名稱（1–80 字）。');
  const modelLabel = xml(modelMaterial.trim()), supportLabel = xml(supportMaterial.trim());
  // Core 3MF carries material identities, not printer-specific extruder/AMS slot assignments.
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${xml(name)}</metadata><metadata name="Application">FORMWORK</metadata>
<metadata name="Description">模型與支撐為同一組件的獨立部件；請在切片軟體指定各部件的實際耗材槽，保留相對位置。</metadata>
<resources>
<basematerials id="1"><base name="${modelLabel}" displaycolor="#C6C9A0"/><base name="${supportLabel}" displaycolor="#63A7AB"/></basematerials>
<object id="2" type="model" name="Model - ${modelLabel}" pid="1" pindex="0">${meshXML(model)}</object>
<object id="3" type="model" name="Supports - ${supportLabel}" pid="1" pindex="1">${meshXML(supports)}</object>
<object id="4" type="model" name="${xml(name)}"><components><component objectid="2"/><component objectid="3"/></components></object>
</resources><build><item objectid="4"/></build></model>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(document),
  }, { level: 6 });
}
