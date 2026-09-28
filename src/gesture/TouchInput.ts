import type { ClayCommand, Pt } from '../types';
import { G, type GestureEnv, type GestureEvent } from './GestureRecognizer';

export type Tool = 'raise' | 'press' | 'smooth' | 'drop' | 'rotate';

export interface ViewControl {
  /** 度；immediate = 直接跟手，不做平滑 */
  rotateBy(dAz: number, dTilt: number, immediate?: boolean): void;
  zoomBy(f: number): void;
}

type Mode = 'none' | 'orbit' | 'sculpt' | 'carry' | 'multi';

const MAX_SPIN = 300; // 慣性最快每秒 300°
const INERTIA_DECAY = 6; // 越大停得越快；放開後最多再轉約 MAX_SPIN / INERTIA_DECAY = 50°

/**
 * 手指操作（像一般 3D 軟體）：
 * - 在土盤「外面」拖曳：自由旋轉整個畫面，放開後會順勢轉一下
 * - 在黏土上：用目前的工具捏（「轉動」工具則在哪裡拖都是旋轉）
 * - 從黏土罐拖到土盤上放開：放一團黏土；「放黏土」工具也可以直接點土盤
 * - 兩根手指：拖曳旋轉、張開 / 合起縮放
 * - 滑鼠：右鍵拖曳旋轉、滾輪縮放
 */
export class TouchInput {
  tool: Tool = 'drop';
  pos: Pt | null = null; // 捏黏土或拿著黏土時手指的位置（畫游標用）
  carrying = false;
  private mode: Mode = 'none';
  private pointers = new Map<number, Pt>();
  private mainId: number | null = null;
  private queue: ClayCommand[] = [];
  private events: GestureEvent[] = [];
  private vel = { az: 0, tilt: 0 }; // 放開後的慣性（度 / 秒）
  private lastMove = 0;

