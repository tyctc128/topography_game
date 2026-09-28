import type { StartShape } from '../types';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在高度圖上加一團高斯形狀的黏土（高度以 0–1 計，sigma 以底板座標計）。 */
export function addGaussian(h: Float32Array, n: number, cu: number, cv: number, sigma: number, amp: number): void {
  const reach = sigma * 3;
  const x0 = Math.max(0, Math.floor((cu - reach) * (n - 1)));
  const x1 = Math.min(n - 1, Math.ceil((cu + reach) * (n - 1)));
  const y0 = Math.max(0, Math.floor((cv - reach) * (n - 1)));
  const y1 = Math.min(n - 1, Math.ceil((cv + reach) * (n - 1)));
  const inv = 1 / (2 * sigma * sigma);
  for (let y = y0; y <= y1; y++) {
    const dv = y / (n - 1) - cv;
    for (let x = x0; x <= x1; x++) {
      const du = x / (n - 1) - cu;
      h[y * n + x] += amp * Math.exp(-(du * du + dv * dv) * inv);
    }
  }
}

/** 底板最外圈固定為 0（海岸），往內 6 格平滑過渡。 */
export function applyCoast(h: Float32Array, n: number): void {
  const rim = 2;
  const fade = 6;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.min(x, y, n - 1 - x, n - 1 - y);
      const i = y * n + x;
      if (d < rim) h[i] = 0;
      else if (d < rim + fade) {
        const t = (d - rim) / fade;
        h[i] *= t * t * (3 - 2 * t);
      }
    }
  }
}

export function buildStart(shape: StartShape, n: number, maxElevation: number): Float32Array {
  const h = new Float32Array(n * n);
  const H = (shape.height ?? 0) / maxElevation;
  const r = shape.radius ?? 0.25;
  const rand = mulberry32(shape.seed ?? 1);

  switch (shape.type) {
    case 'flat':
      break;
    case 'bumps': {
      const count = shape.count ?? 6;
      for (let k = 0; k < count; k++) {
        const u = 0.18 + rand() * 0.64;
        const v = 0.18 + rand() * 0.64;
        addGaussian(h, n, u, v, r / 2, H * (0.6 + rand() * 0.4));
      }
      break;
    }
    case 'mound':
    case 'plateau': {
      const p = shape.type === 'plateau' ? 6 : (shape.power ?? 2);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const d = Math.hypot(x / (n - 1) - 0.5, y / (n - 1) - 0.5);
          h[y * n + x] = H * Math.exp(-Math.pow(d / r, p));
        }
      }
      if (shape.type === 'plateau') {
        // 頂部加幾個不平的小突起，讓孩子練習「壓平頂端」
        for (let k = 0; k < 4; k++) {
          const a = rand() * Math.PI * 2;
          const rr = rand() * r * 0.55;
          addGaussian(h, n, 0.5 + Math.cos(a) * rr, 0.5 + Math.sin(a) * rr, 0.035, H * (0.25 + rand() * 0.15));
        }
      }
      break;
    }
  }
  for (let i = 0; i < h.length; i++) h[i] = Math.min(1, Math.max(0, h[i]));
  applyCoast(h, n);
  return h;
}
