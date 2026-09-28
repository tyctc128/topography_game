import type { JudgeCondition, JudgeResult, Landform, TerrainConfig } from '../types';
import { countPeaks, isInterior, mean, percentile, RIM, slopes } from './features';

export const PASS_SCORE = 70;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Cond extends JudgeCondition {
  mask?: (mask: Uint8Array) => void;
}

interface Ctx {
  h: Float32Array;
  n: number;
  cfg: TerrainConfig;
  m: Float32Array; // 公尺
  slope: Float32Array;
  interior: number[];
  land: number[]; // 高於 50 m 的格子
  features: Record<string, number>;
}

const LAND_M = 50;

/** 盆地判定參數（公尺）。 */
const BASIN = {
  rays: 36,
  wall: 120, // 某個方向的山比盆地底高這麼多，才算「有圍起來」
  depthOk: 150, // 四周的山（中位數）要比盆地底高這麼多
  floorBand: 100, // 比盆地底高不到這麼多的都算盆地底
};

export function judge(h: Float32Array, n: number, target: Landform, cfg: TerrainConfig): JudgeResult {
  const m = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) m[i] = h[i] * cfg.maxElevation;
  const interior: number[] = [];
  for (let i = 0; i < h.length; i++) if (isInterior(i, n)) interior.push(i);
  const land = interior.filter((i) => m[i] > LAND_M);
  const ctx: Ctx = { h, n, cfg, m, slope: slopes(h, n), interior, land, features: {} };
  ctx.features.peak = land.length ? Math.max(...land.map((i) => m[i])) : 0;
  ctx.features.landFrac = land.length / interior.length;

  const conds = RULES[target](ctx);
  const wsum = conds.reduce((a, c) => a + c.weight, 0);
  const score = Math.round((100 * conds.reduce((a, c) => a + c.weight * c.score, 0)) / wsum);
  const passed = score >= PASS_SCORE && conds.every((c) => !c.required || c.score >= 0.999);
  // 必要條件沒過時，分數不要顯示成及格，免得出現「100 分卻沒過關」
  const shown = passed ? score : Math.min(score, PASS_SCORE - 1);
  const failing = conds
    .filter((c) => c.score < 0.999)
    .sort((a, b) => a.score - b.score || Number(b.required) - Number(a.required) || b.weight - a.weight);
  const problemMask = new Uint8Array(h.length);
  if (!passed) failing[0]?.mask?.(problemMask);
  const stars = passed ? (score >= 95 ? 3 : score >= 85 ? 2 : 1) : 0;
  return {
    target,
    score: shown,
    passed,
    stars,
    hints: passed ? [] : failing.slice(0, 2).map((c) => c.hint),
    conditions: conds.map(({ mask: _mask, ...c }) => c),
    problemMask,
    features: ctx.features,
  };
}

const markWhere = (cells: number[], pred: (i: number) => boolean) => (mask: Uint8Array) => {
  for (const i of cells) if (pred(i)) mask[i] = 1;
};

