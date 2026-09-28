import { describe, expect, it } from 'vitest';
import type { ClayCommand, Pt } from '../types';
import { GestureRecognizer, type GestureEnv, type GestureEvent } from './GestureRecognizer';

// 合成的手：手腕在 (x, y)，手掌大小 100 px（手腕到中指根部），手指朝上
type Shape = 'open' | 'fist' | 'pinch';
function hand(x: number, y: number, shape: Shape): Pt[] {
  const p: Pt[] = new Array(21);
  const mcpX = [-30, -10, 10, 30];
  p[0] = { x, y };
  // 拇指 1–4
  const thumbTip =
    shape === 'open' ? { x: x - 75, y: y - 60 } : shape === 'fist' ? { x: x - 20, y: y - 70 } : { x: x - 42, y: y - 118 };
  for (let k = 1; k <= 4; k++) {
    const t = k / 4;
    p[k] = { x: x + (thumbTip.x - x) * t, y: y + (thumbTip.y - y) * t };
  }
  // 四指：根部 5,9,13,17；指尖 8,12,16,20
  for (let f = 0; f < 4; f++) {
    const base = 5 + f * 4;
    const mcp = { x: x + mcpX[f], y: y - 100 };
    let tip: Pt;
    if (shape === 'fist') tip = { x: mcp.x, y: y - 85 };
    else if (shape === 'pinch' && f === 0) tip = { x: x - 40, y: y - 128 };
    else tip = { x: mcp.x, y: y - 190 };
    p[base] = mcp;
    for (let k = 1; k <= 3; k++) {
      const t = k / 3;
      p[base + k] = { x: mcp.x + (tip.x - mcp.x) * t, y: mcp.y + (tip.y - mcp.y) * t };
    }
  }
  return p;
}

// 底板在螢幕 200–800 px 見方；左邊 x < 150 是黏土罐
const env: GestureEnv = {
  toUV: (p) => (p.x >= 200 && p.x <= 800 && p.y >= 200 && p.y <= 800 ? { u: (p.x - 200) / 600, v: (p.y - 200) / 600 } : null),
  jarAt: (p) => (p.x < 150 ? 'left' : null),
  hasClay: () => true,
  screenH: 1000,
};

function run(frames: { t: number; x: number; y: number; shape: Shape }[]) {
  const g = new GestureRecognizer();
  const commands: ClayCommand[] = [];
  const events: GestureEvent[] = [];
  for (const f of frames) {
    const r = g.update([{ key: 'Right', points: hand(f.x, f.y, f.shape) }], f.t, env);
    commands.push(...r.commands);
    events.push(...r.events);
  }
  return { g, commands, events };
}
const seq = (n: number, fn: (i: number) => { x: number; y: number; shape: Shape }) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 0.033, ...fn(i) }));

describe('GestureRecognizer', () => {
  it('張開手掌停住 → 壓平', () => {
    const { commands } = run(seq(30, () => ({ x: 500, y: 600, shape: 'open' })));
    expect(commands.some((c) => c.kind === 'press')).toBe(true);
    expect(commands.some((c) => c.kind === 'smooth')).toBe(false);
  });

  it('張開手掌快速來回 → 抹平', () => {
    const { commands } = run(seq(40, (i) => ({ x: 500 + Math.sin(i * 0.6) * 150, y: 600, shape: 'open' })));
    expect(commands.some((c) => c.kind === 'smooth')).toBe(true);
  });

  it('捏住往上拉 → 拉高，但拉一下不會就超過 1000 m', () => {
    const total = (dy: number) =>
      run(seq(30, (i) => ({ x: 500, y: 700 - i * dy, shape: 'pinch' })))
        .commands.filter((c) => c.kind === 'raise')
        .reduce((s, c) => s + (c.kind === 'raise' ? c.amount : 0), 0);
    const still = total(0);
    const pulled = total(8); // 約 1 秒往上拉 1/4 個螢幕
    expect(still).toBeGreaterThan(0);
    expect(pulled).toBeGreaterThan(still * 2);
    expect(pulled * 4000).toBeLessThan(1000);
  });

  it('在黏土罐上握拳 → 拿起；移到底板張開 → 放下一團', () => {
    const frames = [
      ...seq(10, () => ({ x: 100, y: 500, shape: 'fist' as Shape })),
      ...seq(10, (i) => ({ x: 100 + i * 40, y: 600, shape: 'fist' as Shape })),
      ...seq(10, () => ({ x: 500, y: 600, shape: 'open' as Shape })),
    ].map((f, i) => ({ ...f, t: i * 0.033 }));
    const { commands, events } = run(frames);
    expect(events).toEqual(['grab', 'drop']);
    expect(commands.filter((c) => c.kind === 'drop')).toHaveLength(1);
    // 拿著黏土經過底板時不會壓到黏土
    expect(commands.some((c) => c.kind === 'press')).toBe(false);
  });

  it('不在黏土罐上握拳不會拿到黏土', () => {
    const { events } = run(seq(20, () => ({ x: 500, y: 600, shape: 'fist' })));
    expect(events).toEqual([]);
  });

  it('手離開畫面時結束動作（存成一步復原）', () => {
    const g = new GestureRecognizer();
    for (let i = 0; i < 30; i++) g.update([{ key: 'Right', points: hand(500, 600, 'open') }], i * 0.033, env);
    const r = g.update([], 30 * 0.033 + 0.5, env);
    expect(r.commands).toEqual([{ kind: 'commit' }]);
    expect(g.views).toHaveLength(0);
  });
});
