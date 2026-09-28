import type { ClayCommand, Pt } from '../types';
import { OneEuroFilter } from './OneEuroFilter';

export type Pose = 'open' | 'fist' | 'pinch' | 'other';
export type Mode = 'idle' | 'pinch' | 'press' | 'smooth' | 'hold';
export type GestureEvent = 'grab' | 'drop' | 'empty' | 'cancel';

export interface GestureEnv {
  toUV(p: Pt): { u: number; v: number } | null;
  jarAt(p: Pt): 'left' | 'right' | null;
  hasClay(): boolean;
  screenH: number;
}

export interface HandView {
  key: string;
  points: Pt[];
  pose: Pose;
  mode: Mode;
  cursor: Pt;
}

/** 可調參數：距離都以「手掌大小」（手腕到中指根部）為單位。 */
export const G = {
  dwell: 0.15, // 手勢要維持多久才算數（秒）
  pinchOn: 0.33,
  pinchOff: 0.5,
  fistOn: 1.15,
  fistOff: 1.3,
  openOn: 1.5,
  openOff: 1.4,
  stillSpeed: 0.12, // 螢幕高度 / 秒
  rubSpeed: 0.35,
  stillTime: 0.35,
  lostTime: 0.3,
  pinchRadius: 0.055,
  // 高度 1 = 4000 m：每秒 0.04 ≈ 160 m，捏住不動約 6 秒才到 1000 m
  pinchHoldRate: 0.04,
  pinchPullGain: 0.45, // 往上拉滿半個螢幕約 +900 m
  touchRaiseRate: 0.05, // 手指「拉高」工具：每秒約 200 m
  palmRadius: 0.1,
  pressRate: 0.28,
  smoothRadius: 0.11,
  smoothStrength: 0.6,
  dropRadius: 0.09,
  dropVolume: 0.0016, // 約 500 m 高的一團
};

interface HandState {
  filters: OneEuroFilter[];
  rawPose: Pose;
  rawSince: number;
  pose: Pose;
  mode: Mode;
  hist: { t: number; p: Pt }[];
  stillSince: number | null;
  anchorV: number;
  prevY: number;
  fistUsed: boolean;
  lastSeen: number;
  lastT: number;
  view: HandView;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const avg = (ps: Pt[]): Pt => ({
  x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
  y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
});

export class GestureRecognizer {
  private hands = new Map<string, HandState>();

  get views(): HandView[] {
    return [...this.hands.values()].map((h) => h.view);
  }

  get anyHolding(): boolean {
    return [...this.hands.values()].some((h) => h.mode === 'hold');
  }

  /** hands：螢幕座標的 21 點。回傳要套用到黏土的指令與音效事件。 */
  update(
    hands: { key: string; points: Pt[] }[],
    t: number,
    env: GestureEnv,
  ): { commands: ClayCommand[]; events: GestureEvent[] } {
    const commands: ClayCommand[] = [];
    const events: GestureEvent[] = [];

    for (const raw of hands) {
      let st = this.hands.get(raw.key);
      if (!st) {
        st = this.newState(raw.key, t);
        this.hands.set(raw.key, st);
      }
      st.lastSeen = t;
      const dt = Math.min(0.1, Math.max(0.001, t - st.lastT));
      st.lastT = t;
      const p = raw.points.map((q, i) => ({
        x: st!.filters[i * 2].filter(q.x, t),
        y: st!.filters[i * 2 + 1].filter(q.y, t),
      }));
      this.step(st, p, t, dt, env, commands, events);
    }

    // 手不見了：結束進行中的動作
    for (const [key, st] of this.hands) {
      if (t - st.lastSeen < G.lostTime) continue;
      if (st.mode === 'hold') events.push('cancel');
      else if (st.mode !== 'idle') commands.push({ kind: 'commit' });
      this.hands.delete(key);
    }
    return { commands, events };
  }

  private newState(key: string, t: number): HandState {
    return {
      filters: Array.from({ length: 42 }, () => new OneEuroFilter()),
      rawPose: 'other',
      rawSince: t,
      pose: 'other',
      mode: 'idle',
      hist: [],
      stillSince: null,
      anchorV: 0,
      prevY: 0,
      fistUsed: false,
      lastSeen: t,
      lastT: t,
      view: { key, points: [], pose: 'other', mode: 'idle', cursor: { x: 0, y: 0 } },
    };
  }

