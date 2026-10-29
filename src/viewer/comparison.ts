import * as THREE from 'three';
import { alignModels, evaluateModels, identityTransform } from '../compare/index';
import type { CompareModel, ComparisonReport, RigidTransform } from '../compare/types';
import type { ModelSource } from '../shared/types';

type Renderable = THREE.Mesh | THREE.Points | THREE.LineSegments;
interface Entry {
  id: string;
  source: ModelSource;
  object: THREE.Object3D;
  model: CompareModel;
  color: string;
  visible: boolean;
  opacity: number;
  transform: RigidTransform;
  scale: number;
  method: 'none' | 'manual' | 'rigid-icp';
}
const palette = ['#75dfc4', '#f6b76e', '#ac9bff', '#71bdff', '#ef91b4', '#e0dc82'];
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class ComparisonSession {
  readonly group = new THREE.Group();
  readonly entries: Entry[] = [];
  mode = 'overlay';
  reference = '';
  target = '';
  private serial = 0;
  private abort?: AbortController;
  private reports: ComparisonReport[] = [];
  private heatmap?: THREE.Points;
  private language: 'en' | 'zh-CN';
  private panel: HTMLElement;
  constructor(
    private root: HTMLElement,
    language: 'en' | 'zh-CN',
    private changed: (fit?: boolean) => void,
    private disposeObject: (object: THREE.Object3D) => void,
    private addFiles: () => void,
  ) {
    this.language = language;
    this.panel = document.createElement('section');
    this.panel.className = 'md-comparison';
    this.panel.dataset.role = 'comparison';
    root.querySelector('[data-role="inspector"]')!.children[0].after(this.panel);
    this.render();
    this.panel.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-compare-action]');
      if (!b) return;
      const a = b.dataset.compareAction!;
      if (a === 'add') this.addFiles();
      else if (a === 'align') void this.run('align');
      else if (a === 'compare') void this.run('compare');
      else if (a === 'all') void this.run('all');
      else if (a === 'cancel') this.abort?.abort();
      else if (a === 'reset') this.reset();
      else if (a === 'manual') this.manual();
      else if (a === 'json' || a === 'csv') this.download(a);
      else if (a === 'remove') this.remove(b.dataset.id!);
    });
    this.panel.addEventListener('change', (e) => {
      const n = e.target as HTMLInputElement;
      const entry = this.entries.find((x) => x.id === n.dataset.id);
      if (n.dataset.field === 'reference') {
        this.reference = n.value;
        if (this.target === this.reference)
          this.target = this.entries.find((x) => x.id !== this.reference)?.id ?? '';
        this.invalidate();
        this.render();
        this.changed();
      } else if (n.dataset.field === 'target') {
        this.target = n.value;
        this.invalidate();
        this.changed();
      } else if (n.dataset.field === 'threshold') {
        this.invalidate();
        this.changed();
      } else if (n.dataset.field === 'mode') {
        this.mode = n.value;
        this.root.dataset.compareMode = this.mode;
        this.changed(true);
      } else if (entry) {
        if (n.dataset.field === 'visible') entry.visible = n.checked;
        else if (n.dataset.field === 'opacity') entry.opacity = Number(n.value);
        else if (n.dataset.field === 'unit') {
          entry.model.unit = n.value;
          entry.model.units = n.value;
          this.invalidate();
        }
        this.applyVisibility();
        this.changed();
      }
    });
  }
  setLanguage(language: 'en' | 'zh-CN') {
    this.language = language;
    this.render();
  }
  private text(en: string, zh: string) {
    return this.language === 'en' ? en : zh;
  }
  install(
    object: THREE.Object3D,
    source: ModelSource,
    unit: string,
    origin: [number, number, number] = [0, 0, 0],
    preview?: object,
    add = false,
    preserve = false,
  ) {
    this.abort?.abort();
    const incomingBytes = (() => {
      let total = 0;
      object.traverse((n) => {
        const geometry = (n as Renderable).geometry;
        if (geometry) {
          for (const attribute of Object.values(geometry.attributes))
            total += attribute.array.byteLength;
          total += geometry.index?.array.byteLength ?? 0;
        }
      });
      return total;
    })();
    if (
      add &&
      (this.entries.length >= 16 ||
        incomingBytes +
          this.entries.reduce(
            (total, e) =>
              total +
              e.model.primitives.reduce(
                (sum, p) => sum + p.positions.byteLength + (p.indices?.byteLength ?? 0),
                0,
              ),
            0,
          ) >
          512 * 1024 * 1024)
    ) {
      this.disposeObject(object);
      throw new Error(
        this.text(
          'Comparison session memory budget reached (16 models / 512 MiB geometry). Remove a model before adding another.',
          '已达到比较会话上限（16 个模型 / 512 MiB 几何）。请先移除模型。',
        ),
      );
    }
    this.invalidate();
    const existing = preserve ? this.entries.find((e) => e.source.name === source.name) : undefined;
    if (!add && !preserve) {
      for (const entry of this.entries) {
        this.group.remove(entry.object);
        this.disposeObject(entry.object);
      }
      this.entries.length = 0;
      this.reference = '';
      this.target = '';
    }
    const id = existing?.id ?? `model-${++this.serial}`;
    // Bake only each primitive's own hierarchy. The shared display anchor is excluded.
    object.updateMatrixWorld(true);
    const primitives: CompareModel['primitives'] = [];
    object.traverse((n) => {
      const mesh = n as Renderable;
      const p = mesh.geometry?.getAttribute('position');
      if (!p || mesh.userData.displayOverlay) return;
      let positions: Float32Array | Float64Array;
      if (n.matrixWorld.equals(new THREE.Matrix4()) && p.array instanceof Float32Array)
        positions = p.array;
      else {
        positions = new Float64Array(p.count * 3);
        const v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(n.matrixWorld);
          positions.set(v.toArray(), i * 3);
        }
      }
      primitives.push({
        positions,
        indices: mesh.geometry.index ? Uint32Array.from(mesh.geometry.index.array) : undefined,
        mode: (mesh as THREE.Points).isPoints
          ? 'points'
          : (mesh as THREE.LineSegments).isLineSegments
            ? 'lines'
            : 'triangles',
      });
    });
    const wrapper = new THREE.Group();
    wrapper.position.fromArray(origin);
    wrapper.add(object);
    wrapper.name = source.name;
    const entry: Entry = {
      id,
      source,
      object: wrapper,
      model: {
        id,
        name: source.name,
        unit: existing?.model.unit ?? unit,
        units: existing?.model.units ?? unit,
        origin,
        primitives,
        preview,
      },
      color: existing?.color ?? palette[this.entries.length % palette.length],
      visible: existing?.visible ?? true,
      opacity: existing?.opacity ?? 1,
      transform: existing?.transform ?? identityTransform(),
      scale: existing?.scale ?? 1,
      method: existing?.method ?? 'none',
    };
    if (existing) {
      const index = this.entries.indexOf(existing);
      this.group.remove(existing.object);
      this.disposeObject(existing.object);
      this.entries[index] = entry;
    } else this.entries.push(entry);
    this.group.add(wrapper);
    this.applyTransform(entry);
    if (!this.reference) this.reference = id;
    if (this.entries.length > 1 && (!this.target || this.target === this.reference))
      this.target = id;
    this.root.dataset.modelCount = String(this.entries.length);
    this.render();
    this.applyVisibility();
  }
  private transformedModel(e: Entry): CompareModel {
    if (e.scale === 1) return e.model;
    return {
      ...e.model,
      origin: e.model.origin?.map((n) => n * e.scale) as [number, number, number],
      primitives: e.model.primitives.map((p) => ({
        ...p,
        positions: Float64Array.from(p.positions, (n) => n * e.scale),
      })),
    };
  }
  private applyTransform(e: Entry) {
    const r = e.transform.rotation,
      t = e.transform.translation;
    const o = e.model.origin ?? [0, 0, 0];
    const origin = new THREE.Vector3(...o).multiplyScalar(e.scale);
    const m = new THREE.Matrix4().set(
      r[0],
      r[1],
      r[2],
      t[0],
      r[3],
      r[4],
      r[5],
      t[1],
      r[6],
      r[7],
      r[8],
      t[2],
      0,
      0,
      0,
      1,
    );
    m.multiply(new THREE.Matrix4().makeTranslation(...origin.toArray())).multiply(
      new THREE.Matrix4().makeScale(e.scale, e.scale, e.scale),
    );
    e.object.matrixAutoUpdate = false;
    e.object.matrix.copy(m);
    e.object.updateMatrixWorld(true);
  }
  applyVisibility(pass?: 'source' | 'reference') {
    for (const e of this.entries) {
      e.object.visible =
        e.visible && (!pass || e.id === (pass === 'source' ? this.target : this.reference));
      e.object.traverse((n) => {
        const obj = n as Renderable;
        if (!obj.material) return;
        for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          const data = material.userData;
          data.sessionOpacity ??= material.opacity;
          data.sessionTransparent ??= material.transparent;
          material.opacity = data.sessionOpacity * e.opacity;
          material.transparent = data.sessionTransparent || e.opacity < 1;
          material.depthWrite = e.opacity >= 1;
          if (this.entries.length > 1 && 'color' in material) {
            const colored = material as THREE.MeshStandardMaterial;
            data.sessionColor ??= colored.color.getHex();
            colored.color.set(e.color);
          } else if (data.sessionColor !== undefined && 'color' in material)
            (material as THREE.MeshStandardMaterial).color.setHex(data.sessionColor);
        }
      });
    }
    if (this.heatmap) this.heatmap.visible = !pass || pass === 'source';
  }
  private invalidate() {
    this.abort?.abort();
    this.reports = [];
    const legend = this.panel.querySelector<HTMLElement>('[data-role="deviation-legend"]');
    if (legend) legend.hidden = true;
    this.root.dataset.comparisonState = 'stale';
    if (this.heatmap) {
      this.group.remove(this.heatmap);
      this.disposeObject(this.heatmap);
      this.heatmap = undefined;
    }
    const output = this.panel.querySelector('[data-role="comparison-result"]');
    if (output)
      output.textContent = this.text(
        'Run Compare after changing models or transforms.',
        '模型或变换更新后，请重新评估。',
      );
    this.panel
      .querySelectorAll<HTMLButtonElement>(
        '[data-compare-action="json"],[data-compare-action="csv"]',
      )
      .forEach((b) => (b.disabled = true));
  }
  private remove(id: string) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.abort?.abort();
    const [e] = this.entries.splice(i, 1);
    this.group.remove(e.object);
    this.disposeObject(e.object);
    if (this.reference === id) this.reference = this.entries[0]?.id ?? '';
    if (this.target === id)
      this.target = this.entries.find((e) => e.id !== this.reference)?.id ?? '';
    this.invalidate();
    this.root.dataset.modelCount = String(this.entries.length);
    this.render();
    this.changed(true);
  }
  private reset() {
    const e = this.entries.find((e) => e.id === this.target);
    if (!e) return;
    e.transform = identityTransform();
    e.scale = 1;
    e.method = 'none';
    this.applyTransform(e);
    this.invalidate();
    this.changed(true);
    this.render();
  }
  private manual() {
    const e = this.entries.find((e) => e.id === this.target);
    if (!e) return;
    try {
      const values = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'scale'].map((f) =>
        Number((this.panel.querySelector(`[data-manual="${f}"]`) as HTMLInputElement).value),
      );
      if (values.some((n) => !Number.isFinite(n)) || values[6] <= 0)
        throw Error(
          this.text('Enter finite values and a positive scale.', '请输入有效数字及正比例。'),
        );
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          ...(values.slice(3, 6).map((n) => (n * Math.PI) / 180) as [number, number, number]),
        ),
      );
      const a = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
      e.transform = {
        rotation: [a[0], a[4], a[8], a[1], a[5], a[9], a[2], a[6], a[10]],
        translation: values.slice(0, 3) as [number, number, number],
      };
      e.scale = values[6];
      e.method = 'manual';
      this.applyTransform(e);
      this.invalidate();
      this.changed(true);
      this.notice(
        this.text(
          'Absolute manual transform applied. Explicit scale is recorded in exports.',
          '已应用绝对手动变换；显式缩放会记入报告。',
        ),
      );
    } catch (error) {
      this.notice(String(error));
    }
  }
  private notice(message: string) {
    this.panel.querySelector('[data-role="comparison-result"]')!.textContent = message;
  }
  private async run(kind: 'align' | 'compare' | 'all') {
    const reference = this.entries.find((e) => e.id === this.reference),
      target = this.entries.find((e) => e.id === this.target);
    if (!reference || !target || reference === target) return;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const button = this.panel.querySelector<HTMLButtonElement>('[data-compare-action="cancel"]')!;
    button.hidden = false;
    this.panel
      .querySelectorAll<HTMLButtonElement>(
        '[data-compare-action="align"],[data-compare-action="compare"],[data-compare-action="all"]',
      )
      .forEach((b) => (b.disabled = true));
    this.root.dataset.comparisonState = 'running';
    try {
      const unknown = (u?: string) =>
        !u || ['model units', 'unknown', 'unspecified'].includes(u.toLowerCase());
      const targets = kind === 'all' ? this.entries.filter((e) => e !== reference) : [target];
      for (const e of targets)
        if (
          unknown(e.model.unit) ||
          unknown(reference.model.unit) ||
          e.model.unit !== reference.model.unit
        )
          throw Error(
            this.text(
              'Choose the same known coordinate unit for target and reference. Changing the unit label does not rescale coordinates; use explicit scale for conversion.',
              '请为目标和基准选择相同的已知坐标单位。单位标签不会改变坐标；换算请显式缩放。',
            ),
          );
      const referenceModel = this.bakedReference(reference);
      const onProgress = (p: { stage: string; completed: number; total: number }) =>
        this.notice(`${p.stage} · ${p.completed.toLocaleString()} / ${p.total.toLocaleString()}`);
      if (kind === 'align') {
        const result = await alignModels(this.transformedModel(target), referenceModel, {
          signal: abort.signal,
          sampleBudget: 5000,
          initialTransform: target.transform,
          onProgress,
        });
        if (abort.signal.aborted) return;
        target.transform = result.transform;
        target.method = 'rigid-icp';
        this.applyTransform(target);
        this.invalidate();
        this.changed(true);
        this.root.dataset.comparisonState = 'aligned';
        this.notice(
          `${this.text('Rigid ICP', '刚性 ICP')} · ${this.text(result.converged ? 'converged' : 'stopped; review alignment', result.converged ? '已收敛' : '已停止，请检查配准')} · RMSE ${this.number(result.initialRmse)} → ${this.number(result.finalRmse)} ${target.model.unit}\n${result.diagnostics.join(' ')}`,
        );
      } else {
        const threshold = Number(
          (this.panel.querySelector('[data-field="threshold"]') as HTMLInputElement).value,
        );
        if (!(threshold > 0 && Number.isFinite(threshold)))
          throw Error(
            this.text('Threshold must be a positive finite distance.', '阈值须为有效正数。'),
          );
        const reports: ComparisonReport[] = [];
        for (const e of targets) {
          reports.push(
            await evaluateModels(this.transformedModel(e), referenceModel, {
              threshold,
              unit: e.model.unit,
              sampleBudget: 10000,
              sourceTransform: e.transform,
              alignment: e.method,
              includeDistances: true,
              signal: abort.signal,
              onProgress,
            }),
          );
        }
        if (abort.signal.aborted) return;
        this.reports = reports;
        this.showResults();
        this.drawHeatmap(reports.find((r) => r.source.id === this.target) ?? reports[0]);
        this.root.dataset.comparisonState = 'ready';
        this.panel
          .querySelectorAll<HTMLButtonElement>(
            '[data-compare-action="json"],[data-compare-action="csv"]',
          )
          .forEach((b) => (b.disabled = false));
        this.changed();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.notice(error instanceof Error ? error.message : String(error));
        this.root.dataset.comparisonState = 'error';
      } else this.notice(this.text('Comparison cancelled.', '比较已取消。'));
    } finally {
      if (this.abort === abort) {
        button.hidden = true;
        this.panel
          .querySelectorAll<HTMLButtonElement>(
            '[data-compare-action="align"],[data-compare-action="compare"],[data-compare-action="all"]',
          )
          .forEach((b) => (b.disabled = this.entries.length < 2));
      }
    }
  }
  private bakedReference(e: Entry): CompareModel {
    const model = this.transformedModel(e);
    const m = e.transform;
    const r = m.rotation,
      t = m.translation,
      o = model.origin ?? [0, 0, 0];
    return {
      ...model,
      origin: [0, 0, 0],
      primitives: model.primitives.map((p) => ({
        ...p,
        positions: Float64Array.from(p.positions, (_, i) => {
          const k = i - (i % 3);
          const x = p.positions[k] + o[0],
            y = p.positions[k + 1] + o[1],
            z = p.positions[k + 2] + o[2];
          const row = i % 3;
          return r[row * 3] * x + r[row * 3 + 1] * y + r[row * 3 + 2] * z + t[row];
        }),
      })),
    };
  }
  private number(n: number) {
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumSignificantDigits: 5 }) : '—';
  }
  private showResults() {
    this.notice(
      this.reports
        .map(
          (r) =>
            `${r.source.name} → ${r.reference.name}\n${this.text('Approximate sampled metrics', '采样近似指标')} (${r.unit})\nRMSE ${this.number(r.accuracy.rmse)} · P95 ${this.number(r.accuracy.p95)} · max* ${this.number(r.accuracy.approximateMax)}\nChamfer ${this.number(r.chamfer.value)} · F-score ${(r.fScore * 100).toFixed(1)}%\n${this.text('Precision / recall', '精确率 / 召回率')} ${(r.precision * 100).toFixed(1)}% / ${(r.recall * 100).toFixed(1)}%\n${this.text('Samples', '采样数')} ${r.accuracy.count} / ${r.completeness.count} · ${r.source.sampling.targetMethod}\n${r.warnings.join('\n')}`,
        )
        .join('\n\n'),
    );
  }
  private drawHeatmap(report: ComparisonReport) {
    if (this.heatmap) {
      this.group.remove(this.heatmap);
      this.disposeObject(this.heatmap);
    }
    if (!report.distances) return;
    const points = report.distances.sourcePoints,
      distances = report.distances.sourceToReference,
      anchor = new THREE.Vector3(points[0] ?? 0, points[1] ?? 0, points[2] ?? 0),
      positions = Float32Array.from(points, (value, i) => value - anchor.getComponent(i % 3)),
      colors = new Float32Array(points.length);
    const c = new THREE.Color();
    for (let i = 0; i < distances.length; i++) {
      c.setHSL((1 - Math.min(1, distances[i] / report.threshold)) * 0.55, 0.85, 0.58);
      colors.set(c.toArray(), i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.heatmap = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        vertexColors: true,
        size: 5,
        sizeAttenuation: false,
        depthTest: false,
      }),
    );
    this.heatmap.position.copy(anchor);
    this.heatmap.renderOrder = 10;
    this.group.add(this.heatmap);
    const legend = this.panel.querySelector<HTMLElement>('[data-role="deviation-legend"]')!;
    legend.hidden = false;
    legend.textContent = `${this.text('Sample deviation', '采样偏差')}: 0 → ≥ ${this.number(report.threshold)} ${report.unit}`;
  }
  private download(format: 'json' | 'csv') {
    if (!this.reports.length) return;
    const entries = this.entries.map((e) => ({
      id: e.id,
      name: e.source.name,
      unit: e.model.unit,
      explicitScale: e.scale,
      transform: e.transform,
      preview: e.model.preview,
    }));
    let data: string;
    if (format === 'json')
      data = JSON.stringify(
        { schema: 'modeldock.session.v1', models: entries, comparisons: this.reports },
        null,
        2,
      );
    else {
      const quote = (v: unknown) =>
        `"${(typeof v === 'string' && /^[=+@-]/.test(v) ? "'" + v : String(v ?? '')).replace(/"/g, '""')}"`;
      const headers = [
        'source',
        'reference',
        'unit',
        'threshold',
        'rmse',
        'p95',
        'approximate_max',
        'chamfer',
        'precision',
        'recall',
        'f_score',
        'source_samples',
        'reference_samples',
        'alignment',
        'explicit_scale',
        'rotation_row_major',
        'translation',
        'sampling',
        'reference_explicit_scale',
        'reference_transform',
        'source_origin',
        'reference_origin',
      ];
      data = [
        headers,
        ...this.reports.map((r) => [
          r.source.name,
          r.reference.name,
          r.unit,
          r.threshold,
          r.accuracy.rmse,
          r.accuracy.p95,
          r.accuracy.approximateMax,
          r.chamfer.value,
          r.precision,
          r.recall,
          r.fScore,
          r.accuracy.count,
          r.completeness.count,
          r.alignment.method,
          this.entries.find((e) => e.id === r.source.id)?.scale,
          JSON.stringify(r.alignment.transform.rotation),
          JSON.stringify(r.alignment.transform.translation),
          JSON.stringify({
            source: r.source.sampling,
            reference: r.reference.sampling,
            seed: r.seed,
            budget: r.sampleBudget,
          }),
          this.entries.find((e) => e.id === r.reference.id)?.scale,
          JSON.stringify(this.entries.find((e) => e.id === r.reference.id)?.transform),
          JSON.stringify(this.entries.find((e) => e.id === r.source.id)?.model.origin),
          JSON.stringify(this.entries.find((e) => e.id === r.reference.id)?.model.origin),
        ]),
      ]
        .map((row) => row.map(quote).join(','))
        .join('\r\n');
    }
    const url = URL.createObjectURL(
      new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `modeldock-comparison.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private previewLabel(entry: Entry): string {
    const p = entry.model.preview as Record<string, unknown> | undefined;
    if (!p) return this.text('Source coordinates preserved', '保留源坐标');
    const count = (key: string) => Number(p[key] ?? 0).toLocaleString();
    return `${this.text('Sampled preview', '采样预览')}: ${count('sampledVertices')} / ${count('originalVertices')} ${this.text('vertices', '顶点')}${p.topologyOmitted ? ' · ' + this.text('surface omitted; point-only', '已省略曲面，仅显示点') : ''}`;
  }
  private render() {
    const threshold =
      (this.panel.querySelector('[data-field="threshold"]') as HTMLInputElement | null)?.value ??
      '0.1';
    const t = (en: string, zh: string) => this.text(en, zh),
      options = (selected: string) =>
        this.entries
          .map(
            (e) =>
              `<option value="${e.id}"${selected === e.id ? ' selected' : ''}>${esc(e.source.name)}</option>`,
          )
          .join('');
    this.panel.innerHTML = `<h2>${t('COMPARE MODELS', '模型比较')} <span data-role="model-count">${this.entries.length}</span></h2><p class="md-flow">${t('Add → Reference → Align → Compare', '添加 → 基准 → 配准 → 评估')}</p><button class="md-primary md-add-models" data-compare-action="add">＋ ${t('Add models', '添加模型')}</button><div class="md-model-list">${this.entries.map((e) => `<div class="md-model-row" data-model-id="${e.id}"><div class="md-model-name"><input type="checkbox" data-field="visible" data-id="${e.id}" aria-label="${esc(t('Show ', '显示 ') + e.source.name)}" ${e.visible ? 'checked' : ''}><i style="background:${e.color}"></i><span title="${esc(e.source.name)}">${esc(e.source.name)}</span><button data-compare-action="remove" data-id="${e.id}" aria-label="${esc(t('Remove ', '移除 ') + e.source.name)}">×</button></div><div class="md-model-meta"><span>${e.id === this.reference ? t('REFERENCE / GT', '基准 / 真值') : t('TARGET', '目标')}</span><label>${t('Opacity', '透明度')} <input aria-label="${esc(t('Opacity ', '透明度 ') + e.source.name)}" data-field="opacity" data-id="${e.id}" type="range" min="0.05" max="1" step="0.05" value="${e.opacity}"></label></div><select data-field="unit" data-id="${e.id}" aria-label="${esc(t('Coordinate unit ', '坐标单位 ') + e.source.name)}">${[...new Set(['model units', 'mm', 'cm', 'm', 'in', 'ft', e.model.unit ?? 'model units'])].map((u) => `<option${u === e.model.unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select><small>${esc(this.previewLabel(e))}</small></div>`).join('')}</div><div class="md-compare-fields"><label>${t('Reference / ground truth', '基准 / 真值')}<select data-field="reference" aria-label="Reference model">${options(this.reference)}</select></label><label>${t('Target', '目标')}<select data-field="target" aria-label="Target model">${options(this.target)}</select></label><label>${t('View', '视图')}<select data-field="mode" aria-label="Comparison view"><option value="overlay"${this.mode === 'overlay' ? ' selected' : ''}>${t('Overlay', '叠加')}</option><option value="split"${this.mode === 'split' ? ' selected' : ''}>${t('Side by side · synced', '并排 · 同步视角')}</option></select></label></div><p class="md-compare-note">${t('No automatic alignment. Choose coordinate units before comparing. STL can serve as ground truth.', '默认不自动配准。比较前请确认坐标单位；可选择 STL 作为真值。')}</p><div class="md-compare-buttons"><button data-compare-action="align" ${this.entries.length < 2 ? 'disabled' : ''}>${t('Rigid ICP', '刚性 ICP 配准')}</button><button data-compare-action="reset">${t('Reset transform', '重置变换')}</button></div><details><summary>${t('Manual transform / explicit scale', '手动变换 / 显式缩放')}</summary><p class="md-compare-note">${t('Absolute transform; translation uses chosen units, rotation uses degrees. ICP is local and needs a reasonable initial pose.', '绝对变换；平移采用所选单位，旋转为度。ICP 为局部配准，需要合理初始位置。')}</p><div class="md-manual-grid">${['tx', 'ty', 'tz', 'rx', 'ry', 'rz', 'scale'].map((f) => `<label>${f}<input data-manual="${f}" aria-label="${f}" type="number" step="any" value="${f === 'scale' ? '1' : '0'}"></label>`).join('')}</div><button data-compare-action="manual">${t('Apply to target', '应用至目标')}</button></details><label class="md-threshold">${t('Tolerance (chosen coordinate units)', '阈值（所选坐标单位）')}<input type="number" data-field="threshold" aria-label="Deviation threshold" min="0" step="any" value="${esc(threshold)}"></label><div class="md-compare-buttons"><button class="md-primary" data-compare-action="compare" ${this.entries.length < 2 ? 'disabled' : ''}>${t('Compare pair', '评估两模型')}</button><button data-compare-action="all" ${this.entries.length < 2 ? 'disabled' : ''}>${t('Each → reference', '全部对比基准')}</button><button data-compare-action="cancel" hidden>${t('Cancel', '取消')}</button></div><div class="md-deviation-legend" data-role="deviation-legend" hidden></div><output class="md-comparison-result" data-role="comparison-result" aria-live="polite">${t('Approximate sampled distances; results appear here.', '采样近似距离；评估结果将显示在此。')}</output><div class="md-compare-buttons"><button data-compare-action="json" disabled>↓ JSON</button><button data-compare-action="csv" disabled>↓ CSV</button></div>`;
  }
  dispose() {
    this.abort?.abort();
  }
}
