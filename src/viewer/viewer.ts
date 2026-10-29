import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  DEFAULT_LIMITS,
  DEFAULT_MAX_FILE_BYTES,
  type ModelSource,
  type ParsedModel,
  type ViewerConfig,
  type ViewerHandle,
  type ViewerViewState,
} from '../shared/types';
import { extensionOf, fileNameOf, SUPPORTED_EXTENSIONS } from '../shared/formats';
import { loadGltf } from './gltf';
import { ComparisonSession } from './comparison';
import { loadLargeModel, sourceFromBlob, sourceFromHttp } from '../large/index';

const icons: Record<string, string> = {
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z"/>',
  grid: '<path d="M3 3h18v18H3zM9 3v18m6-18v18M3 9h18M3 15h18"/>',
  box: '<path d="M3 8V3h5m8 0h5v5M3 16v5h5m13-5v5h-5M7 7h10v10H7z"/>',
  axes: '<path d="M6 18 6 3m0 15h15M6 18l10-10M3 6l3-3 3 3m9 9 3 3-3 3M12 8h4v4"/>',
  ruler: '<path d="m3 16 13-13 5 5L8 21zM12 7l3 3m-6 0 3 3m-6 0 3 3"/>',
  folder: '<path d="M3 6h6l2 2h10v12H3zM3 6V4h7l2 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v2"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7"/>',
  reload: '<path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const svg = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.cube}</svg>`;
const phrases: Record<string, [string, string]> = {
  title: ['ModelDock', 'ModelDock'],
  open: ['Open model', '打开模型'],
  idle: ['Ready to inspect', '等待打开模型'],
  fit: ['Fit model (F)', '适应窗口 (F)'],
  reset: ['Reset view (R)', '重置视角 (R)'],
  grid: ['Grid (G)', '网格 (G)'],
  bounds: ['Bounding box (B)', '包围盒 (B)'],
  axes: ['Axes (A)', '坐标轴 (A)'],
  measure: ['Measure two points (M)', '测量两点 (M)'],
  inspect: ['Inspect', '模型信息'],
  display: ['DISPLAY', '显示'],
  parts: ['PARTS', '部件'],
  geometry: ['GEOMETRY', '几何信息'],
  vertices: ['Vertices', '顶点'],
  triangles: ['Triangles', '三角面'],
  units: ['Units', '单位'],
  size: ['Dimensions', '尺寸'],
  source: ['Source', '文件'],
  solid: ['Solid', '实体'],
  wireframe: ['Wireframe', '线框'],
  points: ['Points', '点云'],
  normals: ['Normals', '法线'],
  pointSize: ['Point size', '点大小'],
  perspective: ['Perspective', '透视'],
  orthographic: ['Orthographic', '正交'],
  clipping: ['SECTION PLANE', '剖切平面'],
  off: ['Off', '关闭'],
  help: ['CONTROLS', '操作'],
  rotate: ['Left drag · Rotate', '左键拖动 · 旋转'],
  pan: ['Right drag · Pan', '右键拖动 · 平移'],
  zoom: ['Wheel / pinch · Zoom', '滚轮 / 双指 · 缩放'],
  center: ['Double click · Set pivot', '双击 · 设置旋转中心'],
  live: ['Local preview', '本地预览'],
  front: ['Front (1)', '前视图 (1)'],
  right: ['Right (3)', '右视图 (3)'],
  top: ['Top (7)', '顶视图 (7)'],
  iso: ['Isometric', '等轴视图'],
  up: ['Up axis', '向上轴'],
  drop: ['Your next model, one click away.', '让模型像代码一样，即点即看。'],
  dropHint: ['Drop a model here or choose a file.', '拖入模型，或点击打开文件。'],
  embeddedHint: [
    'Open a supported model file in your workspace.',
    '在工作区中打开支持的模型文件。',
  ],
  formats: ['Point clouds · Meshes · CAD', '点云 · 网格 · CAD'],
  loading: ['Loading model…', '正在加载模型…'],
  decoding: ['Decoding geometry…', '正在解析几何…'],
  cancel: ['Cancel', '取消'],
  retry: ['Retry', '重试'],
  failed: ['Unable to preview this model', '无法预览此模型'],
  previous: ['The previous model remains visible.', '仍保留上一次成功加载的模型。'],
  measuring: [
    'Click two visible surface points. Distances use the displayed model units.',
    '依次点击两个可见表面点；距离按显示的模型单位计算。',
  ],
  approximate: ['Approximate mesh distance', '网格近似距离'],
  clear: ['Clear', '清除'],
  empty: ['No geometry', '没有几何数据'],
  reloading: ['Refreshing…', '正在刷新…'],
};

type RenderObject = THREE.Mesh | THREE.Points | THREE.LineSegments;
type DisposableMaterial = THREE.Material & { map?: THREE.Texture; normalMap?: THREE.Texture };

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    const object = node as RenderObject;
    if (object.geometry) geometries.add(object.geometry);
    const ms = object.material
      ? Array.isArray(object.material)
        ? object.material
        : [object.material]
      : [];
    for (const material of ms) materials.add(material);
    for (const material of node.userData.originalMaterials ?? []) materials.add(material);
    for (const material of Object.values(node.userData.displayMaterials ?? {}))
      materials.add(material as THREE.Material);
  });
  for (const material of materials)
    for (const value of Object.values(material as DisposableMaterial))
      if (value instanceof THREE.Texture) textures.add(value);
  textures.forEach((t) => t.dispose());
  materials.forEach((m) => m.dispose());
  geometries.forEach((g) => g.dispose());
}