  private classify(p: Pt[], prev: Pose): Pose {
    const s = dist(p[0], p[9]);
    if (s < 8) return 'other';
    const ext = (k: number) => dist(p[k], p[0]) / s;
    const meanExt = (ext(8) + ext(12) + ext(16) + ext(20)) / 4;
    const pinchD = dist(p[4], p[8]) / s;
    if (meanExt < (prev === 'fist' ? G.fistOff : G.fistOn)) return 'fist';
    if (pinchD < (prev === 'pinch' ? G.pinchOff : G.pinchOn)) return 'pinch';
    if (meanExt > (prev === 'open' ? G.openOff : G.openOn) && pinchD > 0.45) return 'open';
    return 'other';
  }

  private step(
    st: HandState,
    p: Pt[],
    t: number,
    dt: number,
    env: GestureEnv,
    commands: ClayCommand[],
    events: GestureEvent[],
  ): void {
    const raw = this.classify(p, st.rawPose);
    if (raw !== st.rawPose) {
      st.rawPose = raw;
      st.rawSince = t;
    }
    if (t - st.rawSince >= G.dwell) st.pose = st.rawPose;
    if (st.pose !== 'fist') st.fistUsed = false;

    const palm = avg([p[0], p[5], p[9], p[13], p[17]]);
    const pinchPt = avg([p[4], p[8]]);
    st.hist.push({ t, p: palm });
    while (st.hist.length > 2 && t - st.hist[0].t > 0.2) st.hist.shift();
    const h0 = st.hist[0];
    const speed = t > h0.t ? dist(h0.p, palm) / (t - h0.t) / env.screenH : 0;
    if (speed < G.stillSpeed) st.stillSince ??= t;
    else st.stillSince = null;
    const stillFor = st.stillSince === null ? 0 : t - st.stillSince;

    const end = () => {
      commands.push({ kind: 'commit' });
      st.mode = 'idle';
    };

    switch (st.mode) {
      case 'hold':
        if (st.pose === 'open') {
          const uv = env.toUV(palm);
          if (uv) {
            commands.push({ kind: 'drop', u: uv.u, v: uv.v, radius: G.dropRadius, volume: G.dropVolume });
            events.push('drop');
          } else events.push('cancel');
          st.mode = 'idle';
        }
        break;

      case 'pinch': {
        if (st.pose !== 'pinch' && st.rawPose !== 'pinch') {
          end();
          break;
        }
        const uv = env.toUV(pinchPt);
        const u = uv?.u;
        if (u === undefined) break;
        const pull = Math.max(0, st.prevY - pinchPt.y) / env.screenH;
        st.prevY = pinchPt.y;
        commands.push({
          kind: 'raise',
          u,
          v: st.anchorV,
          radius: G.pinchRadius,
          amount: G.pinchHoldRate * dt + pull * G.pinchPullGain,
        });
        break;
      }

      case 'press':
      case 'smooth': {
        const uv = st.pose === 'open' ? env.toUV(palm) : null;
        if (!uv) {
          end();
          break;
        }
        if (speed > G.rubSpeed) st.mode = 'smooth';
        else if (stillFor >= G.stillTime) st.mode = 'press';
        if (st.mode === 'smooth' && speed > G.stillSpeed)
          commands.push({ kind: 'smooth', u: uv.u, v: uv.v, radius: G.smoothRadius, strength: G.smoothStrength });
        else if (st.mode === 'press' && stillFor > 0)
          commands.push({ kind: 'press', u: uv.u, v: uv.v, radius: G.palmRadius, amount: G.pressRate * dt });
        break;
      }

      case 'idle': {
        if (st.pose === 'fist' && !st.fistUsed && env.jarAt(palm)) {
          st.fistUsed = true;
          if (env.hasClay()) {
            st.mode = 'hold';
            events.push('grab');
          } else events.push('empty');
        } else if (st.pose === 'pinch') {
          const uv = env.toUV(pinchPt);
          if (uv) {
            st.mode = 'pinch';
            st.anchorV = uv.v;
            st.prevY = pinchPt.y;
          }
        } else if (st.pose === 'open' && env.toUV(palm)) {
          if (speed > G.rubSpeed) st.mode = 'smooth';
          else if (stillFor >= G.stillTime) st.mode = 'press';
        }
        break;
      }
    }

    st.view = {
      key: st.view.key,
      points: p,
      pose: st.pose,
      mode: st.mode,
      cursor: st.mode === 'pinch' || st.pose === 'pinch' ? pinchPt : palm,
    };
  }
}