  constructor(
    private el: HTMLElement,
    private env: GestureEnv,
    private view: ViewControl,
  ) {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.view.zoomBy(Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e, false));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
  }

  /** 事件座標換成土盤區域內的座標（畫布不一定鋪滿整個視窗）。 */
  private local(e: PointerEvent): Pt {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** 暫停（例如時間到、對話框開著）：結束進行中的動作。 */
  cancel(): void {
    this.finish(true);
    this.pointers.clear();
    this.mode = 'none';
    this.vel = { az: 0, tilt: 0 };
  }

  get active(): boolean {
    return this.pointers.size > 0;
  }

  /** 旋轉靈敏度：拖過整個螢幕高度 ≈ 轉 300°。 */
  private get degPerPx(): number {
    return 300 / Math.max(300, this.el.clientHeight);
  }

  private down(e: PointerEvent): void {
    // 新的一次觸控：清掉可能沒收到「放開」的舊手指，避免卡在兩指模式
    if (e.isPrimary) {
      this.finish(true);
      this.pointers.clear();
    }
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* 抓不到也不影響操作 */
    }
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.vel = { az: 0, tilt: 0 };
    this.lastMove = performance.now();

    if (this.pointers.size >= 2) {
      this.finish(true); // 第二根手指放上來：取消捏到一半的動作，改成轉視角
      this.mode = 'multi';
      return;
    }
    this.mainId = e.pointerId;
    if (e.button === 2 || this.tool === 'rotate') {
      this.mode = 'orbit';
      return;
    }
    if (this.env.jarAt(p)) {
      if (this.env.hasClay()) {
        this.mode = 'carry';
        this.carrying = true;
        this.pos = p;
        this.events.push('grab');
      } else {
        this.mode = 'none';
        this.events.push('empty');
      }
      return;
    }
    const uv = this.env.toUV(p);
    if (!uv) {
      this.mode = 'orbit';
      return;
    }
    if (this.tool === 'drop') {
      this.mode = 'none';
      if (!this.env.hasClay()) {
        this.events.push('empty');
        return;
      }
      this.queue.push({ kind: 'drop', u: uv.u, v: uv.v, radius: G.dropRadius, volume: G.dropVolume });
      this.events.push('drop');
      return;
    }
    this.mode = 'sculpt';
    this.pos = p;
  }

  private move(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const k = this.degPerPx;

    if (this.mode === 'multi' && this.pointers.size >= 2) {
      const o = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - o.x, prev.y - o.y);
      const after = Math.hypot(p.x - o.x, p.y - o.y);
      this.orbit((dx / 2) * k, (dy / 2) * k);
      if (before > 20) this.view.zoomBy(after / before);
    } else if (this.mode === 'orbit' && e.pointerId === this.mainId) {
      this.orbit(dx * k, dy * k);
    } else if ((this.mode === 'sculpt' || this.mode === 'carry') && e.pointerId === this.mainId) {
      this.pos = p;
    }
    this.pointers.set(e.pointerId, p);
  }

  /** 往右拖 = 土盤跟著手往右轉；往下拖 = 從更上方看。 */
  private orbit(dAz: number, dTilt: number): void {
    const now = performance.now();
    const dt = Math.max(8, now - this.lastMove) / 1000;
    this.lastMove = now;
    this.view.rotateBy(-dAz, dTilt, true);
    // 平滑估計速度，放開時拿來做慣性
    const cap = (v: number) => Math.max(-MAX_SPIN, Math.min(MAX_SPIN, v));
    this.vel.az = cap(this.vel.az * 0.6 + (-dAz / dt) * 0.4);
    this.vel.tilt = cap(this.vel.tilt * 0.6 + (dTilt / dt) * 0.4);
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (e.pointerId === this.mainId) {
      if (this.mode === 'carry' && !cancelled) {
        const uv = this.env.toUV(this.local(e));
        if (uv) {
          this.queue.push({ kind: 'drop', u: uv.u, v: uv.v, radius: G.dropRadius, volume: G.dropVolume });
          this.events.push('drop');
        } else this.events.push('cancel');
      }
      // 停住很久才放開就不要慣性
      if (this.mode === 'orbit' && performance.now() - this.lastMove > 80) this.vel = { az: 0, tilt: 0 };
      this.finish(false);
    }
    if (this.pointers.size === 0) {
      if (this.mode === 'multi') this.vel = { az: 0, tilt: 0 };
      this.mode = 'none';
    }
  }

  /** 結束目前的單指動作。 */
  private finish(cancelCarry: boolean): void {
    if (this.mode === 'sculpt') this.queue.push({ kind: 'commit' });
    if (this.mode === 'carry' && cancelCarry) this.events.push('cancel');
    this.mainId = null;
    this.pos = null;
    this.carrying = false;
    if (this.mode !== 'orbit') this.mode = 'none';
  }

  update(dt: number): { commands: ClayCommand[]; events: GestureEvent[] } {
    const commands = this.queue;
    const events = this.events;
    this.queue = [];
    this.events = [];

    if (this.mode === 'sculpt' && this.pos) {
      const uv = this.env.toUV(this.pos);
      if (uv) {
        if (this.tool === 'raise')
          commands.push({ kind: 'raise', u: uv.u, v: uv.v, radius: 0.06, amount: G.touchRaiseRate * dt });
        else if (this.tool === 'press')
          commands.push({ kind: 'press', u: uv.u, v: uv.v, radius: G.palmRadius, amount: G.pressRate * dt });
        else if (this.tool === 'smooth')
          commands.push({ kind: 'smooth', u: uv.u, v: uv.v, radius: G.smoothRadius, strength: G.smoothStrength });
      }
    }

    // 慣性：放開後順勢再轉一下，慢慢停下來
    if (this.pointers.size === 0 && (Math.abs(this.vel.az) > 1 || Math.abs(this.vel.tilt) > 1)) {
      this.view.rotateBy(this.vel.az * dt, this.vel.tilt * dt, true);
      const decay = Math.exp(-dt * INERTIA_DECAY);
      this.vel.az *= decay;
      this.vel.tilt *= decay;
    }
    return { commands, events };
  }
}