function buildObject(model: ParsedModel, pointSize: number): THREE.Group {
  const group = new THREE.Group();
  for (const primitive of model.primitives) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(primitive.positions, 3));
    if (primitive.normals)
      geometry.setAttribute('normal', new THREE.BufferAttribute(primitive.normals, 3));
    if (primitive.colors)
      geometry.setAttribute('color', new THREE.BufferAttribute(primitive.colors, 3));
    if (primitive.indices) geometry.setIndex(new THREE.BufferAttribute(primitive.indices, 1));
    const color = primitive.color
      ? new THREE.Color(...primitive.color)
      : new THREE.Color('#a9cddd');
    let object: RenderObject;
    if (primitive.mode === 'points') {
      object = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: primitive.colors ? 0xffffff : color,
          vertexColors: !!primitive.colors,
          size: pointSize,
          sizeAttenuation: false,
        }),
      );
    } else if (primitive.mode === 'lines') {
      object = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color, vertexColors: !!primitive.colors }),
      );
    } else {
      if (!primitive.normals) geometry.computeVertexNormals();
      object = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: primitive.colors ? 0xffffff : color,
          vertexColors: !!primitive.colors,
          side: THREE.DoubleSide,
          roughness: 0.68,
          metalness: 0.08,
        }),
      );
    }
    object.name = primitive.name || `Part ${group.children.length + 1}`;
    group.add(object);
  }
  return group;
}

