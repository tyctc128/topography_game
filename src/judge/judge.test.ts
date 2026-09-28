import { describe, expect, it } from 'vitest';
import terrain from '../../public/config/terrain.json';
import levels from '../../public/config/levels.json';
import { addGaussian, applyCoast, buildStart } from '../clay/startShapes';
import { GRID } from '../constants';
import type { LevelDef, Landform, TerrainConfig } from '../types';
import { ClayModel } from '../clay/ClayModel';
import { judge } from './judge';

const cfg = terrain as TerrainConfig;
const n = GRID;
const M = cfg.maxElevation;

function field(fn: (u: number, v: number) => number): Float32Array {
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = fn(x / (n - 1), y / (n - 1)) / M;
  applyCoast(h, n);
  return h;
}
function bumps(list: [u: number, v: number, sigma: number, meters: number][]): Float32Array {
  const h = new Float32Array(n * n);
  for (const [u, v, s, mm] of list) addGaussian(h, n, u, v, s, mm / M);
  applyCoast(h, n);
  return h;
}
const d = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5);
function run(h: Float32Array, t: Landform) {
  const r = judge(h, n, t, cfg);
  return { passed: r.passed, score: r.score, hints: r.hints, f: r.features };
}

describe('每一關的起始狀態都不會直接過關', () => {
  for (const lv of levels as LevelDef[]) {
    it(lv.id, () => {
      const r = run(buildStart(lv.start, n, M), lv.target);
      expect(r.passed, JSON.stringify(r)).toBe(false);
      expect(r.hints.length).toBeGreaterThan(0);
    });
  }
});

describe('理想地形會過關', () => {
  it('平原：平的底板', () => {
    const r = run(field(() => 40), 'plain');
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });
  it('台地：平頂、陡邊', () => {
    const r = run(field((u, v) => 420 * Math.exp(-Math.pow(d(u, v) / 0.27, 6))), 'tableland');
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });
  it('丘陵：四個 600 m 小山頭', () => {
    const r = run(bumps([[0.35, 0.35, 0.06, 600], [0.62, 0.38, 0.06, 550], [0.4, 0.65, 0.06, 650], [0.65, 0.66, 0.06, 500]]), 'hills');
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });
  it('山地：2200 m 的山', () => {
    const r = run(bumps([[0.5, 0.5, 0.08, 2200]]), 'mountain');
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });
  it('盆地：一圈環狀山', () => {
    const r = run(field((u, v) => 800 * Math.exp(-Math.pow((d(u, v) - 0.22) / 0.08, 2))), 'basin');
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });
  it('臺灣剖面：西平原、中丘陵、東山地', () => {
    const r = run(bumps([[0.45, 0.4, 0.05, 500], [0.52, 0.6, 0.05, 450], [0.8, 0.5, 0.07, 2400]]), 'profile');
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });
});

describe('會分辨相近的地形', () => {
  it('圓圓的山丘不是台地', () => {
    expect(run(field((u, v) => 420 * Math.exp(-Math.pow(d(u, v) / 0.2, 2))), 'tableland').passed).toBe(false);
  });
  it('超過 1000 m 就不是丘陵，並提示太高', () => {
    const r = run(bumps([[0.35, 0.35, 0.06, 600], [0.62, 0.38, 0.06, 1500], [0.4, 0.65, 0.06, 650]]), 'hills');
    expect(r.passed).toBe(false);
    expect(r.hints[0]).toContain('太高');
  });
  it('600 m 的山不算山地', () => {
    expect(run(bumps([[0.5, 0.5, 0.08, 600]]), 'mountain').passed).toBe(false);
  });
  it('有缺口的環狀山不算盆地，並提示缺口', () => {
    const r = run(
      field((u, v) => {
        const ring = 800 * Math.exp(-Math.pow((d(u, v) - 0.22) / 0.08, 2));
        return u > 0.5 && Math.abs(v - 0.5) < 0.12 ? ring * 0.05 : ring;
      }),
      'basin',
    );
    expect(r.passed, JSON.stringify(r)).toBe(false);
    expect(r.hints.join()).toContain('缺口');
  });
});

describe('盆地：中間已經壓低壓平時，不會再叫孩子「壓下去」', () => {
  // 模擬孩子從起始土丘開始，在中間半徑 R 內一圈一圈用手掌壓
  function pressBasin(R: number, channel = false) {
    const lv = (levels as LevelDef[]).find((l) => l.id === 'basin')!;
    const c = new ClayModel(n);
    c.reset(lv, M);
    const press = (u: number, v: number) => {
      for (let k = 0; k < 30; k++) c.apply({ kind: 'press', u, v, radius: 0.1, amount: 0.28 / 30 });
    };
    for (let r = 0; r <= R + 1e-9; r += 0.04)
      for (let a = 0; a < Math.PI * 2; a += r ? 0.04 / r : 7) press(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r);
    if (channel) for (let u = 0.5; u < 0.95; u += 0.03) press(u, 0.5); // 一路抹到海邊的溝
    return run(c.h, 'basin');
  }

  it('中間壓成一大片平地、四周還有約 200 m → 過關', () => {
    const r = pressBasin(0.22);
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });

  it('有一條小溝通到外面（像淡水河出海口）→ 仍算盆地', () => {
    const r = pressBasin(0.1, true);
    expect(r.passed, JSON.stringify(r)).toBe(true);
  });

  it('壓太大片、四周的山太矮 → 提示把四周堆高，而不是壓中間', () => {
    const r = pressBasin(0.26);
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(70);
    expect(r.hints[0]).toContain('四周的山要再高');
    expect(r.hints.join()).not.toContain('壓');
  });
});