const RULES: Record<Landform, (c: Ctx) => Cond[]> = {
  plain(c) {
    const th = c.cfg.thresholds.plain;
    const fracLow = c.interior.filter((i) => c.m[i] < th).length / c.interior.length;
    const slopeP90 = percentile(c.interior.map((i) => c.slope[i]), 90);
    Object.assign(c.features, { fracLow, slopeP90 });
    return [
      {
        key: 'low',
        score: smoothstep(0.85, 0.98, fracLow),
        weight: 0.6,
        required: true,
        hint: `還有地方超過 ${th} 公尺，再壓平一點`,
        mask: markWhere(c.interior, (i) => c.m[i] >= th),
      },
      {
        key: 'flat',
        score: 1 - smoothstep(6, 15, slopeP90),
        weight: 0.4,
        required: false,
        hint: '表面還凹凸不平，用手掌來回抹一抹',
        mask: markWhere(c.interior, (i) => c.slope[i] > 15),
      },
    ];
  },

  tableland(c) {
    const { hillsMax } = c.cfg.thresholds;
    const peak = percentile(c.land.map((i) => c.m[i]), 99);
    const top = c.land.filter((i) => c.m[i] >= 0.8 * peak);
    const topRatio = c.land.length ? top.length / c.land.length : 0;
    const topFlat = top.length ? top.filter((i) => c.slope[i] < 12).length / top.length : 0;
    const flank = c.land.filter((i) => c.m[i] > 0.2 * peak && c.m[i] < 0.8 * peak);
    const edgeSlope = mean(flank.map((i) => c.slope[i]));
    Object.assign(c.features, { tablePeak: peak, topRatio, topFlat, edgeSlope });
    const tooHigh = peak >= hillsMax;
    return [
      {
        key: 'height',
        score: tooHigh ? 0 : smoothstep(40, 120, peak),
        weight: 0.2,
        required: true,
        hint: tooHigh ? `台地不會那麼高，不要超過 ${hillsMax} 公尺` : '台地要比周圍的平原高一些',
        mask: markWhere(c.land, (i) => c.m[i] >= hillsMax),
      },
      {
        key: 'topWide',
        score: smoothstep(0.15, 0.35, topRatio),
        weight: 0.25,
        required: false,
        hint: '台地的頂部要又寬又平，把凸起來的地方壓下去',
        mask: markWhere(top, () => true),
      },
      {
        key: 'topFlat',
        score: smoothstep(0.45, 0.8, topFlat),
        weight: 0.35,
        required: false,
        hint: '頂端還不夠平，用手掌抹平或壓平',
        mask: markWhere(top, (i) => c.slope[i] >= 12),
      },
      {
        key: 'edge',
        score: smoothstep(12, 28, edgeSlope),
        weight: 0.2,
        required: false,
        hint: '邊邊要陡一點，像被切下去一樣',
        mask: markWhere(flank, (i) => c.slope[i] < 20),
      },
    ];
  },

  hills(c) {
    const { hillsMax, plain } = c.cfg.thresholds;
    const peak = c.features.peak;
    const peaks = countPeaks(c.m, c.n, 6, plain, 60).length;
    const slopeMean = mean(c.land.map((i) => c.slope[i]));
    const landFrac = c.features.landFrac;
    Object.assign(c.features, { peaks, slopeMean });
    const tooHigh = peak >= hillsMax;
    return [
      {
        key: 'range',
        score: tooHigh ? 0 : peak < plain ? 0.5 * smoothstep(0, plain, peak) : 1,
        weight: 0.35,
        required: true,
        hint: tooHigh
          ? `太高了！超過 ${hillsMax} 公尺就變成山地了，把山頭壓低一點`
          : `丘陵要比平原高，要超過 ${plain} 公尺`,
        mask: markWhere(c.land, (i) => c.m[i] >= hillsMax),
      },
      {
        key: 'peaks',
        score: Math.min(1, peaks / 3),
        weight: 0.3,
        required: false,
        hint: '丘陵有好幾個小山頭，再多做幾個',
      },
      {
        key: 'gentle',
        score: 1 - smoothstep(32, 48, slopeMean),
        weight: 0.15,
        required: false,
        hint: '坡太陡了，用手掌把山頭抹圓一點',
        mask: markWhere(c.land, (i) => c.slope[i] > 45),
      },
      {
        key: 'area',
        score: smoothstep(0.02, 0.08, landFrac),
        weight: 0.2,
        required: false,
        hint: '丘陵要連成一大片，多放一些黏土',
      },
    ];
  },

  mountain(c) {
    const { mountainMin } = c.cfg.thresholds;
    const peak = c.features.peak;
    const slopeP90 = percentile(c.land.map((i) => c.slope[i]), 90);
    Object.assign(c.features, { slopeP90 });
    return [
      {
        key: 'height',
        score: peak >= mountainMin ? 1 : 0.7 * smoothstep(200, mountainMin, peak),
        weight: 0.5,
        required: true,
        hint: `山還不夠高，要超過 ${mountainMin} 公尺的紅線！`,
        mask: markWhere(c.land, (i) => c.m[i] >= 0.85 * peak),
      },
      {
        key: 'steep',
        score: smoothstep(15, 30, slopeP90),
        weight: 0.25,
        required: false,
        hint: '山坡要陡一點，用手指捏住往上拉',
      },
      {
        key: 'mass',
        score: smoothstep(0.01, 0.04, c.features.landFrac),
        weight: 0.25,
        required: false,
        hint: '山要大一點，多放幾團黏土',
      },
    ];
  },

  basin(c) {
    const { n, m } = c;
    const B = BASIN;
    // 1. 找盆地中心：從候選點往 36 個方向看，四周「牆」最完整、最高的那一點
    const scan = (cx: number, cy: number) => {
      let floor = 0;
      let cnt = 0;
      for (let y = -2; y <= 2; y++)
        for (let x = -2; x <= 2; x++) {
          floor += m[(cy + y) * n + cx + x];
          cnt++;
        }
      floor /= cnt;
      const rays: { rise: number; wallAt: number; floorR: number; cells: number[] }[] = [];
      for (let k = 0; k < B.rays; k++) {
        const a = (k / B.rays) * Math.PI * 2;
        const cells: number[] = [];
        let rise = 0;
        let wallAt = 0;
        let floorR = -1;
        for (let s = 1; ; s++) {
          const x = Math.round(cx + Math.cos(a) * s);
          const y = Math.round(cy + Math.sin(a) * s);
          if (x < RIM || y < RIM || x >= n - RIM || y >= n - RIM) break;
          const i = y * n + x;
          cells.push(i);
          const r = m[i] - floor;
          if (floorR < 0 && r >= B.floorBand) floorR = s;
          if (r > rise) {
            rise = r;
            wallAt = cells.length - 1;
          }
        }
        rays.push({ rise, wallAt, floorR: floorR < 0 ? cells.length : floorR, cells });
      }
      const closure = rays.filter((r) => r.rise >= B.wall).length / B.rays;
      const depth = percentile(rays.map((r) => r.rise), 50);
      return { cx, cy, floor, rays, closure, depth };
    };
    let best: ReturnType<typeof scan> | null = null;
    let bestKey = -1;
    for (let y = RIM + 4; y < n - RIM - 4; y += 4)
      for (let x = RIM + 4; x < n - RIM - 4; x += 4) {
        const s = scan(x, y);
        // 先看圍得完不完整，再看四周比中心高多少（越深越像盆地中心）
        const key = Math.min(1, s.closure / 0.9) * 4 + Math.min(s.depth, 3000) / B.depthOk;
        if (key > bestKey) {
          bestKey = key;
          best = s;
        }
      }
    const b = best!;
    const cell = 1 / (n - 1);
    const floorRadius = percentile(b.rays.map((r) => r.floorR), 50) * cell;
    const openRays = b.rays.filter((r) => r.rise < B.wall);
    const lowWalls = b.rays.filter((r) => r.rise < B.depthOk);
    const floorLow = b.floor <= c.cfg.thresholds.plain * 1.5;
    Object.assign(c.features, {
      basinDepth: b.depth,
      closure: b.closure,
      floorM: b.floor,
      floorRadius,
      centerU: b.cx / (n - 1),
      centerV: b.cy / (n - 1),
    });
    const markFloor = (mk: Uint8Array) => {
      const r = Math.max(4, Math.round(floorRadius / cell));
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++)
          if (x * x + y * y <= r * r) {
            const yy = b.cy + y;
            const xx = b.cx + x;
            if (xx >= 0 && yy >= 0 && xx < n && yy < n) mk[yy * n + xx] = 1;
          }
    };
    return [
      {
        key: 'depth',
        score: smoothstep(50, B.depthOk, b.depth),
        weight: 0.45,
        required: true,
        // 中間已經很低了，就請孩子把四周堆高，而不是一直叫他壓中間
        hint: floorLow
          ? `四周的山要再高一點，要比盆地底部高 ${B.depthOk} 公尺以上`
          : '中間要比四周低很多，把中間再壓低一點',
        mask: floorLow
          ? (mk) => {
              for (const r of lowWalls) mk[r.cells[r.wallAt]] = 1;
              for (const r of lowWalls) for (const i of r.cells.slice(Math.max(0, r.wallAt - 3), r.wallAt + 4)) mk[i] = 1;
            }
          : markFloor,
      },
      {
        key: 'closure',
        score: smoothstep(0.65, 0.9, b.closure), // 最多允許約 36° 的缺口（像河流出口）
        weight: 0.35,
        required: true,
        hint: '四周要圍起來，缺口太大了（閃紅色的地方）',
        mask: (mk) => {
          for (const r of openRays) for (const i of r.cells.slice(Math.floor(r.cells.length * 0.3))) mk[i] = 1;
        },
      },
      {
        key: 'area',
        score: smoothstep(0.03, 0.07, floorRadius),
        weight: 0.2,
        required: false,
        hint: '盆地的底部要寬一點',
        mask: markFloor,
      },
    ];
  },

  profile(c) {
    const { n, m } = c;
    const { plain, hillsMax, mountainMin } = c.cfg.thresholds;
    const col = (i: number) => (i % n) / (n - 1);
    const west = c.interior.filter((i) => col(i) < 0.36);
    const mid = c.interior.filter((i) => col(i) >= 0.36 && col(i) < 0.62);
    const east = c.interior.filter((i) => col(i) >= 0.62);
    const westLow = west.filter((i) => m[i] < plain).length / west.length;
    const midPeak = Math.max(0, ...mid.map((i) => m[i]));
    const midLand = mid.filter((i) => m[i] >= plain).length / mid.length;
    const eastPeak = Math.max(0, ...east.map((i) => m[i]));
    Object.assign(c.features, { westLow, midPeak, midLand, eastPeak });
    const midTooHigh = midPeak >= hillsMax;
    return [
      {
        key: 'west',
        score: smoothstep(0.75, 0.92, westLow),
        weight: 0.3,
        required: true,
        hint: `西邊（左邊）要是平原，低於 ${plain} 公尺`,
        mask: markWhere(west, (i) => m[i] >= plain),
      },
      {
        key: 'mid',
        score: midTooHigh ? 0 : midPeak < plain ? 0 : smoothstep(0.03, 0.12, midLand),
        weight: 0.35,
        required: true,
        hint: midTooHigh
          ? `中間的丘陵太高了，不要超過 ${hillsMax} 公尺`
          : `中間要做丘陵（${plain}～${hillsMax} 公尺的小山頭）`,
        mask: markWhere(mid, (i) => (midTooHigh ? m[i] >= hillsMax : true)),
      },
      {
        key: 'east',
        score: eastPeak >= mountainMin ? 1 : 0.7 * smoothstep(200, mountainMin, eastPeak),
        weight: 0.35,
        required: true,
        hint: `東邊（右邊）要有超過 ${mountainMin} 公尺的高山`,
      },
    ];
  },
};
