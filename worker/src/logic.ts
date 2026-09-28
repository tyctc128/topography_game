// 出題、結算、CSV：純運算，不碰資料庫，方便測試

export const TERRAIN_POOL = ['plain', 'tableland', 'hills', 'mountain', 'basin'] as const;
export const TERRAIN_SECONDS = 60;
export const MC_SECONDS = 30;
export const GRACE_MS = 3000; // 截止後 3 秒內的提交仍接受（網路延遲）
export const TERRAIN_COUNT = 3;
export const MC_COUNT = 2;

/** 0 ≤ 結果 < n 的均勻隨機整數。 */
export function randInt(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

export function shuffle<T>(a: readonly T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

export interface PlannedItem {
  kind: 'terrain' | 'mc';
  target: string;
  optionOrder: number[] | null;
}

/**
 * 一次作答的 5 題：地形 3 種不重複、選擇題 2 題（盡量避開上一次出過的），題序也打亂。
 */
export function planAttempt(questionIds: string[], avoid: Set<string>): PlannedItem[] {
  const terrains = shuffle(TERRAIN_POOL).slice(0, TERRAIN_COUNT);
  const fresh = shuffle(questionIds.filter((q) => !avoid.has(q)));
  const reused = shuffle(questionIds.filter((q) => avoid.has(q)));
  const mcs = [...fresh, ...reused].slice(0, MC_COUNT);
  if (mcs.length < MC_COUNT) throw new Error('not_enough_questions');
  return shuffle<PlannedItem>([
    ...terrains.map((t) => ({ kind: 'terrain' as const, target: t, optionOrder: null })),
    ...mcs.map((q) => ({ kind: 'mc' as const, target: q, optionOrder: shuffle([0, 1, 2, 3]) })),
  ]);
}

export interface BoardStudent {
  uid: string;
  no: number;
  name: string;
  best: number; // 沒作答 = 0
  attempts: number;
  team: number | null;
}

export interface TeamResult {
  team: number;
  avg: number;
  rank: number | null; // 沒有組員的組不排名
  members: { uid: string; no: number; name: string; stars: number }[];
}

export interface Settlement {
  mode: 'solo' | 'team';
  classAvg: number;
  unassigned: number;
  teams: TeamResult[];
  ranking: { uid: string; no: number; name: string; stars: number; rank: number }[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** 同分並列：名次 = 1 + 比自己高分的人數。 */
function rankOf<T>(list: T[], score: (t: T) => number): (t: T) => number {
  return (t) => 1 + list.filter((o) => score(o) > score(t)).length;
}

/**
 * 結算：小組平均 = 組員最高星數的平均，沒作答算 0 星並列入平均；未分組的人不算進任何一組。
 */
export function settle(mode: 'solo' | 'team', teamCount: number, students: BoardStudent[]): Settlement {
  const classAvg = students.length ? round1(students.reduce((s, x) => s + x.best, 0) / students.length) : 0;
  const ranked = [...students].sort((a, b) => b.best - a.best || a.no - b.no);
  const rStudent = rankOf(ranked, (s) => s.best);
  const ranking = ranked.map((s) => ({ uid: s.uid, no: s.no, name: s.name, stars: s.best, rank: rStudent(s) }));
  if (mode === 'solo') return { mode, classAvg, unassigned: 0, teams: [], ranking };

  const teams: TeamResult[] = [];
  for (let t = 1; t <= teamCount; t++) {
    const members = students.filter((s) => s.team === t);
    teams.push({
      team: t,
      avg: members.length ? round1(members.reduce((s, x) => s + x.best, 0) / members.length) : 0,
      rank: null,
      members: members.map((s) => ({ uid: s.uid, no: s.no, name: s.name, stars: s.best })),
    });
  }
  const withMembers = teams.filter((t) => t.members.length);
  const rTeam = rankOf(withMembers, (t) => t.avg);
  for (const t of withMembers) t.rank = rTeam(t);
  teams.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.team - b.team);
  const unassigned = students.filter((s) => !s.team || s.team > teamCount).length;
  return { mode, classAvg, unassigned, teams, ranking };
}

/** Excel 可開的 CSV：UTF-8 BOM、引號跳脫、防止公式注入。 */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&");
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
