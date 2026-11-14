import './style.css';
import { multiMaterial3MF } from './three-mf.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createIcons, Box, Layers3, Upload, Download, RotateCcw, RotateCw, Maximize, Move3d, Grid2x2, Check, ChevronRight, CircleHelp, ArrowUpRight, X, TriangleAlert, Ruler, Building2, Scan, MousePointer2, Plus } from 'lucide';
import { demoParts, parseModel, transform, bounds, geometryFromPositions, binarySTL } from './model.js';

const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
document.querySelector('#app').innerHTML = `
  <aside class="rail"><a href="/" class="brand-mark" aria-label="FORMWORK 首頁">${icon('box')}</a><div class="rail-tools"><button class="rail-active" id="model-tool" title="模型工作區" aria-label="模型工作區">${icon('layers-3')}</button><button id="import-tool" title="匯入模型" aria-label="匯入模型">${icon('upload')}</button></div><button class="help-open" title="使用說明" aria-label="使用說明">${icon('circle-help')}</button><span class="rail-version">01</span></aside>
  <div class="workspace"><header><div class="wordmark">FORMWORK<span>建築模型列印工作室</span></div><div class="privacy"><span></span>本機處理 · 模型不上傳</div><button class="text-button help-open">使用指南 ${icon('arrow-up-right')}</button></header>
  <div class="projectbar"><div><div class="eyebrow">ARCHITECTURE TO OBJECT</div><h1>讓建築，成為手中的模型<span class="beta">BETA</span></h1></div><button class="secondary" id="import-top">${icon('upload')} 匯入模型</button></div>
  <div class="steps"><span class="step current"><b>01</b> 匯入模型</span><span class="step-line"></span><span class="step"><b>02</b> 調整與檢查</span><span class="step-line"></span><span class="step"><b>03</b> 匯出列印檔</span><span class="step-note">從數位設計，到實體建築。</span></div>
  <main><section class="canvas-panel" aria-label="3D 模型預覽"><div class="canvas-top"><div><span class="file-badge">${icon('building-2')}</span><div><strong id="filename">庭院集合住宅</strong><span id="filemeta">示範模型 · 可旋轉檢視</span></div></div><span class="sample-tag" id="sample-tag">範例專案</span></div><div id="viewport" tabindex="0" aria-label="3D 預覽，拖曳旋轉，滾輪縮放"><div class="view-label"><span></span> 透視視圖 <span class="view-sub">/ SOLID</span></div><div class="analysis-tabs" aria-label="檢查顯示"><button data-view="solid" class="selected">實體</button><button data-view="overhang">懸垂</button><button data-view="thin">薄牆</button><button data-view="before" id="before-view" disabled>修正前</button></div><div id="analysis-legend" hidden></div><div class="canvas-toolbar"><button id="view-home" title="重設視角" aria-label="重設視角">${icon('maximize')}</button><button id="view-top" title="俯視圖" aria-label="俯視圖">${icon('scan')}</button><span></span><button id="wireframe" title="切換線框" aria-label="切換線框" aria-pressed="false">${icon('box')}</button><button id="grid-toggle" title="切換網格" aria-label="切換網格" aria-pressed="true">${icon('grid-2x2')}</button></div><div class="axis"><span class="axis-y">Y</span><span class="axis-z">Z</span><span class="axis-x">X</span></div><div class="view-hint">${icon('mouse-pointer-2')} 拖曳旋轉 <span>·</span> 滾輪縮放 <span>·</span> 右鍵平移</div><div id="drop-overlay">${icon('upload')} 放開以匯入 STL 或 OBJ</div></div><div class="model-metrics"><div><span>列印尺寸 <small>W × D × H</small></span><strong id="dimensions">— <small>mm</small></strong></div><div><span>三角面</span><strong id="triangles">—</strong></div><div><span>實體體積</span><strong id="volume">— <small>cm³</small></strong></div><div class="metric-status"><span class="status-dot"></span><span id="preview-status">處理模型中</span></div></div></section>
  <aside class="settings"><div class="settings-heading"><h2>列印準備</h2><span>FDM</span></div><div class="settings-scroll"><section class="setting-section"><h3><span>01</span> 模型比例 ${icon('ruler')}</h3><div class="field-row"><label for="unit">原始模型單位</label><select id="unit"><option value="1">毫米 mm</option><option value="10">公分 cm</option><option value="1000" selected>公尺 m</option></select></div><div class="scale-presets" aria-label="比例預設"><button data-ratio="50">1:50</button><button data-ratio="100" class="selected">1:100</button><button data-ratio="200">1:200</button><button data-ratio="500">1:500</button></div><div class="field-row"><label for="ratio">自訂比例</label><div class="ratio-input"><span>1 :</span><input id="ratio" type="number" min="0.001" max="1000000" step="any" value="100" aria-label="比例分母"></div></div><div class="source-size" id="source-size"></div></section>
  <section class="setting-section"><h3><span>02</span> 擺放與底座 ${icon('move-3d')}</h3><div class="rotation-controls"><span>旋轉 90°</span><button data-axis="0">X ${icon('rotate-cw')}</button><button data-axis="1">Y ${icon('rotate-cw')}</button><button data-axis="2">Z ${icon('rotate-cw')}</button><button id="reset-rotation" title="重設旋轉" aria-label="重設旋轉">${icon('rotate-ccw')}</button></div><div class="field-row base-row"><label for="base-toggle">加入列印底座<small>延伸邊界 5 mm，合併為實體</small></label><input id="base-toggle" type="checkbox" role="switch" checked></div><div class="field-row"><label for="base-thickness">底座厚度</label><div class="number-unit"><input type="number" id="base-thickness" min="0.4" max="20" step="0.2" value="2"><span>mm</span></div></div><p class="mini-note">${icon('check')} 自動置中，貼齊列印平台</p></section>
  <section class="setting-section"><h3><span>03</span> 列印平台 ${icon('layers-3')}</h3><label class="sr-only" for="printer">列印平台尺寸</label><select id="printer" class="full-select"><option value="220,220,250">標準平台 · 220 × 220 × 250 mm</option><option value="256,256,256">方形平台 · 256 × 256 × 256 mm</option><option value="180,180,180">小型平台 · 180 × 180 × 180 mm</option><option value="300,300,300">大型平台 · 300 × 300 × 300 mm</option></select><button class="fit-button" id="fit-bed">${icon('maximize')} 縮放至平台範圍</button></section>
  <section class="setting-section mesh-repair"><h3>匯入網格修復</h3><label class="option-row"><input id="mesh-repair" type="checkbox" checked>自動修復匯入網格</label><div class="field-row"><label for="weld-tolerance">接縫容差</label><div class="number-unit"><input id="weld-tolerance" type="number" min="0.000001" max="0.1" step="0.001" value="0.001"><span>mm</span></div></div><div class="field-row"><label for="max-hole-size">補洞上限</label><div class="number-unit"><input id="max-hole-size" type="number" min="0" max="500" step="1" value="50"><span>mm</span></div></div><p class="mini-note">上限為縮放後開口包圍盒的對角線，0 表示不補洞。僅補平面開口；補面可能封閉原本要保留的洞，請比較修正前後。</p><label class="option-row"><input id="reconstruct" type="checkbox">近似重建破碎表面</label><div class="field-row"><label for="seal-gap">封閉開口寬度</label><div class="number-unit"><input id="seal-gap" type="number" min="0" max="20" step="0.5" value="0"><span>mm</span></div></div><p class="mini-note">精確修復失敗時，以網格判斷內外並重建封閉實體，不受面向與非流形邊影響；封閉的內部會填實，比格距細的封閉零件保留原形。窄於封閉寬度的開口（如門窗）會封住，使室內填實；0 只封住約兩格距以下的裂縫。請先縮放至列印尺寸，再比較修正前後。</p><div id="mesh-repair-summary" class="mesh-repair-summary" role="status" hidden></div></section>
  <section class="setting-section print-risks"><h3><span>04</span> 懸空、薄牆與支撐 ${icon('triangle-alert')}</h3><div class="field-row"><label for="nozzle">噴嘴直徑</label><select id="nozzle"><option value="0.2">0.2 mm</option><option value="0.4" selected>0.4 mm</option><option value="0.6">0.6 mm</option><option value="0.8">0.8 mm</option></select></div><div class="field-row"><label for="min-wall">壁厚警戒值</label><div class="number-unit"><input type="number" id="min-wall" min="0.1" max="20" step="0.1" value="0.8"><span>mm</span></div></div><p class="mini-note">初始值為 2 倍噴嘴直徑，可依線寬調整。</p><div class="field-row"><label for="overhang-angle">懸垂門檻</label><div class="number-unit"><input type="number" id="overhang-angle" min="5" max="85" step="5" value="45"><span>°</span></div></div><p class="mini-note">朝下表面與水平夾角低於此值時標示。</p></section>
  <section class="setting-section facade-section"><h3>${icon('building-2')} 外立面模式</h3><label class="option-row"><input type="checkbox" id="facade">只保留外立面，填實內部空間</label><p class="mini-note">合併房間與封閉空腔，減少內部支撐；外牆凹凸保留，天井與穿透窗可能被封閉。</p><div id="facade-options" hidden><div class="field-row"><label for="facade-depth">外層保留深度</label><div class="number-unit"><input id="facade-depth" type="number" min="0.1" max="5" step="0.1" value="0.6"><span>mm</span></div></div><div class="field-row"><label for="facade-opening">封閉開口寬度</label><div class="number-unit"><input id="facade-opening" type="number" min="0" max="20" step="0.5" value="4"><span>mm</span></div></div><div class="field-row"><label for="facade-step">分層精度</label><select id="facade-step"><option value="0.2">0.2 mm · 精細</option><option value="0.5" selected>0.5 mm · 標準</option><option value="1">1 mm · 快速</option><option value="2">2 mm · 大模型</option></select></div><p class="mini-note">尺寸均為縮放後毫米。封口值越大，越可能封閉中庭；填實的內部仍可由切片軟體設定稀疏填充。</p></div></section>
  <section class="setting-section auto-repair"><h3><span>05</span> 自動修正 ${icon('plus')}</h3><label class="option-row"><input id="auto-orient" type="checkbox" checked>自動選擇較少懸垂的方向</label><div class="field-row"><label for="support-spacing">支撐間距</label><div class="number-unit"><input id="support-spacing" type="number" min="1" max="8" step="0.5" value="3"><span>mm</span></div></div><div class="field-row"><label for="support-diameter">支撐柱徑</label><div class="number-unit"><input id="support-diameter" type="number" min="0.8" max="4" step="0.2" value="1.6"><span>mm</span></div></div><div class="field-row"><label for="support-gap">接觸間隙</label><div class="number-unit"><input id="support-gap" type="number" min="0.05" max="0.5" step="0.05" value="0.2"><span>mm</span></div></div><p class="mini-note">間隙需配合層高校準；較高支撐柱自動加寬底部。</p><div class="material-settings"><label class="option-row"><input id="multi-material" type="checkbox">支撐使用另一種材質</label><div id="material-options" hidden><div class="field-row"><label for="model-material">模型材質</label><input id="model-material" class="material-name" type="text" value="PLA" maxlength="80" aria-describedby="material-note"></div><div class="field-row"><label for="support-material">支撐材質</label><input id="support-material" class="material-name" type="text" value="支撐專用耗材" maxlength="80" aria-describedby="material-note"></div><p class="mini-note" id="material-note">整組支撐使用第二材質。3MF 保留兩個部件與材質標籤；請在切片軟體選擇多材質印表機，再為 Model 與 Supports 指定實際耗材槽。</p><p class="mini-note">僅在已確認材料相容性時將接觸間隙設為 0；切換材質不會自動更改間隙、溫度或換料設定。</p></div></div><button id="auto-repair" class="repair-button">${icon('plus')} 自動加厚、擺放與生成支撐</button><button id="undo-repair" class="undo-button" hidden>${icon('rotate-ccw')} 還原原始模型</button><div id="repair-summary" role="status" hidden></div><p class="mini-note">整體向外加厚可能縮小窗洞；原檔保留不變。加厚上限 20,000 面，最多生成 1,200 根支撐。</p></section>
  <section class="checks"><div class="checks-heading"><h3>模型檢查</h3><span id="checks-count">檢查中</span></div><div id="check-results" aria-live="polite"></div><p class="check-note">薄牆以三角面中心射線取樣，最多 3,000 面，可能漏掉局部細節。懸垂僅依角度判斷，未模擬逐層支撐、橋接與拆除空間。</p></section></div><div class="export-panel"><label id="risk-ack-label" hidden><input type="checkbox" id="risk-ack">我已檢查補洞／重建造型、剩餘薄牆、支撐接觸與拆除空間，將確認切片預覽</label><label for="export-mode" class="sr-only">匯出內容</label><select id="export-mode" class="full-select"><option value="multi-3mf" disabled>雙材質 3MF · 模型 + 支撐</option><option value="combined" selected>單材質 STL · 模型 + 支撐</option><option value="model">僅模型</option><option value="supports">僅支撐（保留座標）</option></select><button id="export" disabled>${icon('download')} 匯出列印模型 <span id="export-format">STL</span></button><p id="export-note">先自動修正可將支撐一併匯出</p><button id="report" class="report-button" disabled>下載檢查報告 ${icon("download")}</button></div></aside></main>
  <footer><div>${icon('box')} 為每個建築構想，做出下一步。</div><button id="load-demo">載入示範模型 ${icon('chevron-right')}</button><span>STL / OBJ <span class="footer-sep">·</span> 單檔上限 25 MB</span></footer></div>
  <input type="file" id="file-input" accept=".stl,.obj" hidden><div id="toast" role="status" hidden></div>
  <dialog id="help"><button class="dialog-close" aria-label="關閉說明">${icon('x')}</button><div class="eyebrow">A SMALLER SCALE. A NEW PERSPECTIVE.</div><h2>從建築模型到列印檔案</h2><ol><li><strong>匯入 STL 或 OBJ</strong><p>請先從 SketchUp、Revit 或其他建模軟體匯出三角網格；不支援照片、平面圖、SKP 或 RVT 原始檔。</p></li><li><strong>確認單位與比例</strong><p>STL 沒有單位資訊，請指定原始單位。調整比例與方向，選擇平台，視需要加入底座。</p></li><li><strong>檢查並匯出</strong><p>封閉實體可合併、置中並匯出毫米制 STL。無法直接建立實體時，會先合併接縫、清理重複／退化面、校正面向，並在上限內補平面開口；OBJ 分組會一起嘗試縫合。可分辨的邊接觸實體會分離。真正分叉、自交、嵌套或非平面開口不會強行修補，會顯示具體原因並保留原模型。</p></li><li><strong>交給切片軟體</strong><p>橘色顯示朝下懸垂面，紅色顯示取樣低於壁厚警戒值的三角面。點選自動修正後，工具會整體向外加厚、比較六個軸向並生成支撐柱。加厚會增加外尺寸、縮小窗洞與間隙；可一鍵還原。支撐會避開模型內部，但側面可能接觸且封閉空間可能難以拆除。STL 可含生成的支撐幾何，仍須在切片軟體確認層高、接觸間隙、橋接與逐層預覽；不產生 G-code。</p><p>若支撐需使用另一種材質，開啟對應選項，填入模型與支撐材質後匯出雙材質 3MF。Model 與 Supports 保持相同座標、作為一個組件匯入；依切片軟體設定不同耗材槽。這些支撐是已生成的幾何部件，不會套用切片軟體的「支撐介面耗材」設定。STL 不保留材質資料，需分檔匯入再手動指定。此工具不自動驗證材料相容性或設定溫度與清料塔。</p></li></ol><p class="mini-note">模型只在此瀏覽器分頁處理，重新整理後不保留。</p><p><a href="https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135" target="_blank" rel="noopener noreferrer">參考：Prusa 建模與列印指南 ↗</a></p></dialog>`;
