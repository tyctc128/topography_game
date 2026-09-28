import { CameraSource } from '../camera/CameraSource';
import { ClayModel } from '../clay/ClayModel';
import { GRID } from '../constants';
import { GestureRecognizer, type GestureEnv, type GestureEvent } from '../gesture/GestureRecognizer';
import { TouchInput, type Tool } from '../gesture/TouchInput';
import { judge } from '../judge/judge';
import { Overlay } from '../render/Overlay';
import { Renderer } from '../render/Renderer';
import { HandTracker } from '../tracking/HandTracker';
import type { ClayCommand, JudgeResult, Landform, LevelDef, TerrainConfig } from '../types';
import type { AudioManager } from '../game/AudioManager';
import { toast } from '../ui/dom';

export type ViewPreset = 'top' | 'side' | 'orbit';

const TRACK_INTERVAL_MS = 30;

/**
 * 3D 土盤：黏土模型＋渲染＋觸控／手勢＋黏土罐標籤。
 * 掛在一個 .playground 容器裡，練習模式與測驗的地形題共用。
 */
export class Board {
  readonly clay = new ClayModel(GRID);
  private renderer: Renderer;
  private overlay: Overlay;
  private touch: TouchInput;
  private recognizer = new GestureRecognizer();
  private tracker: HandTracker | null = null;
  private camera: CameraSource | null = null;
  private env: GestureEnv;
  private layers: HTMLElement[] = [];
  private jarLabels: HTMLElement[] = [];
  private tag1000: HTMLElement;
  private handStatus: HTMLElement;
  private video: HTMLVideoElement;
  private observer: ResizeObserver;
  private raf = 0;
  private lastT = performance.now() / 1000;
  private lastTrack = 0;
  private lastHandSeen = 0;
  private frame = 0;
  private gesturesOn = false;
  private lastNote = '';
  /** true 時不接受任何捏黏土的操作（例如時間到、送出中）。 */
  locked = false;
  /** 手指在黏土上時回報目前高度，給畫面上的小提示用。 */
  onNote: ((text: string) => void) | null = null;

