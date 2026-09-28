import type { ClayCommand, LevelDef } from '../types';
import { buildStart } from './startShapes';

const RIM = 2; // 最外 2 格固定為 0（海岸線）
const UNDO_LIMIT = 20;

interface Snapshot {
  h: Float32Array;
  budget: number;
}

/**
 * 2.5D 黏土：n×n 高度圖，高度 0–1 對應 0–maxElevation 公尺。
 * 體積以「整塊底板的平均高度」計，所以 sum(h) / n² 就是黏土量。
 */
export class ClayModel {
  readonly n: number;
  h: Float32Array;
  budget = 0;
  budgetMax = 0;
  conserve = false;
  mask: Uint8Array;
  version = 0; // 每次變形 +1，讓渲染知道要更新
  private undoStack: Snapshot[] = [];
  private pending = false;
  private tmp: Float32Array;

  constructor(n = 128) {
    this.n = n;
    this.h = new Float32Array(n * n);
    this.tmp = new Float32Array(n * n);
    this.mask = new Uint8Array(n * n);
  }

  reset(level: LevelDef, maxElevation: number): void {
    this.h = buildStart(level.start, this.n, maxElevation);
    this.budget = this.budgetMax = level.budget;
    this.conserve = level.conserveVolume;
    this.undoStack = [];
    this.pending = false;
    this.clearMask();
    this.version++;
  }

  clearMask(): void {
    this.mask.fill(0);
    this.version++;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 回傳 true 表示有變形。drop 在罐子空了時回傳 false。 */
  apply(cmd: ClayCommand): boolean {
    if (cmd.kind === 'commit') {
      this.pending = false;
      return false;
    }
    if (cmd.kind === 'drop' && this.budget <= 1e-6) return false;
    this.beginEdit();
    switch (cmd.kind) {
      case 'raise':
        this.raise(cmd.u, cmd.v, cmd.radius, cmd.amount);
        break;
      case 'press':
        this.press(cmd.u, cmd.v, cmd.radius, cmd.amount);
        break;
      case 'smooth':
        this.smooth(cmd.u, cmd.v, cmd.radius, cmd.strength);
        break;
      case 'drop':
        this.drop(cmd.u, cmd.v, cmd.radius, cmd.volume);
        this.pending = false; // 放一團黏土就是一步
        break;
    }
    if (this.mask.some((m) => m)) this.mask.fill(0);
    this.version++;
    return true;
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.h = s.h;
    this.budget = s.budget;
    this.pending = false;
    this.mask.fill(0);
    this.version++;
    return true;
  }

  heightAt(u: number, v: number): number {
    const n = this.n;
    const x = Math.min(n - 1, Math.max(0, u * (n - 1)));
    const y = Math.min(n - 1, Math.max(0, v * (n - 1)));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const h = this.h;
    const a = h[y0 * n + x0] * (1 - fx) + h[y0 * n + x1] * fx;
    const b = h[y1 * n + x0] * (1 - fx) + h[y1 * n + x1] * fx;
    return a * (1 - fy) + b * fy;
  }

  /** 平均高度（黏土總量）。 */
  volume(): number {
    let s = 0;
    for (let i = 0; i < this.h.length; i++) s += this.h[i];
    return s / this.h.length;
  }

  private beginEdit(): void {
    if (this.pending) return;
    this.undoStack.push({ h: this.h.slice(), budget: this.budget });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.pending = true;
  }

  /** 走訪半徑 reach 內的格子；w = 以 r/2 為 sigma 的高斯權重。 */
  private each(u: number, v: number, r: number, reach: number, fn: (i: number, w: number, d: number) => void): void {
    const n = this.n;
    const x0 = Math.max(RIM, Math.floor((u - reach) * (n - 1)));
    const x1 = Math.min(n - 1 - RIM, Math.ceil((u + reach) * (n - 1)));
    const y0 = Math.max(RIM, Math.floor((v - reach) * (n - 1)));
    const y1 = Math.min(n - 1 - RIM, Math.ceil((v + reach) * (n - 1)));
    const sigma = r / 2;
    const inv = 1 / (2 * sigma * sigma);
    for (let y = y0; y <= y1; y++) {
      const dv = y / (n - 1) - v;
      for (let x = x0; x <= x1; x++) {
        const du = x / (n - 1) - u;
        const d2 = du * du + dv * dv;
        if (d2 > reach * reach) continue;
        fn(y * n + x, Math.exp(-d2 * inv), Math.sqrt(d2));
      }
    }
  }

  private raise(u: number, v: number, r: number, amount: number): void {
    let added = 0;
    const h = this.h;
    this.each(u, v, r, r * 1.5, (i, w) => {
      const before = h[i];
      h[i] = Math.min(1, before + amount * w);
      added += h[i] - before;
    });
    if (this.conserve) this.moveRing(u, v, r, -added);
  }

  /** 手掌壓：先壓最高的地方，所以會壓出平面。 */
  private press(u: number, v: number, r: number, amount: number): void {
    const h = this.h;
    let top = 0;
    this.each(u, v, r, r, (i, w) => {
      if (w > 0.3 && h[i] > top) top = h[i];
    });
    const level = Math.max(0, top - amount);
    let removed = 0;
    this.each(u, v, r, r * 1.5, (i, w) => {
      if (h[i] > level) {
        const d = (h[i] - level) * Math.min(1, w * 1.4);
        h[i] -= d;
        removed += d;
      }
    });
    if (this.conserve) this.moveRing(u, v, r, removed);
  }

  private smooth(u: number, v: number, r: number, strength: number): void {
    const n = this.n;
    const h = this.h;
    const t = this.tmp;
    const idx: number[] = [];
    const ws: number[] = [];
    this.each(u, v, r, r * 1.5, (i, w) => {
      idx.push(i);
      ws.push(w);
    });
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const avg = (h[i - 1] + h[i + 1] + h[i - n] + h[i + n] + h[i - n - 1] + h[i - n + 1] + h[i + n - 1] + h[i + n + 1]) / 8;
        t[i] = h[i] + Math.min(1, strength * ws[k]) * (avg - h[i]);
      }
      for (const i of idx) h[i] = t[i];
    }
  }

  private drop(u: number, v: number, r: number, volume: number): void {
    const vol = Math.min(volume, this.budget);
    const h = this.h;
    const idx: number[] = [];
    const ws: number[] = [];
    this.each(u, v, r, r * 1.6, (i, w) => {
      idx.push(i);
      ws.push(w);
    });
    const sumW = ws.reduce((a, b) => a + b, 0);
    if (!sumW) return;
    // 依實際網格正規化，讓放下去的量剛好等於從罐子扣掉的量
    const amp = (vol * h.length) / sumW;
    let added = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const before = h[i];
      h[i] = Math.min(1, before + amp * ws[k]);
      added += h[i] - before;
    }
    this.budget = Math.max(0, this.budget - added / h.length);
    if (this.budget < 1e-6) this.budget = 0;
  }

  /** 總量守恆：把 delta（格子高度總和）平均加到筆刷外圍一圈（r 到 1.6r）。 */
  private moveRing(u: number, v: number, r: number, delta: number): void {
    if (Math.abs(delta) < 1e-9) return;
    const h = this.h;
    const ring: number[] = [];
    this.each(u, v, r, r * 1.6, (i, _w, d) => {
      if (d > r) ring.push(i);
    });
    if (!ring.length) return;
    const per = delta / ring.length;
    for (const i of ring) h[i] = Math.min(1, Math.max(0, h[i] + per));
  }
}