createIcons({ icons: { Box, Layers3, Upload, Download, RotateCcw, RotateCw, Maximize, Move3d, Grid2x2, Check, ChevronRight, CircleHelp, ArrowUpRight, X, TriangleAlert, Ruler, Building2, Scan, MousePointer2, Plus } });
const $ = id => document.getElementById(id);
let parts = demoParts(), modelName = '庭院集合住宅', rotation = [0, 0, 0], result = null, job = 0, timer, importing = false, viewMode = 'solid', checkError = null, repairMode = false, workerBusy = false;
let worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let workerFailed = false;
const config = () => ({ meshRepair: $('mesh-repair').checked, reconstruct: $('reconstruct').checked, sealGap: Number($('seal-gap').value), weldTolerance: Number($('weld-tolerance').value), maxHoleSize: Number($('max-hole-size').value), unit: Number($('unit').value), ratio: Number($('ratio').value), rotation: [...rotation], base: $('base-toggle').checked ? Number($('base-thickness').value) : 0, minWall: Number($('min-wall').value), overhangAngle: Number($('overhang-angle').value), repair: repairMode, autoOrient: $('auto-orient').checked, supportSpacing: Number($('support-spacing').value), supportDiameter: Number($('support-diameter').value), supportGap: Number($('support-gap').value), multiMaterial: $('multi-material').checked, bed: bedSize(), facade: $('facade').checked, facadeDepth: Number($('facade-depth').value), facadeOpening: Number($('facade-opening').value), facadeStep: Number($('facade-step').value) });
const bedSize = () => $('printer').value.split(',').map(Number);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#f0f2f4');
const camera = new THREE.PerspectiveCamera(36, 1, .1, 10000);
const viewport = $('viewport');
let renderer, controls;
const modelGroup = new THREE.Group(); scene.add(modelGroup);
const supportMaterial = new THREE.MeshStandardMaterial({ color: '#63a7ab', roughness: .8 });
const warningMaterial = new THREE.MeshBasicMaterial({ color: '#e6953e', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const material = new THREE.MeshStandardMaterial({ color: '#c6c9a0', roughness: .77, metalness: .04, side: THREE.DoubleSide });
scene.add(new THREE.HemisphereLight('#ffffff', '#68737d', 2.5));
const light = new THREE.DirectionalLight('#fff9e9', 3); light.position.set(-160, 280, 160); scene.add(light);
const fill = new THREE.DirectionalLight('#d9e6ff', .7); fill.position.set(120, 40, -180); scene.add(fill);
const grid = new THREE.GridHelper(220, 22, '#a4adb7', '#d3d9df'); grid.position.y = -.15; scene.add(grid);
const platform = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(220, .25, 220)), new THREE.LineBasicMaterial({ color: '#87938e' })); platform.position.y = -.2; scene.add(platform);
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.prepend(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2; controls.minDistance = 1; controls.maxDistance = 3000;
  new ResizeObserver(() => { const { width, height } = viewport.getBoundingClientRect(); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); }).observe(viewport);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
} catch { toast('無法啟動 3D 預覽，請使用支援 WebGL 的瀏覽器。仍可轉換及匯出模型。'); }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6000); }
function display(array) {
  for (const child of [...modelGroup.children]) { child.geometry.dispose(); if (child.isLineSegments) child.material.dispose(); modelGroup.remove(child); }
  const g = geometryFromPositions(array); const mesh = new THREE.Mesh(g, material); modelGroup.add(mesh);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: '#667255', transparent: true, opacity: .23 })); modelGroup.add(edges);
}
function updateView() {
  if (!result) return;
  if (viewMode === 'before' && result.original) { display(result.original); $('analysis-legend').hidden = false; $('analysis-legend').textContent = '處理前（不含網格修復、外立面填實、底座與支撐）；匯出使用修正後模型'; return; }
  display(result.positions);
  if (result.supports?.positions.length) modelGroup.add(new THREE.Mesh(geometryFromPositions(result.supports.positions), supportMaterial));
  const faces = viewMode === 'overhang' ? result.analysis.overhangFaces : viewMode === 'thin' ? result.analysis.thinFaces : [];
  if (faces.length) {
    const selected = new Float32Array(faces.length * 9);
    faces.forEach((f, i) => selected.set(result.positions.subarray(f * 9, f * 9 + 9), i * 9));
    warningMaterial.color.set(viewMode === 'thin' ? '#d35652' : '#e6953e');
    modelGroup.add(new THREE.Mesh(geometryFromPositions(selected), warningMaterial));
  }
  $('analysis-legend').hidden = viewMode === 'solid' && !result.supports?.positions.length;
  $('analysis-legend').textContent = viewMode === 'solid' ? '青色：已生成支撐柱 · 可與模型一起匯出' : viewMode === 'thin' ? `紅色：取樣厚度 < ${result.analysis.minWall} mm（非完整壁厚掃描）` : `橘色：向下表面與水平夾角 < ${result.analysis.overhangAngle}°`;
  $('analysis-legend').className = viewMode;
}
function frame(top = false) {
  if (!controls) return;
  const box = new THREE.Box3().setFromObject(modelGroup), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z, 60) * 2.05;
  controls.target.copy(center); camera.position.copy(center).add(top ? new THREE.Vector3(.001, d * 1.5, 0) : new THREE.Vector3(d, d * .83, d * 1.1)); controls.update();
}
function metrics(array) {
  const s = bounds([array]).getSize(new THREE.Vector3());
  $('dimensions').innerHTML = `${s.x.toFixed(1)} × ${s.z.toFixed(1)} × ${s.y.toFixed(1)} <small>mm</small>`;
  return [s.x, s.z, s.y];
}
function checkRow(state, label, detail) { return `<div class="check-row ${state}"><span class="check-icon">${state === 'good' ? '✓' : state === 'pending' ? '·' : '!'}</span><span>${label}<small>${detail}</small></span></div>`; }
function hasRisks() { return result && (result.meshRepair?.reconstructed || result.meshRepair?.filledHoles > 0 || result.analysis.thinCount > 0 || result.analysis.overhangFaces.length > 0 || result.floating > 0 || result.analysis.measured < result.analysis.samples); }
function showChecks(error = checkError) {
  checkError = error;
  const dimensions = result ? metrics(combinedPositions()) : null;
  const fits = dimensions && dimensions.every((d, i) => d <= bedSize()[i] + .001);
  const risks = hasRisks();
  $('risk-ack-label').hidden = !risks;
  $('report').disabled = !result;
  $('auto-repair').disabled = !result || importing;
  $('auto-repair').textContent = repairMode && !result && !error ? '正在加厚與生成支撐…' : '自動加厚、擺放與生成支撐';
  $('undo-repair').hidden = !repairMode && !$('facade').checked && !result?.meshRepair;
  $('before-view').disabled = !result?.original;
  $('facade-options').hidden = !$('facade').checked;
  $('repair-summary').hidden = !result?.changes;
  $('mesh-repair-summary').hidden = !result?.meshRepair;
  $('seal-gap').disabled = !$('mesh-repair').checked || !$('reconstruct').checked;
  $('reconstruct').disabled = $('weld-tolerance').disabled = $('max-hole-size').disabled = !$('mesh-repair').checked;
  if (result?.meshRepair) {
    const r = result.meshRepair;
    $('mesh-repair-summary').textContent = r.reconstructed ? `已重建並保留原始表面：${r.cells} 個封閉零件原樣保留，其餘 ${r.skinFaces} 個面向內加厚（最深 ${r.depth.toFixed(2)} mm，兩側皆露出的單片面加厚為壁厚警戒值）。判定內外的格距 ${r.step.toFixed(3)} mm，${(r.seal * 2).toFixed(2)} mm 以下的開口視為封閉，其後方空間填實；較寬開口後方仍為中空。簡化誤差上限 ${r.simplification.toFixed(3)} mm。請切換「修正前」比較，並檢查切片。原修復失敗原因：${r.reason}` : `已修復 ${r.repairedParts} 個網格分組：清除 ${r.removedFaces} 個重複／退化面、校正 ${r.flippedFaces} 個面向、補上 ${r.filledHoles} 個平面開口、分離 ${r.splitEdges} 條非流形共用邊。修復後已通過實體建構檢查；可切換「修正前」比較。`;
  }
  if (result?.changes) $('repair-summary').textContent = result.changes.notes.join(' ');
  const dual = $('multi-material').checked;
  $('material-options').hidden = !dual;
  $('support-gap').min = dual ? '0' : '0.05';
  $('export-mode').querySelector('[value="multi-3mf"]').disabled = !dual;
  $('export-mode').querySelector('[value="combined"]').disabled = dual;
  const is3mf = $('export-mode').value === 'multi-3mf';
  $('export-format').textContent = is3mf ? '3MF' : 'STL';
  const validMaterials = $('model-material').value.trim() && $('support-material').value.trim();
  $('export-note').textContent = is3mf ? !result?.supports?.positions.length ? '請先執行自動修正以生成支撐，才能匯出雙材質 3MF' : !validMaterials ? '請填寫模型與支撐的材質名稱' : '3MF 保留材質標籤；在切片軟體指定耗材槽，不要拆散後自動置中' : dual ? 'STL 不含材質資料；兩份檔案需作為同一物件的部件匯入並指定耗材' : result?.supports?.count ? '支撐已包含於 STL；請勿在切片時自動拆散或重新置中各實體' : '尚無支撐幾何；可先執行自動修正';
  $('export').disabled = !result || !fits || importing || ((is3mf || $('export-mode').value === 'supports') && !result.supports?.positions.length) || (is3mf && (!dual || !validMaterials)) || (dual && $('export-mode').value === 'combined') || (risks && !$('risk-ack').checked);
  $('check-results').innerHTML = checkRow(error ? 'bad' : result ? 'good' : 'pending', '封閉實體', error || (result ? result.meshRepair ? '網格已自動修復，並通過實體建構檢查' : '網格已驗證，交疊實體已合併' : '正在分析與修復網格…')) + checkRow(result ? fits ? 'good' : 'bad' : 'pending', '列印平台範圍', result ? fits ? '模型位於平台範圍內' : '超出平台，請縮小比例或更換平台' : '等待模型檢查') + checkRow(result ? result.shells === 1 ? 'good' : 'warn' : 'pending', '獨立實體', result ? result.shells === 1 ? '1 個連續實體' : `${result.shells} 個獨立實體，請在切片軟體檢查接觸與支撐` : '等待模型檢查');
  if (result) {
    const a = result.analysis;
    $('check-results').innerHTML += checkRow(result.floating ? 'bad' : 'good', '懸空實體', result.floating ? `${result.floating} 個實體未接觸平台；須加支撐、重新擺放或拆件` : '所有獨立實體均接觸平台；局部懸空另見懸垂檢查') + checkRow(a.overhangFaces.length ? 'warn' : 'good', '懸垂與支撐', a.overhangFaces.length ? `${a.overhangFaces.length} 面／${(a.overhangArea / 100).toFixed(1)} cm² 可能需支撐；切換懸垂檢視，調整方向或在切片軟體啟用支撐` : '未發現超過門檻的向下表面，仍需確認逐層預覽') + checkRow(a.thinCount || a.measured < a.samples ? 'warn' : 'good', '薄牆取樣', `${a.thinCount ? `${a.thinCount} 個取樣點低於 ${a.minWall} mm，需加厚或放大模型。` : '取樣點未發現低於警戒值的厚度，不代表全模型無薄牆。'} 最薄取樣 ${a.minThickness?.toFixed(2) ?? '—'} mm；成功量測 ${a.measured}/${a.samples} 點。`);
  }
  if (result?.supports) $('check-results').innerHTML += checkRow(result.supports.truncated ? 'bad' : result.supports.count ? 'warn' : 'good', '支撐生成', result.supports.truncated ? '已達數量上限，覆蓋不完整；請縮小模型或增大間距重試。' : `${result.supports.count} 根支撐已生成，接觸間隙 ${result.supports.gap} mm。幾何懸垂仍存在，須確認切片時支撐覆蓋及拆除空間。`);
  const ready = result && fits;
  $('checks-count').textContent = error ? '需要修復' : ready ? risks ? '需處理風險' : '已完成' : result ? '需要調整' : '檢查中';
  $('preview-status').textContent = error ? '需要修復' : ready ? risks ? '需處理風險' : '可匯出列印檔' : result ? '超出平台' : '處理模型中';
  document.querySelector('.status-dot').classList.toggle('warning', !ready || risks);
  $('triangles').textContent = result ? result.triangles.toLocaleString() : '—';
  $('volume').innerHTML = result ? `${(result.volume / 1000).toFixed(1)} <small>cm³</small>` : '—';
}
function rebuild() {
  if (workerBusy) {
    const receive = worker.onmessage, failed = worker.onerror;
    worker.terminate(); worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); worker.onmessage = receive; worker.onerror = failed; workerBusy = false;
  }
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b.dataset.view === viewMode); b.setAttribute('aria-pressed', String(b.dataset.view === viewMode)); });
  clearTimeout(timer); job++; result = null; checkError = null; $('risk-ack').checked = false; $('analysis-legend').hidden = true; showChecks();
  $('base-thickness').disabled = !$('base-toggle').checked;
  document.querySelectorAll('[data-ratio]').forEach(b => b.classList.toggle('selected', Number(b.dataset.ratio) === Number($('ratio').value)));
  try {
    const c = config(); const raw = transform(parts, c);
    const joined = new Float32Array(raw.reduce((n, p) => n + p.length, 0)); let offset = 0;
    for (const p of raw) { joined.set(p, offset); offset += p.length; }
    display(joined); metrics(joined);
    const source = bounds(parts).getSize(new THREE.Vector3());
    $('source-size').textContent = `原始尺寸 ${source.x.toFixed(2)} × ${source.z.toFixed(2)} × ${source.y.toFixed(2)} ${$('unit').selectedOptions[0].text.split(' ')[1]}`;
    if (workerFailed) throw new Error('模型處理引擎無法啟動，請重新整理後再試。');
    timer = setTimeout(() => { workerBusy = true; worker.postMessage({ id: job, parts, config: c }); }, 180);
  } catch (e) { showChecks(e.message); }
}
worker.onmessage = ({ data }) => {
  if (data.id !== job) return;
  workerBusy = false;
  if (data.error) { result = null; showChecks(data.error); return; }
  result = data; checkError = null; updateView(); showChecks(); if (repairMode) frame();
};
worker.onerror = () => { workerFailed = true; result = null; showChecks('模型處理引擎無法啟動，請重新整理後再試。'); };
for (const id of ['unit', 'ratio', 'base-toggle', 'base-thickness', 'min-wall', 'overhang-angle', 'support-spacing', 'support-diameter', 'support-gap', 'auto-orient', 'facade', 'facade-depth', 'facade-opening', 'facade-step', 'mesh-repair', 'reconstruct', 'seal-gap', 'weld-tolerance', 'max-hole-size']) $(id).addEventListener('input', rebuild);
document.querySelectorAll('[data-ratio]').forEach(b => b.onclick = () => { $('ratio').value = b.dataset.ratio; rebuild(); });
document.querySelectorAll('[data-axis]').forEach(b => b.onclick = () => { rotation[Number(b.dataset.axis)] = (rotation[Number(b.dataset.axis)] + 90) % 360; rebuild(); });
$('nozzle').onchange = () => { $('min-wall').value = (Number($('nozzle').value) * 2).toFixed(1); rebuild(); };
$('auto-repair').onclick = () => { repairMode = true; viewMode = 'solid'; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('selected', b.dataset.view === 'solid')); rebuild(); };
$('undo-repair').onclick = () => { if (result?.meshRepair) $('mesh-repair').checked = false; repairMode = false; $('facade').checked = false; viewMode = 'solid'; rebuild(); frame(); };
$('multi-material').onchange = () => {
  const dual = $('multi-material').checked;
  $('export-mode').value = dual ? 'multi-3mf' : 'combined';
  if (!dual && Number($('support-gap').value) < .05) { $('support-gap').value = '.2'; toast('已回到單材質支撐，接觸間隙恢復 0.2 mm。'); }
  rebuild();
};
for (const id of ['model-material', 'support-material']) $(id).addEventListener('input', () => showChecks());
$('export-mode').onchange = () => showChecks();
$('risk-ack').onchange = () => showChecks();
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { viewMode = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); updateView(); });
$('report').onclick = () => {
  if (!result) return;
  const a = result.analysis;
  const report = { model: modelName, generatedAt: new Date().toISOString(), units: 'mm', outputUpAxis: 'Z', scale: config().ratio, sourceUnitMm: config().unit, rotationDegreesXYZ: rotation, baseThicknessMm: config().base, nozzleMm: Number($('nozzle').value), minWallMm: a.minWall, overhangAngleFromHorizontal: a.overhangAngle, bedMm: bedSize(), dimensionsWidthDepthHeightMm: metrics(combinedPositions()), disconnectedShells: result.shells, floatingShells: result.floating, overhangFaces: a.overhangFaces.length, overhangAreaMm2: a.overhangArea, thinSamples: a.thinCount, sampledFaces: a.samples, measuredSamples: a.measured, totalFaces: a.totalFaces, minimumSampledThicknessMm: a.minThickness, autoRepair: result.changes, meshRepair: result.meshRepair, meshRepairSettings: { enabled: config().meshRepair, reconstruct: config().reconstruct, sealGapMm: config().sealGap, weldToleranceMm: config().weldTolerance, maxHoleSizeMm: config().maxHoleSize }, materials: { separateSupportMaterial: $('multi-material').checked, model: $('model-material').value.trim(), supports: $('support-material').value.trim(), slicerSlotAssignment: 'Assign Model and Supports to physical filament slots in the slicer; 3MF material labels are not hardware slot settings.' }, facade: { enabled: config().facade, retainedDepthMm: config().facadeDepth, closeOpeningMm: config().facadeOpening, layerStepMm: config().facadeStep }, supports: result.supports ? { count: result.supports.count, gap: result.supports.gap, spacing: result.supports.spacing, diameter: result.supports.diameter, truncated: result.supports.truncated } : null, limitations: ['薄牆為面中心取樣，可能漏掉局部細节。', '懸垂僅角度分析，未模擬逐層島嶼、橋接與支撐可拆除性。', '支撐可作為 STL 幾何一起匯出，但不包含切片參數；請確認接觸間隙、側向接觸與拆除空間。', '自動加厚為整體外擴，窗洞可能縮小；仍須複查未取樣區域。'] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'fdm-check-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
};
$('reset-rotation').onclick = () => { rotation = [0, 0, 0]; rebuild(); };
$('printer').onchange = () => { const [w, d] = bedSize(); platform.scale.set(w / 220, 1, d / 220); grid.scale.set(w / 220, 1, d / 220); if (repairMode) rebuild(); else showChecks(); };
$('fit-bed').onclick = () => {
  try {
    const c = config(); const s = bounds(transform(parts, { ...c, ratio: 1 })).getSize(new THREE.Vector3()); const bed = bedSize(); const margin = c.base > 0 ? 10 : 0;
    $('ratio').value = (Math.ceil(Math.max(s.x / (bed[0] - margin - 4), s.z / (bed[1] - margin - 4), s.y / (bed[2] - c.base - 4)) * 1000) / 1000).toString(); rebuild(); frame(); toast('已等比例調整，平台邊緣保留 2 mm。');
  } catch (e) { toast(e.message); }
};
async function importFile(file) {
  if (!file || importing) return;
  if (file.size > 25 * 1024 * 1024) { toast('檔案超過 25 MB，請先簡化模型。'); return; }
  importing = true; $('export').disabled = true;
  try {
    const next = parseModel(await file.arrayBuffer(), file.name.split('.').pop().toLowerCase());
    parts = next; $('facade').checked = false; repairMode = false; viewMode = 'solid'; modelName = file.name.replace(/\.[^.]+$/, ''); rotation = [0, 0, 0]; $('unit').value = '1'; $('ratio').value = '1'; $('filename').textContent = modelName; $('filemeta').textContent = `${file.name.split('.').pop().toUpperCase()} · ${(file.size / 1024 / 1024).toFixed(2)} MB`; $('sample-tag').hidden = true; rebuild(); frame(); toast('模型已匯入，請確認原始單位與比例。');
  } catch (e) { toast(e.message || '無法讀取模型。'); }
  finally { importing = false; $('file-input').value = ''; showChecks(); }
}
for (const id of ['import-top', 'import-tool']) $(id).onclick = () => $('file-input').click();
$('file-input').onchange = e => importFile(e.target.files[0]);
let dragDepth = 0;
viewport.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; viewport.classList.add('dragging'); });
viewport.addEventListener('dragover', e => e.preventDefault());
viewport.addEventListener('dragleave', () => { if (--dragDepth <= 0) viewport.classList.remove('dragging'); });
viewport.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; viewport.classList.remove('dragging'); importFile(e.dataTransfer.files[0]); });
$('view-home').onclick = () => frame(); $('view-top').onclick = () => frame(true); $('model-tool').onclick = () => viewport.focus();
$('wireframe').onclick = () => { material.wireframe = !material.wireframe; $('wireframe').setAttribute('aria-pressed', String(material.wireframe)); };
$('grid-toggle').onclick = () => { grid.visible = !grid.visible; $('grid-toggle').setAttribute('aria-pressed', String(grid.visible)); };
function combinedPositions() {
  if (!result?.supports?.positions.length) return result.positions;
  const joined = new Float32Array(result.positions.length + result.supports.positions.length); joined.set(result.positions); joined.set(result.supports.positions, result.positions.length); return joined;
}
$('export').onclick = () => {
  if (!result || $('export').disabled) return;
  try {
    const mode = $('export-mode').value, is3mf = mode === 'multi-3mf';
    const data = is3mf ? multiMaterial3MF(result.positions, result.supports.positions, { name: modelName, modelMaterial: $('model-material').value, supportMaterial: $('support-material').value }) : binarySTL(mode === 'model' ? result.positions : mode === 'supports' ? result.supports.positions : combinedPositions());
    const url = URL.createObjectURL(new Blob([data], { type: is3mf ? 'model/3mf' : 'model/stl' }));
    const a = document.createElement('a'); a.href = url; a.download = `${modelName.replace(/[\\/:*?"<>|]/g, '_')}-fdm-${mode}.${is3mf ? '3mf' : 'stl'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(is3mf ? '雙材質 3MF 已匯出：請在切片軟體為 Model 與 Supports 指定不同耗材槽。' : 'STL 已匯出（毫米制、Z 軸朝上），可進行切片。');
  } catch (error) { toast(error.message || '匯出失敗，請確認模型與材質設定。'); }
};
$('load-demo').onclick = () => { if (importing) return; parts = demoParts(); $('facade').checked = false; repairMode = false; viewMode = 'solid'; modelName = '庭院集合住宅'; rotation = [0, 0, 0]; $('unit').value = '1000'; $('ratio').value = '100'; $('filename').textContent = modelName; $('filemeta').textContent = '示範模型 · 可旋轉檢視'; $('sample-tag').hidden = false; rebuild(); frame(); };
document.querySelectorAll('.help-open').forEach(b => b.onclick = () => $('help').showModal());
document.querySelector('.dialog-close').onclick = () => $('help').close();
const lifecycle = new AbortController();
try { Promise.resolve(document.modelContext?.registerTool({ name: 'set_model_scale', description: 'Set the current building model scale denominator and update the preview. Does not export a file.', inputSchema: { type: 'object', properties: { denominator: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 } }, required: ['denominator'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: input => { if (!input || typeof input.denominator !== 'number' || !Number.isFinite(input.denominator) || input.denominator <= 0 || input.denominator > 1000000) throw new Error('Invalid denominator'); $('ratio').value = String(input.denominator); rebuild(); return { denominator: config().ratio, status: 'analysis_pending' }; } }, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Optional browser API. */ }
window.addEventListener('pagehide', () => { lifecycle.abort(); worker.terminate(); renderer?.dispose(); });
rebuild(); frame();