  constructor(
    private host: HTMLElement,
    private cfg: TerrainConfig,
    private audio: AudioManager,
  ) {
    const gl = document.createElement('canvas');
    gl.className = 'terrain-canvas board-gl';
    const ov = document.createElement('canvas');
    ov.className = 'terrain-canvas board-overlay';
    ov.setAttribute('aria-label', '土盤：在黏土上用工具捏，在土盤外拖曳旋轉，兩指縮放');
    this.tag1000 = this.el('div', 'tag1000 hidden', '1000m');
    this.handStatus = this.el('div', 'hand-status hidden', '');
    this.video = document.createElement('video');
    this.video.className = 'board-video hidden';
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    for (let k = 0; k < 2; k++) this.jarLabels.push(this.el('div', 'jar-label', '黏土 100%'));
    // 放在 surface-texture 之後、其他介面元素之前，讓按鈕蓋在畫布上方
    const anchor = host.querySelector('.surface-texture')?.nextSibling ?? host.firstChild;
    for (const node of [gl, ov, this.tag1000, ...this.jarLabels, this.handStatus, this.video]) {
      host.insertBefore(node, anchor);
      this.layers.push(node);
    }

    this.renderer = new Renderer(gl, GRID, cfg);
    this.overlay = new Overlay(ov);
    this.env = {
      toUV: (p) => this.renderer.screenToUV(p, this.clay),
      jarAt: (p) => this.renderer.jarAt(p),
      hasClay: () => this.clay.budget > 1e-5,
      screenH: 1,
    };
    Object.defineProperty(this.env, 'screenH', { get: () => this.host.clientHeight || 1 });
    this.touch = new TouchInput(ov, this.env, this.renderer);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  private el(tag: string, cls: string, text: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = text;
    return e;
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.resize(w, h, this.insets());
    this.overlay.resize(w, h);
  }

  /** 量出土盤區域四周被工具列、標題、圖例蓋住的寬度。 */
  private insets(): { top: number; right: number; bottom: number; left: number } {
    const host = this.host.getBoundingClientRect();
    const rect = (sel: string) => this.host.querySelector(sel)?.getBoundingClientRect() ?? null;
    const top = rect('.scene-top');
    const tools = rect('.tools');
    const bottom = rect('.scene-bottom');
    const legend = rect('.altitude');
    const horizontalTools = tools ? tools.width > tools.height : false;
    const pad = 10;
    return {
      top: top ? top.bottom - host.top + pad : 0,
      bottom: Math.max(
        bottom ? host.bottom - bottom.top + pad : 0,
        horizontalTools && tools ? host.bottom - tools.top + pad : 0,
      ),
      left: !horizontalTools && tools ? tools.right - host.left + pad : pad,
      right: legend ? host.right - legend.left + pad : pad,
    };
  }

  load(level: LevelDef): void {
    this.touch.cancel();
    this.clay.reset(level, this.cfg.maxElevation);
    this.renderer.resetView();
  }

  setTool(t: Tool): void {
    this.touch.tool = t;
  }

  setView(v: ViewPreset): void {
    if (v === 'orbit') this.renderer.resetView();
    else if (v === 'top') this.renderer.setTilt(89.9);
    else this.renderer.setTilt(14);
  }

  setContours(on: boolean): void {
    this.renderer.setContours(on);
  }

  undo(): boolean {
    return this.clay.undo();
  }

  /** 判定目前的地形，並把不符合的地方標成閃紅色。 */
  check(target: Landform): JudgeResult {
    const r = judge(this.clay.h, this.clay.n, target, this.cfg);
    this.clay.mask.set(r.problemMask);
    this.clay.version++;
    return r;
  }

  clearMask(): void {
    this.clay.clearMask();
  }

  heights(): Float32Array {
    return this.clay.h.slice();
  }

  /** 開啟前鏡頭手勢模式；鏡頭畫面只顯示在土盤角落的小預覽。 */
  async enableGestures(): Promise<void> {
    if (this.gesturesOn) return;
    this.camera ??= new CameraSource(this.video);
    await this.camera.start('user');
    this.video.classList.remove('hidden');
    this.gesturesOn = true;
    if (!this.tracker) {
      this.tracker = new HandTracker();
      this.status('手部追蹤載入中…');
      try {
        await this.tracker.init();
        this.status('');
        toast('準備好了！把手舉到前鏡頭前面');
      } catch (e) {
        console.error(e);
        this.tracker = null;
        this.disableGestures();
        toast('手部追蹤載入失敗，請用手指操作');
      }
    }
  }

  disableGestures(): void {
    this.gesturesOn = false;
    this.camera?.stop();
    this.video.classList.add('hidden');
    this.status('');
  }

  get gesturesEnabled(): boolean {
    return this.gesturesOn;
  }

  private status(text: string): void {
    this.handStatus.textContent = text;
    this.handStatus.classList.toggle('hidden', !text);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.disableGestures();
    this.touch.cancel();
    this.renderer.dispose();
    for (const n of this.layers) n.remove();
  }

  // ---------- 每一幀 ----------

  private apply(commands: ClayCommand[], events: GestureEvent[]): void {
    if (this.locked) return;
    for (const c of commands) this.clay.apply(c);
    for (const e of events) {
      if (e === 'grab') this.audio.play('grab');
      else if (e === 'drop') this.audio.play('drop');
      else if (e === 'cancel') toast('把黏土拖到土盤上再放開');
      else if (e === 'empty') {
        this.audio.play('empty');
        toast('黏土罐空了！可以按「復原」拿回來');
      }
    }
  }

  private loop(now: number): void {
    this.raf = requestAnimationFrame((t) => this.loop(t));
    const t = now / 1000;
    const dt = Math.min(0.1, t - this.lastT);
    this.lastT = t;
    this.frame++;

    if (this.locked) this.touch.cancel();
    if (this.gesturesOn && this.tracker?.ready && this.camera?.active && now - this.lastTrack >= TRACK_INTERVAL_MS) {
      this.lastTrack = now;
      const raw = this.tracker.detect(this.camera.video);
      const seen = new Map<string, number>();
      const w = this.host.clientWidth;
      const h = this.host.clientHeight;
      const hands = raw.map((hand) => {
        const k = seen.get(hand.side) ?? 0;
        seen.set(hand.side, k + 1);
        return {
          key: k ? `${hand.side}${k}` : hand.side,
          points: hand.points.map((p) => this.camera!.toScreen(p.x, p.y, w, h)),
        };
      });
      if (hands.length) this.lastHandSeen = t;
      const r = this.recognizer.update(hands, t, this.env);
      this.apply(r.commands, r.events);
      if (t - this.lastHandSeen > 4 && !this.touch.active) this.status('把手舉到前鏡頭前面，看角落的小畫面');
      else if (this.handStatus.textContent !== '手部追蹤載入中…') this.status('');
    }
    const r = this.touch.update(dt);
    this.apply(r.commands, r.events);

    const fill = this.clay.budgetMax ? this.clay.budget / this.clay.budgetMax : 0;
    this.renderer.update(this.clay, t, fill);
    this.renderer.render();
    this.overlay.draw(this.gesturesOn ? this.recognizer.views : [], { pos: this.touch.pos, tool: this.touch.tool, carrying: this.touch.carrying }, false);
    if (this.frame % 6 === 0) this.updateLabels(fill);
  }

  private updateLabels(fill: number): void {
    const pct = Math.round(fill * 100);
    (['left', 'right'] as const).forEach((side, k) => {
      const el = this.jarLabels[k];
      const p = this.renderer.jarLabelPoint(side);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.textContent = `黏土 ${pct}%`;
    });

    // 手指在黏土上時，回報那裡的高度
    if (this.onNote && this.touch.pos) {
      const uv = this.env.toUV(this.touch.pos);
      const note = uv ? `目前高度約 ${Math.round((this.clay.heightAt(uv.u, uv.v) * this.cfg.maxElevation) / 10) * 10} m` : '';
      if (note && note !== this.lastNote) {
        this.lastNote = note;
        this.onNote(note);
      }
    }

    // 1000 m 標籤：放在 1000 m 等高線上離鏡頭最近的地方
    const { n, h } = this.clay;
    const target = this.cfg.contour.highlight / this.cfg.maxElevation;
    const tol = 40 / this.cfg.maxElevation;
    let best = -1;
    let bestDepth = -Infinity;
    for (let y = 2; y < n - 2; y += 2)
      for (let x = 2; x < n - 2; x += 2) {
        const i = y * n + x;
        if (Math.abs(h[i] - target) >= tol) continue;
        const p = this.renderer.boardPoint(x / (n - 1), y / (n - 1), this.clay);
        if (p.y > bestDepth) {
          bestDepth = p.y;
          best = i;
        }
      }
    if (best < 0) {
      this.tag1000.classList.add('hidden');
      return;
    }
    const p = this.renderer.boardPoint((best % n) / (n - 1), Math.floor(best / n) / (n - 1), this.clay);
    this.tag1000.style.left = `${p.x}px`;
    this.tag1000.style.top = `${p.y}px`;
    this.tag1000.classList.remove('hidden');
  }
}
