export type Landform = 'plain' | 'tableland' | 'hills' | 'mountain' | 'basin' | 'profile';

export interface TerrainConfig {
  maxElevation: number;
  thresholds: { plain: number; hillsMax: number; mountainMin: number };
  contour: { minor: number; major: number; highlight: number };
  ramp: { m: number; color: string }[];
  highlightColor?: string;
}

export interface StartShape {
  type: 'flat' | 'bumps' | 'mound' | 'plateau';
  height?: number; // 公尺
  radius?: number; // 底板座標 0–1
  count?: number;
  power?: number;
  seed?: number;
}

export interface LevelDef {
  id: string;
  target: Landform;
  title: string;
  intro: string;
  targets: string[];
  tip: string;
  start: StartShape;
  budget: number; // 黏土罐容量，以「整塊底板的平均高度」計（0–1）
  conserveVolume: boolean;
  reveal: { name: string; fact: string };
}

// u, v = 底板座標 0–1（u 由西到東，v 由遠到近）；amount 已乘上 dt
export type ClayCommand =
  | { kind: 'raise'; u: number; v: number; radius: number; amount: number }
  | { kind: 'press'; u: number; v: number; radius: number; amount: number }
  | { kind: 'smooth'; u: number; v: number; radius: number; strength: number }
  | { kind: 'drop'; u: number; v: number; radius: number; volume: number }
  | { kind: 'commit' };

export interface JudgeCondition {
  key: string;
  score: number; // 0–1
  weight: number;
  required: boolean;
  hint: string;
}

export interface JudgeResult {
  target: Landform;
  score: number; // 0–100
  passed: boolean;
  stars: number;
  hints: string[];
  conditions: JudgeCondition[];
  problemMask: Uint8Array;
  features: Record<string, number>;
}

export interface Pt {
  x: number;
  y: number;
}