/** All DOM access is scoped to the supplied element, including in Harness Shadow DOM. */
export function mountViewer(container: HTMLElement, config: ViewerConfig): ViewerHandle {
  const root = document.createElement('div');
  root.className = 'md-app';
  root.tabIndex = 0;
  root.dataset.state = 'idle';
  container.append(root);
  let language =
    config.language ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');
  const t = (key: string) => phrases[key]?.[language === 'zh-CN' ? 1 : 0] ?? key;
  const button = (action: string, icon: string, label = action, active = false) =>
    `<button class="md-icon-button${active ? ' is-active' : ''}" data-action="${action}" data-tip="${label}" aria-label="${t(label)}" title="${t(label)}"${['grid', 'bounds', 'axes', 'measure', 'inspect'].includes(action) ? ` aria-pressed="${active}"` : ''}>${svg(icon)}</button>`;
  root.innerHTML = `
    <header class="md-header"><div class="md-brand">${svg('cube')}<strong>ModelDock</strong><span class="md-divider"></span><span class="md-filename" data-role="filename">${t('idle')}</span><span class="md-format" data-role="format">3D</span></div><div class="md-header-actions"><span class="md-local"><i></i><span data-i18n="live">${t('live')}</span></span><button class="md-language" data-action="language">${language === 'en' ? '中文' : 'EN'}</button>${button('open', 'folder')}${button('inspect', 'info', 'inspect', true)}</div></header>
    <div class="md-body"><main class="md-viewport" data-role="viewport" aria-label="3D viewport">
      <div class="md-toolbar">${button('fit', 'fit')}${button('reset', 'reset')}<span></span>${button('grid', 'grid', 'grid', true)}${button('bounds', 'box')}${button('axes', 'axes', 'axes', true)}<span></span>${button('measure', 'ruler')}</div>
      <div class="md-presets"><button data-action="front" data-tip="front">F</button><button data-action="right" data-tip="right">R</button><button data-action="top" data-tip="top">T</button><button data-action="iso" data-tip="iso">ISO</button></div>
      <div class="md-gizmo" data-role="gizmo" aria-hidden="true"><span class="md-axis-x">X</span><span class="md-axis-y">Y</span><span class="md-axis-z">Z</span></div>
      <section class="md-empty" data-role="empty"><div class="md-empty-cube">${svg('cube')}</div><h1 data-i18n="drop">${t('drop')}</h1><p data-i18n="${config.allowFilePicker ? 'dropHint' : 'embeddedHint'}">${t(config.allowFilePicker ? 'dropHint' : 'embeddedHint')}</p>${config.allowFilePicker ? '<button class="md-primary" data-action="open" data-i18n="open">' + t('open') + '</button>' : ''}<small data-i18n="formats">${t('formats')}</small><div class="md-format-chips"><span>PLY</span><span>STEP</span><span>STL</span><span>GLB</span><span>+10</span></div></section>
      <div class="md-loading" data-role="loading" hidden><div class="md-spinner"></div><span data-role="progress">${t('loading')}</span><button data-action="cancel" data-i18n="cancel">${t('cancel')}</button></div>
      <div class="md-error" data-role="error" hidden role="alert"><strong data-i18n="failed">${t('failed')}</strong><p data-role="error-message"></p><div><button data-action="retry" data-i18n="retry">${t('retry')}</button><button data-action="dismiss" data-i18n="close">×</button></div></div>
      <div class="md-measure" data-role="measurement" hidden><span data-role="measure-text"></span><button data-action="clear" data-i18n="clear">${t('clear')}</button></div>
      <div class="md-view-label"><span data-role="projection-label">${t('perspective')}</span><span class="md-dot">·</span><span data-role="view-label">${t('iso')}</span></div>
    </main><aside class="md-inspector" data-role="inspector"><div class="md-inspector-title"><strong data-i18n="inspect">${t('inspect')}</strong><span>⌘ 3D</span></div>
      <section><h2 data-i18n="geometry">${t('geometry')}</h2><dl><div><dt data-i18n="vertices">${t('vertices')}</dt><dd data-role="vertices">—</dd></div><div><dt data-i18n="triangles">${t('triangles')}</dt><dd data-role="triangles">—</dd></div><div><dt data-i18n="units">${t('units')}</dt><dd data-role="units">—</dd></div></dl><div class="md-dimensions"><span data-i18n="size">${t('size')}</span><code data-role="dimensions">—</code></div></section>
      <section><h2 data-i18n="display">${t('display')}</h2><select data-control="display" aria-label="Display mode"><option value="solid" data-i18n="solid">${t('solid')}</option><option value="wireframe" data-i18n="wireframe">${t('wireframe')}</option><option value="points" data-i18n="points">${t('points')}</option><option value="normals" data-i18n="normals">${t('normals')}</option></select><div class="md-control-row"><label data-i18n="pointSize">${t('pointSize')}</label><output data-role="point-size">3 px</output></div><input data-control="pointSize" aria-label="Point size" type="range" min="1" max="12" step="0.5" value="3"><div class="md-control-row"><select data-control="projection" aria-label="Projection"><option value="perspective" data-i18n="perspective">${t('perspective')}</option><option value="orthographic" data-i18n="orthographic">${t('orthographic')}</option></select><select data-control="up" aria-label="Up axis"><option value="y">Y ↑</option><option value="z">Z ↑</option></select></div></section>
      <section><h2 data-i18n="clipping">${t('clipping')}</h2><select data-control="clip" aria-label="Clipping axis"><option value="off" data-i18n="off">${t('off')}</option><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select><input data-control="clipPosition" aria-label="Clipping position" type="range" min="-100" max="100" step="1" value="0" disabled></section>
      <section class="md-parts-section"><h2><span data-i18n="parts">${t('parts')}</span><span data-role="parts-count">0</span></h2><div class="md-parts" data-role="parts"></div></section>
      <section class="md-warnings" data-role="warnings" hidden></section>
      <section class="md-help"><h2 data-i18n="help">${t('help')}</h2><p data-i18n="rotate">${t('rotate')}</p><p data-i18n="pan">${t('pan')}</p><p data-i18n="zoom">${t('zoom')}</p><p data-i18n="center">${t('center')}</p></section>
    </aside></div><footer class="md-footer"><span><i class="md-status-dot"></i><span data-role="status">${t('idle')}</span></span><span data-role="file-size">PLY / STL / STEP / IGES / GLB</span><span class="md-footer-hint">F · ${t('fit').replace(' (F)', '')}</span></footer><input data-role="add-input" type="file" multiple hidden><input data-role="file-input" type="file" multiple accept="${SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(',')}" hidden>`;
  const el = <T extends HTMLElement = HTMLElement>(role: string) =>
    root.querySelector<T>(`[data-role="${role}"]`)!;
  const control = <T extends HTMLInputElement | HTMLSelectElement>(name: string) =>
    root.querySelector<T>(`[data-control="${name}"]`)!;
  const viewport = el('viewport');
  let disposed = false,
    pending = 0,
    worker: Worker | undefined,
    workerBlob: string | undefined;
  let activeReject: ((error: Error) => void) | undefined, abort: AbortController | undefined;
  let currentSource: ModelSource | undefined,
    loadedName = '',
    units = 'model units';
  let content: THREE.Object3D | undefined,
    boxHelper: THREE.Box3Helper | undefined,
    grid: THREE.GridHelper | undefined;
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  let projection: 'perspective' | 'orthographic' = 'perspective';
  let upAxis: 'y' | 'z' = 'y',
    pointSize = 3,
    showGrid = true,
    showBounds = false,
    showAxes = true,
    measuring = false;
  let bounds = new THREE.Box3(),
    dimensions = new THREE.Vector3(1, 1, 1),
    radius = 1;
  const lights = new THREE.Group(),
    scene = new THREE.Scene(),
    modelParent = new THREE.Group();
  scene.background = new THREE.Color('#101922');
  scene.add(modelParent, lights);
  const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x536477, 2.1);
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(3, 5, 4);
  const rim = new THREE.DirectionalLight(0x81b7ff, 1.4);
  rim.position.set(-4, 2, -4);
  lights.add(hemi, key, rim);
  let renderer: THREE.WebGLRenderer;
  function showError(message: string): void {
    if (disposed) return;
    root.dataset.state = 'error';
    el('loading').hidden = true;
    el('error').hidden = false;
    el('error-message').textContent = message + (content ? ` ${t('previous')}` : '');
    el('status').textContent = t('failed');
  }
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    showError(
      'WebGL 2 is unavailable. Enable hardware acceleration or update your graphics driver, then reopen this preview.',
    );
    return {
      load: async () => undefined,
      showError,
      dispose: () => {
        disposed = true;
        root.remove();
      },
    };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.localClippingEnabled = true;
  renderer.domElement.className = 'md-canvas';
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D model');
  viewport.prepend(renderer.domElement);
  camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000);
  camera.position.set(2, 1.4, 2.4);
  let controls = new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(
    camera,
    renderer.domElement,
  );
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  const axes = new THREE.AxesHelper(1.1);
  scene.add(axes);
  const rulerGroup = new THREE.Group();
  scene.add(rulerGroup);
  let measurePoints: THREE.Vector3[] = [];
  let frame = 0;
  const clipPlane = new THREE.Plane();
  const chooseFiles = async (add = false) => {
    if (config.pickFiles) {
      try {
        const sources = await config.pickFiles();
        for (let i = 0; i < sources.length; i++) await load(sources[i], { add: add || i > 0 });
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      }
    } else el<HTMLInputElement>(add ? 'add-input' : 'file-input').click();
  };
  const comparison = new ComparisonSession(
    root,
    language,
    (fitView = false) => {
      refreshSceneBounds();
      if (fitView) fit();
      else {
        resize();
        requestRender();
      }
    },
    disposeObject,
    () => void chooseFiles(true),
  );

  function requestRender(): void {
    if (!disposed && !frame) frame = requestAnimationFrame(render);
  }
  function render(): void {
    frame = 0;
    if (disposed) return;
    if (controls.update()) requestRender();
    lights.quaternion.copy(camera.quaternion);
    const split = comparison.mode === 'split' && comparison.entries.length > 1;
    const w = viewport.clientWidth,
      h = viewport.clientHeight;
    if (split) {
      renderer.setScissorTest(true);
      const half = Math.floor(w / 2);
      const splitCamera = camera.clone();
      if (splitCamera instanceof THREE.PerspectiveCamera)
        splitCamera.aspect = half / Math.max(h, 1);
      else if (splitCamera instanceof THREE.OrthographicCamera) {
        const center = (splitCamera.left + splitCamera.right) / 2,
          span = (splitCamera.right - splitCamera.left) / 4;
        splitCamera.left = center - span;
        splitCamera.right = center + span;
      }
      splitCamera.updateProjectionMatrix();
      comparison.applyVisibility('source');
      renderer.setViewport(0, 0, half, h);
      renderer.setScissor(0, 0, half, h);
      renderer.render(scene, splitCamera);
      comparison.applyVisibility('reference');
      renderer.setViewport(half, 0, w - half, h);
      renderer.setScissor(half, 0, w - half, h);
      renderer.render(scene, splitCamera);
      comparison.applyVisibility();
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
    } else renderer.render(scene, camera);
    root.dataset.camera = [...camera.position.toArray(), ...controls.target.toArray(), camera.zoom]
      .map((n) => n.toFixed(5))
      .join(',');
    const inverse = camera.quaternion.clone().invert();
    ['x', 'y', 'z'].forEach((axis, i) => {
      const v = new THREE.Vector3(
        i === 0 ? 1 : 0,
        i === 1 ? 1 : 0,
        i === 2 ? 1 : 0,
      ).applyQuaternion(inverse);
      const tag = el('gizmo').children[i] as HTMLElement;
      tag.style.transform = `translate(${v.x * 27}px,${-v.y * 27}px)`;
      tag.style.opacity = v.z < -0.15 ? '0.4' : '1';
    });
  }
  controls.addEventListener('change', requestRender);
  function resize(): void {
    const w = Math.max(1, viewport.clientWidth),
      h = Math.max(1, viewport.clientHeight);
    renderer.setSize(w, h, false);
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = w / h;
    else {
      const half = (radius * 1.25) / Math.min(1, w / h);
      camera.left = (-half * w) / h;
      camera.right = (half * w) / h;
      camera.top = half;
      camera.bottom = -half;
    }
    camera.updateProjectionMatrix();
    requestRender();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);

  function fit(reset = false, direction?: THREE.Vector3): void {
    const aspect =
      Math.max(
        viewport.clientWidth /
          (comparison.mode === 'split' && comparison.entries.length > 1 ? 2 : 1),
        1,
      ) / Math.max(viewport.clientHeight, 1);
    const fov = Math.PI / 4,
      fitFov = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * aspect) : fov;
    const distance = (radius / Math.sin(fitFov / 2)) * 1.16;
    const dir =
      direction ??
      (reset
        ? upAxis === 'y'
          ? new THREE.Vector3(1, 0.7, 1.2)
          : new THREE.Vector3(1, -1.2, 0.8)
        : camera.position.clone().sub(controls.target));
    if (dir.lengthSq() === 0) dir.set(1, 1, 1);
    camera.up.set(0, upAxis === 'y' ? 1 : 0, upAxis === 'z' ? 1 : 0);
    camera.position.copy(dir.normalize().multiplyScalar(distance));
    // OrbitControls caches the up-axis quaternion. Recreate it after a basis change
    // and clear any remaining drag inertia before applying an exact preset.
    controls.dispose();
    controls = new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(
      camera,
      renderer.domElement,
    );
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.addEventListener('change', requestRender);
    controls.target.set(0, 0, 0);
    camera.near = Math.max(radius / 10000, 1e-8);
    camera.far = radius * 1000;
    camera.zoom = 1;
    controls.minDistance = Math.max(radius / 10000, 1e-8);
    controls.maxDistance = radius * 500;
    controls.update();
    controls.saveState();
    resize();
    el('view-label').textContent = reset
      ? t('iso')
      : loadedName
        ? t('fit').replace(' (F)', '')
        : t('iso');
  }
  function updateHelpers(): void {
    if (grid) {
      scene.remove(grid);
      disposeObject(grid);
    }
    const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(radius * 3, 1e-8))));
    grid = new THREE.GridHelper(gridSize * 5, 20, 0x354c60, 0x233343);
    if (upAxis === 'y') grid.position.y = -dimensions.y / 2;
    else {
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -dimensions.z / 2;
    }
    grid.visible = showGrid;
    scene.add(grid);
    axes.scale.setScalar(radius * 0.7);
    axes.visible = showAxes;
    if (boxHelper) {
      scene.remove(boxHelper);
      disposeObject(boxHelper);
    }
    boxHelper = new THREE.Box3Helper(bounds, 0x6cd9c4);
    boxHelper.visible = showBounds;
    scene.add(boxHelper);
    requestRender();
  }
  function clearMeasure(): void {
    measurePoints = [];
    disposeObject(rulerGroup);
    rulerGroup.clear();
    el('measurement').hidden = !measuring;
    el('measure-text').textContent = t('measuring');
    requestRender();
  }
  function materialList(object: RenderObject): THREE.Material[] {
    return Array.isArray(object.material) ? object.material : [object.material];
  }
  function applyClipping(): void {
    const axis = control<HTMLSelectElement>('clip').value;
    const enabled = axis !== 'off';
    control<HTMLInputElement>('clipPosition').disabled = !enabled;
    const offset = Number(control<HTMLInputElement>('clipPosition').value) / 100;
    clipPlane.normal.set(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, axis === 'z' ? -1 : 0);
    clipPlane.constant =
      ((axis === 'x' ? dimensions.x : axis === 'y' ? dimensions.y : dimensions.z) / 2) * offset;
    content?.traverse((node) => {
      const obj = node as RenderObject;
      if (!obj.material) return;
      materialList(obj).forEach((mat) => {
        mat.clippingPlanes = enabled ? [clipPlane] : [];
        mat.needsUpdate = true;
      });
    });
    requestRender();
  }
  function setDisplay(mode: string): void {
    content?.traverse((node) => {
      const obj = node as RenderObject;
      if (!obj.geometry || obj.userData.displayOverlay) return;
      if ((obj as THREE.Points).isPoints) {
        (obj.material as THREE.PointsMaterial).size = pointSize;
        return;
      }
      if (!(obj as THREE.Mesh).isMesh) return;
      const original = (obj.userData.originalMaterials ??= materialList(obj));
      const cache = (obj.userData.displayMaterials ??= {}) as Record<string, THREE.Material>;
      for (const child of obj.children) if (child.userData.displayOverlay) child.visible = false;
      if (mode === 'normals')
        obj.material = cache.normals ??= new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
      else if (mode === 'wireframe')
        obj.material = cache.wire ??= new THREE.MeshBasicMaterial({
          color: 0x7cdac8,
          wireframe: true,
          side: THREE.DoubleSide,
        });
      else if (mode === 'points') {
        obj.material = cache.hidden ??= new THREE.MeshBasicMaterial({ visible: false });
        let overlay = obj.children.find((c) => c.userData.displayOverlay) as
          | THREE.Points
          | undefined;
        if (!overlay) {
          overlay = new THREE.Points(
            obj.geometry,
            new THREE.PointsMaterial({
              color: obj.geometry.hasAttribute('color') ? 0xffffff : 0x9cddd4,
              vertexColors: obj.geometry.hasAttribute('color'),
              size: pointSize,
              sizeAttenuation: false,
            }),
          );
          overlay.userData.displayOverlay = true;
          obj.add(overlay);
        }
        overlay.visible = true;
        (overlay.material as THREE.PointsMaterial).size = pointSize;
      } else obj.material = original.length === 1 ? original[0] : original;
    });
    applyClipping();
    comparison.applyVisibility();
    requestRender();
  }
  function refreshSceneBounds(): void {
    modelParent.position.set(0, 0, 0);
    modelParent.updateMatrixWorld(true);
    const raw = new THREE.Box3().setFromObject(comparison.group);
    if (raw.isEmpty()) return;
    const center = raw.getCenter(new THREE.Vector3());
    modelParent.position.copy(center).negate();
    modelParent.updateMatrixWorld(true);
    bounds = raw.clone().translate(center.negate());
    dimensions = bounds.getSize(new THREE.Vector3());
    radius = Math.max(dimensions.length() / 2, 1e-5);
    updateHelpers();
    applyClipping();
  }
  function replaceObject(
    next: THREE.Object3D,
    warnings: string[],
    nextUnits: string,
    keepView: boolean,
    source: ModelSource,
    add = false,
    origin: [number, number, number] = [0, 0, 0],
    preview?: object,
  ): void {
    next.updateMatrixWorld(true);
    const sourceBounds = new THREE.Box3().setFromObject(next);
    if (
      sourceBounds.isEmpty() ||
      ![...sourceBounds.min.toArray(), ...sourceBounds.max.toArray()].every(Number.isFinite)
    ) {
      disposeObject(next);
      throw new Error('Model has no finite displayable geometry.');
    }
    comparison.install(next, source, nextUnits, origin, preview, add, keepView);
    content = comparison.group;
    if (content.parent !== modelParent) modelParent.add(content);
    refreshSceneBounds();
    units = nextUnits;
    let vertices = 0,
      triangles = 0;
    const objects: RenderObject[] = [];
    next.traverse((node) => {
      const obj = node as RenderObject;
      const pos = obj.geometry?.getAttribute('position');
      if (!pos) return;
      vertices += pos.count;
      if ((obj as THREE.Mesh).isMesh)
        triangles += Math.floor((obj.geometry.index?.count ?? pos.count) / 3);
      objects.push(obj);
    });
    root.dataset.vertices = String(vertices);
    root.dataset.triangles = String(triangles);
    root.dataset.parts = String(objects.length);
    el('vertices').textContent = vertices.toLocaleString();
    el('triangles').textContent = triangles.toLocaleString();
    el('units').textContent = units;
    el('dimensions').textContent = dimensions
      .toArray()
      .map((n) => n.toLocaleString(undefined, { maximumSignificantDigits: 5 }))
      .join(' × ');
    el('parts-count').textContent = String(objects.length);
    el('parts').replaceChildren();
    for (const [index, obj] of objects.slice(0, 500).entries()) {
      const label = document.createElement('label');
      label.className = 'md-part';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      const text = document.createElement('span');
      text.textContent = obj.name || `Part ${index + 1}`;
      text.title = text.textContent;
      checkbox.addEventListener('change', () => {
        obj.visible = checkbox.checked;
        requestRender();
      });
      label.append(checkbox, text);
      el('parts').append(label);
    }
    if (objects.length > 500)
      warnings = [...warnings, 'Only the first 500 parts are listed; all geometry is rendered.'];
    el('warnings').replaceChildren();
    el('warnings').hidden = !warnings.length;
    for (const warning of warnings) {
      const p = document.createElement('p');
      p.textContent = warning;
      el('warnings').append(p);
    }
    clearMeasure();
    updateHelpers();
    setDisplay(control<HTMLSelectElement>('display').value);
    if (!keepView) fit(true);
    else {
      camera.near = Math.max(radius / 10000, 1e-8);
      camera.far = radius * 1000;
      camera.updateProjectionMatrix();
      requestRender();
    }
    el('empty').hidden = true;
  }
  function cancelDecode(): void {
    abort?.abort();
    abort = undefined;
    worker?.terminate();
    worker = undefined;
    if (workerBlob) {
      URL.revokeObjectURL(workerBlob);
      workerBlob = undefined;
    }
    activeReject?.(new Error('Loading cancelled.'));
    activeReject = undefined;
  }
  async function decode(data: ArrayBuffer, name: string, id: number): Promise<ParsedModel> {
    const response = await fetch(config.assets.worker, { signal: abort?.signal });
    if (!response.ok) throw new Error(`Unable to load decoder (${response.status}).`);
    const source = await response.text();
    if (disposed || id !== pending) throw new Error('Loading cancelled.');
    workerBlob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(workerBlob);
    return await new Promise((resolve, reject) => {
      activeReject = reject;
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error('Parsing exceeded 120 seconds. Try lower CAD quality or a smaller model.'),
        );
      }, 120000);
      const cleanup = () => {
        clearTimeout(timeout);
        activeReject = undefined;
        worker?.terminate();
        worker = undefined;
        if (workerBlob) {
          URL.revokeObjectURL(workerBlob);
          workerBlob = undefined;
        }
      };
      activeReject = (error) => {
        cleanup();
        reject(error);
      };
      worker!.onmessage = (event) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === 'progress') {
          el('progress').textContent = message.message;
          return;
        }
        cleanup();
        if (message.type === 'result') resolve(message.model);
        else reject(new Error(message.message || 'Model decoding failed.'));
      };
      worker!.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || 'The decoder worker failed.'));
      };
      worker!.postMessage(
        {
          type: 'decode',
          id,
          buffer: data,
          name,
          options: {
            ...DEFAULT_LIMITS,
            cadQuality: config.cadQuality ?? 'medium',
            maxVertices: config.maxVertices ?? DEFAULT_LIMITS.maxVertices,
            maxTriangles: config.maxTriangles ?? DEFAULT_LIMITS.maxTriangles,
          },
          assets: config.assets,
        },
        [data],
      );
    });
  }
  async function load(
    source: ModelSource,
    options: { preserveView?: boolean; add?: boolean } = {},
  ): Promise<void> {
    if (disposed) return;
    const id = ++pending;
    cancelDecode();
    currentSource = source;
    const loadAbort = new AbortController();
    abort = loadAbort;
    root.dataset.state = 'loading';
    el('loading').hidden = false;
    el('error').hidden = true;
    el('progress').textContent = t('loading');
    el('status').textContent = t(options.preserveView ? 'reloading' : 'loading');
    const filename = fileNameOf(source.name);
    const maxBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    try {
      const size = source.size ?? source.blob?.size ?? source.data?.byteLength;
      if (size !== undefined && size > maxBytes)
        throw new Error('File exceeds the configured byte limit.');
      const start = performance.now();
      if ((size ?? 0) > 128 * 1024 * 1024 || (source.readRange && size === undefined)) {
        const random = source.blob
          ? sourceFromBlob(source.blob, filename)
          : source.data
            ? {
                name: filename,
                size: source.data.byteLength,
                read: async (offset: number, length: number) =>
                  new Uint8Array(
                    source.data!,
                    offset,
                    Math.min(length, source.data!.byteLength - offset),
                  ),
              }
            : source.readRange && size !== undefined
              ? { name: filename, size, read: source.readRange }
              : source.url
                ? await sourceFromHttp(source.url, {
                    name: filename,
                    size,
                    signal: loadAbort.signal,
                  })
                : undefined;
        if (!random)
          throw new Error(
            'Large previews require a local file or a range-readable source. Use Add models to select the file locally.',
          );
        const parsed = await loadLargeModel(random, {
          maxPoints: Math.min(config.maxVertices ?? 300000, 300000),
          maxTriangles: Math.min(config.maxTriangles ?? 100000, 100000),
          maxReadBytes: 128 * 1024 * 1024,
          signal: loadAbort.signal,
          onProgress: (p) => {
            if (id === pending)
              el('progress').textContent =
                `${p.phase} · ${p.completedRecords.toLocaleString()} / ${p.totalRecords.toLocaleString()} · ${(p.readBytes / 1024 / 1024).toFixed(1)} MiB read`;
          },
        });
        if (id !== pending || disposed) return;
        replaceObject(
          buildObject(parsed, pointSize),
          parsed.warnings,
          parsed.units,
          !!options.preserveView && !!content,
          source,
          options.add,
          parsed.origin,
          parsed.preview,
        );
        finishLoad(filename, source, size ?? random.size, start, options.add);
        return;
      }
      let data: ArrayBuffer;
      if (source.readRange && size !== undefined) {
        const bytes = new Uint8Array(size);
        for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
          if (loadAbort.signal.aborted) throw new Error('Loading cancelled.');
          const length = Math.min(4 * 1024 * 1024, size - offset);
          const chunk = await source.readRange(offset, length, loadAbort.signal);
          if (chunk.length !== length) throw new Error('Model byte range was truncated.');
          bytes.set(chunk, offset);
        }
        data = bytes.buffer;
      } else if (source.blob) {
        data = await source.blob.arrayBuffer();
      } else if (source.data) {
        if (source.data.byteLength > maxBytes)
          throw new Error(`File exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB limit.`);
        data = source.data.slice(0);
      } else if (source.url) {
        const response = await fetch(source.url, { signal: loadAbort.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`Unable to read model (${response.status}).`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxBytes)
          throw new Error(`File exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB limit.`);
        if (declared > 128 * 1024 * 1024) {
          await response.body?.cancel();
          await load({ ...source, size: declared }, options);
          return;
        }
        // Streamed cap also protects servers that omit or misreport Content-Length.
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let length = 0;
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            length += result.value.byteLength;
            if (length > 128 * 1024 * 1024) {
              await reader.cancel();
              throw new Error(
                'This source did not declare its size. Select the file locally using Add models for a bounded large-file preview.',
              );
            }
            chunks.push(result.value);
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          data = bytes.buffer;
        } else data = await response.arrayBuffer();
      } else throw new Error('No model data was supplied.');
      if (data.byteLength === 0) throw new Error('The model file is empty.');
      if (data.byteLength > maxBytes) throw new Error('File exceeds the configured byte limit.');
      if (id !== pending || disposed) return;
      const byteLength = data.byteLength;
      el('progress').textContent = t('decoding');
      if (['glb', 'gltf'].includes(extensionOf(filename))) {
        const next = await loadGltf(data, {
          ...DEFAULT_LIMITS,
          maxVertices: config.maxVertices ?? DEFAULT_LIMITS.maxVertices,
          maxTriangles: config.maxTriangles ?? DEFAULT_LIMITS.maxTriangles,
          maxFileBytes: maxBytes,
        });
        if (id !== pending || disposed) {
          disposeObject(next.object);
          return;
        }
        replaceObject(
          next.object,
          next.warnings,
          next.units,
          !!options.preserveView && !!content,
          source,
          options.add,
        );
      } else {
        const parsed = await decode(data, filename, id);
        if (id !== pending || disposed) return;
        replaceObject(
          buildObject(parsed, pointSize),
          parsed.warnings,
          parsed.units,
          !!options.preserveView && !!content,
          source,
          options.add,
          parsed.origin,
        );
      }
      finishLoad(filename, source, byteLength, start, options.add);
    } catch (error) {
      if (id === pending && !disposed)
        showError(error instanceof Error ? error.message : String(error));
    }
  }
  function finishLoad(
    filename: string,
    source: ModelSource,
    byteLength: number,
    start: number,
    add = false,
  ): void {
    loadedName = filename;
    el('filename').textContent = filename;
    el('filename').title = source.name;
    el('format').textContent = extensionOf(filename).toUpperCase();
    el('file-size').textContent =
      `${(byteLength / 1024 / 1024).toFixed(2)} MiB · ${((performance.now() - start) / 1000).toFixed(2)} s`;
    el('status').textContent = t('live');
    root.dataset.state = 'ready';
    root.dataset.filename = filename;
    el('loading').hidden = true;
    root.dispatchEvent(
      new CustomEvent('modeldock:loaded', {
        bubbles: true,
        composed: true,
        detail: {
          name: filename,
          add,
          vertices: Number(root.dataset.vertices),
          triangles: Number(root.dataset.triangles),
        },
      }),
    );
  }
  function pick(event: MouseEvent | PointerEvent): THREE.Vector3 | undefined {
    if (!content) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const split = comparison.mode === 'split' && comparison.entries.length > 1;
    const half = Math.floor(rect.width / 2),
      right = event.clientX - rect.left >= half;
    const width = split ? (right ? rect.width - half : half) : rect.width;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left - (split && right ? half : 0)) / width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.params.Points = { threshold: radius / 120 };
    const pickCamera = split ? camera.clone() : camera;
    if (split) {
      if (pickCamera instanceof THREE.PerspectiveCamera) pickCamera.aspect = width / rect.height;
      else if (pickCamera instanceof THREE.OrthographicCamera) {
        const center = (pickCamera.left + pickCamera.right) / 2,
          span = (pickCamera.right - pickCamera.left) / 4;
        pickCamera.left = center - span;
        pickCamera.right = center + span;
      }
      pickCamera.updateProjectionMatrix();
    }
    ray.setFromCamera(pointer, pickCamera);
    const hits = ray.intersectObject(content, true).filter((hit) => {
      if (split) {
        const selected = right ? comparison.reference : comparison.target;
        let entryObject: THREE.Object3D | null = hit.object;
        while (entryObject && entryObject.parent !== comparison.group)
          entryObject = entryObject.parent;
        if (!comparison.entries.some((e) => e.id === selected && e.object === entryObject))
          return false;
      }
      for (let obj: THREE.Object3D | null = hit.object; obj; obj = obj.parent)
        if (!obj.visible) return false;
      return (
        control<HTMLSelectElement>('clip').value === 'off' ||
        clipPlane.distanceToPoint(hit.point) >= 0
      );
    });
    return hits[0]?.point;
  }
  let pointerDown = { x: 0, y: 0 };
  renderer.domElement.addEventListener('pointerdown', (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
    root.focus({ preventScroll: true });
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (
      !measuring ||
      event.button !== 0 ||
      Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4
    )
      return;
    const hit = pick(event);
    if (!hit) return;
    if (measurePoints.length === 2) clearMeasure();
    measurePoints.push(hit.clone());
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(radius / 110, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffdc8b, depthTest: false }),
    );
    dot.position.copy(hit);
    dot.renderOrder = 20;
    rulerGroup.add(dot);
    if (measurePoints.length === 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(measurePoints),
        new THREE.LineBasicMaterial({ color: 0xffdc8b, depthTest: false }),
      );
      line.renderOrder = 20;
      rulerGroup.add(line);
      const distance = measurePoints[0].distanceTo(measurePoints[1]);
      el('measure-text').textContent =
        `${t('approximate')}: ${distance.toLocaleString(undefined, { maximumSignificantDigits: 7 })} ${units}`;
    }
    requestRender();
  });
  renderer.domElement.addEventListener('dblclick', (event) => {
    if (measuring) return;
    const hit = pick(event);
    if (hit) {
      controls.target.copy(hit);
      controls.update();
      requestRender();
    }
  });
  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    showError('The graphics context was lost. Reopen the preview or reduce model size.');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    if (currentSource) void load(currentSource, { preserveView: true });
  });
  function setActive(action: string, active: boolean): void {
    const b = root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    b?.classList.toggle('is-active', active);
    b?.setAttribute('aria-pressed', String(active));
  }
  function setProjection(value: 'perspective' | 'orthographic'): void {
    if (projection === value) return;
    const position = camera.position.clone(),
      up = camera.up.clone();
    projection = value;
    camera =
      value === 'perspective'
        ? new THREE.PerspectiveCamera(45, 1, Math.max(radius / 10000, 1e-8), radius * 1000)
        : new THREE.OrthographicCamera(
            -radius,
            radius,
            radius,
            -radius,
            Math.max(radius / 10000, 1e-8),
            radius * 1000,
          );
    camera.position.copy(position);
    camera.up.copy(up);
    controls.object = camera;
    controls.update();
    control<HTMLSelectElement>('projection').value = value;
    el('projection-label').textContent = t(value);
    resize();
  }
  function action(name: string): void {
    if (name === 'fit') fit();
    else if (name === 'reset' || name === 'iso') fit(true);
    else if (name === 'front') {
      fit(false, upAxis === 'y' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, -1, 0));
      el('view-label').textContent = t('front');
    } else if (name === 'right') {
      fit(false, new THREE.Vector3(1, 0, 0));
      el('view-label').textContent = t('right');
    } else if (name === 'top') {
      fit(
        false,
        upAxis === 'y' ? new THREE.Vector3(0, 1, 0.000001) : new THREE.Vector3(0, -0.000001, 1),
      );
      el('view-label').textContent = t('top');
    } else if (name === 'grid') {
      showGrid = !showGrid;
      if (grid) grid.visible = showGrid;
      setActive(name, showGrid);
      requestRender();
    } else if (name === 'bounds') {
      showBounds = !showBounds;
      if (boxHelper) boxHelper.visible = showBounds;
      setActive(name, showBounds);
      requestRender();
    } else if (name === 'axes') {
      showAxes = !showAxes;
      axes.visible = showAxes;
      setActive(name, showAxes);
      requestRender();
    } else if (name === 'inspect') {
      el('inspector').hidden = !el('inspector').hidden;
      setActive(name, !el('inspector').hidden);
      resize();
    } else if (name === 'measure') {
      measuring = !measuring;
      setActive(name, measuring);
      clearMeasure();
    } else if (name === 'clear') clearMeasure();
    else if (name === 'open') void chooseFiles();
    else if (name === 'cancel') {
      ++pending;
      ++fileBatch;
      cancelDecode();
      el('loading').hidden = true;
      root.dataset.state = content ? 'ready' : 'idle';
      el('status').textContent = t(content ? 'live' : 'idle');
    } else if (name === 'retry' && currentSource) void load(currentSource, { preserveView: true });
    else if (name === 'dismiss') {
      el('error').hidden = true;
      root.dataset.state = content ? 'ready' : 'idle';
    } else if (name === 'language') {
      language = language === 'en' ? 'zh-CN' : 'en';
      root.querySelector<HTMLButtonElement>('[data-action="language"]')!.textContent =
        language === 'en' ? '中文' : 'EN';
      root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
        node.textContent = t(node.dataset.i18n!);
      });
      root.querySelectorAll<HTMLElement>('[data-tip]').forEach((node) => {
        node.title = t(node.dataset.tip!);
        node.setAttribute('aria-label', node.title);
      });
      comparison.setLanguage(language);
      el('projection-label').textContent = t(projection);
      el('status').textContent = t(content ? 'live' : 'idle');
    }
  }
  root.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[data-action]');
    if (target) action(target.dataset.action!);
  });
  root.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (
      ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const keys: Record<string, string> = {
      f: 'fit',
      r: 'reset',
      g: 'grid',
      b: 'bounds',
      a: 'axes',
      m: 'measure',
      '1': 'front',
      '3': 'right',
      '7': 'top',
    };
    if (keys[event.key.toLowerCase()]) {
      event.preventDefault();
      action(keys[event.key.toLowerCase()]);
    } else if (event.key === '5') {
      event.preventDefault();
      setProjection(projection === 'perspective' ? 'orthographic' : 'perspective');
    } else if (event.key.toLowerCase() === 'w') {
      const select = control<HTMLSelectElement>('display');
      select.value = select.value === 'wireframe' ? 'solid' : 'wireframe';
      setDisplay(select.value);
    } else if (event.key === 'Escape' && measuring) action('measure');
  });
  control<HTMLSelectElement>('display').addEventListener('change', (event) =>
    setDisplay((event.target as HTMLSelectElement).value),
  );
  control<HTMLInputElement>('pointSize').addEventListener('input', () => {
    pointSize = Number(control<HTMLInputElement>('pointSize').value);
    el('point-size').textContent = pointSize + ' px';
    setDisplay(control<HTMLSelectElement>('display').value);
  });
  control<HTMLSelectElement>('projection').addEventListener('change', () =>
    setProjection(control<HTMLSelectElement>('projection').value as typeof projection),
  );
  control<HTMLSelectElement>('up').addEventListener('change', () => {
    upAxis = control<HTMLSelectElement>('up').value as typeof upAxis;
    updateHelpers();
    fit(true);
  });
  control<HTMLSelectElement>('clip').addEventListener('change', applyClipping);
  control<HTMLInputElement>('clipPosition').addEventListener('input', applyClipping);
  let fileBatch = 0;
  const openFiles = async (files: FileList | File[] | null | undefined, add = false) => {
    if (!files?.length) return;
    const batch = ++fileBatch;
    if (!add)
      root.dispatchEvent(new CustomEvent('modeldock:localfile', { bubbles: true, composed: true }));
    for (let i = 0; i < files.length; i++) {
      if (batch !== fileBatch || disposed) break;
      const file = files[i];
      await load({ name: file.name, blob: file, size: file.size }, { add: add || i > 0 });
    }
  };
  for (const role of ['file-input', 'add-input'])
    el<HTMLInputElement>(role).addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const files = input.files ? Array.from(input.files) : [];
      input.value = '';
      void openFiles(files, role === 'add-input');
    });
  root.addEventListener('dragover', (event) => {
    event.preventDefault();
    root.classList.add('is-dragging');
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget as Node)) root.classList.remove('is-dragging');
  });
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    root.classList.remove('is-dragging');
    void openFiles(event.dataTransfer?.files, true);
  });
  root.querySelectorAll<HTMLElement>('[data-tip]').forEach((node) => {
    node.title = t(node.dataset.tip!);
    node.setAttribute('aria-label', node.title);
  });
  if (container.clientWidth < 760) {
    el('inspector').hidden = true;
    setActive('inspect', false);
  }
  resize();
  fit(true);
  if (config.initialFile) void load(config.initialFile);
  return {
    load,
    add: (source: ModelSource) => load(source, { add: true }),
    showError,
    getViewState: () => {
      if (!content || disposed) return;
      return {
        position: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
        upAxis,
        projection,
        zoom: camera.zoom,
        ...(camera instanceof THREE.OrthographicCamera
          ? { orthographicHeight: (camera.top - camera.bottom) / camera.zoom }
          : {}),
      };
    },
    setViewState: (state: ViewerViewState) => {
      if (!content || disposed || !state) return;
      const vector = (value: unknown): value is [number, number, number] =>
        Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
      if (
        !vector(state.position) ||
        !vector(state.target) ||
        !['y', 'z'].includes(state.upAxis) ||
        !['perspective', 'orthographic'].includes(state.projection) ||
        !Number.isFinite(state.zoom) ||
        state.zoom <= 0 ||
        (state.orthographicHeight !== undefined &&
          (!Number.isFinite(state.orthographicHeight) || state.orthographicHeight <= 0))
      )
        return;
      upAxis = state.upAxis;
      control<HTMLSelectElement>('up').value = upAxis;
      setProjection(state.projection);
      camera.up.set(0, upAxis === 'y' ? 1 : 0, upAxis === 'z' ? 1 : 0);
      camera.position.fromArray(state.position);
      camera.zoom = Math.min(1e6, Math.max(1e-6, state.zoom));
      if (camera instanceof THREE.OrthographicCamera && state.orthographicHeight) {
        camera.zoom = (camera.top - camera.bottom) / state.orthographicHeight;
      }
      controls.dispose();
      controls = new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(
        camera,
        renderer.domElement,
      );
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.zoomToCursor = true;
      controls.screenSpacePanning = true;
      controls.target.fromArray(state.target);
      camera.position.fromArray(state.position);
      const distance = camera.position.distanceTo(controls.target);
      controls.minDistance = Math.max(1e-10, Math.min(radius / 10000, distance / 2));
      controls.maxDistance = Math.max(radius * 500, distance * 2);
      camera.far = Math.max(radius * 1000, distance * 10);
      controls.addEventListener('change', requestRender);
      controls.update();
      controls.saveState();
      camera.updateProjectionMatrix();
      updateHelpers();
      el('view-label').textContent = language === 'zh-CN' ? '保留视角' : 'Preserved view';
      requestRender();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ++pending;
      cancelDecode();
      comparison.dispose();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
}
