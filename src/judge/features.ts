import { JUDGE_VERT_SCALE } from '../constants';

export const RIM = 2;

export function isInterior(i: number, n: number): boolean {
  const x = i % n;
  const y = (i / n) | 0;
  return x >= RIM && y >= RIM && x < n - RIM && y < n - RIM;
}

/** 畫面上看到的坡度（度），以中央差分計算。 */
export function slopes(h: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n);
  const cell = 1 / (n - 1);
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const gx = ((h[i + 1] - h[i - 1]) * JUDGE_VERT_SCALE) / (2 * cell);
      const gy = ((h[i + n] - h[i - n]) * JUDGE_VERT_SCALE) / (2 * cell);
      out[i] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * 局部山頭數：半徑 radius 格內的最高點，且比窗口內最低點高 prominence 以上。
 * m = 公尺高度。
 */
export function countPeaks(m: Float32Array, n: number, radius: number, minM: number, prominence: number): number[] {
  const peaks: number[] = [];
  for (let y = RIM; y < n - RIM; y++) {
    for (let x = RIM; x < n - RIM; x++) {
      const i = y * n + x;
      const c = m[i];
      if (c < minM) continue;
      let isMax = true;
      let lo = c;
      for (let dy = -radius; dy <= radius && isMax; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= n) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= n || (dx === 0 && dy === 0)) continue;
          const o = m[yy * n + xx];
          // 同高時以索引較小者為準，避免平頂被算成很多山頭
          if (o > c || (o === c && yy * n + xx < i)) {
            isMax = false;
            break;
          }
          if (o < lo) lo = o;
        }
      }
      if (isMax && c - lo >= prominence) peaks.push(i);
    }
  }
  return peaks;
}
