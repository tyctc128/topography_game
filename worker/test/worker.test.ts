import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addGaussian, applyCoast } from '../../src/clay/startShapes';
import { encodeHeights } from '../../src/shared/heightmap';
import { useKeysForTesting } from '../src/auth';
import worker, { type Env } from '../src/index';
import { settle } from '../src/logic';
import { sqliteD1 } from './sqlite-d1';

const N = 128;
const ORIGIN = 'https://tyctc128.github.io';
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let env: Env;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'test', alg: 'RS256' };
  useKeysForTesting(createLocalJWKSet({ keys: [jwk] }));
});

beforeEach(() => {
  env = { DB: sqliteD1(), ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5180`, SSO_PROJECT: 'hspssso' };
});
afterEach(() => vi.restoreAllMocks());

async function token(uid: string, role = 'student', key = privateKey) {
  return new SignJWT({ studentName: `名字${uid}`, role, no: 1 })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://securetoken.google.com/hspssso')
    .setAudience('hspssso')
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

async function call(method: string, path: string, who: string | null, data?: unknown, role = 'student') {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (who) headers.Authorization = `Bearer ${await token(who, role)}`;
  const res = await worker.fetch(
    new Request(`https://api.example${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }),
    env,
  );
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* CSV 等非 JSON */
  }
  return { status: res.status, body, headers: res.headers };
}
const teacher = (m: string, p: string, d?: unknown) => call(m, p, 'teacher1', d, 'admin');

const QUESTIONS = [
  { id: 'Q01', stem: '哪一種地形地勢最高？', options: ['平原', '山地', '丘陵', '台地'], answer: 1, explanation: '山地最高' },
  { id: 'Q02', stem: '四周高、中間低平的是？', options: ['盆地', '平原', '台地', '丘陵'], answer: 0, explanation: '' },
  { id: 'Q03', stem: '適合種茶的是？', options: ['平原', '山地', '盆地', '丘陵'], answer: 3, explanation: '' },
];

async function setupClass(mode: 'solo' | 'team' = 'team') {
  expect((await teacher('PUT', '/api/roster', { students: [
    { no: 1, uid: 's1', name: '甲' },
    { no: 2, uid: 's2', name: '乙' },
    { no: 3, uid: 's3', name: '丙' },
  ] })).status).toBe(200);
  expect((await teacher('PUT', '/api/questions', { questions: QUESTIONS })).status).toBe(200);
  const q = await teacher('POST', '/api/quizzes', { title: '臺灣地形大挑戰', mode, teamCount: 2 });
  expect(q.status).toBe(200);
  return q.body.id as string;
}

// 各地形的理想高度圖（與 judge 測試相同的形狀）
function field(fn: (u: number, v: number) => number) {
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] = fn(x / (N - 1), y / (N - 1)) / 4000;
  applyCoast(h, N);
  return h;
}
function bumps(list: [number, number, number, number][]) {
  const h = new Float32Array(N * N);
  for (const [u, v, s, m] of list) addGaussian(h, N, u, v, s, m / 4000);
  applyCoast(h, N);
  return h;
}
const d = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5);
const IDEAL: Record<string, () => Float32Array> = {
  plain: () => field(() => 40),
  tableland: () => field((u, v) => 420 * Math.exp(-Math.pow(d(u, v) / 0.27, 6))),
  hills: () => bumps([[0.35, 0.35, 0.06, 600], [0.62, 0.38, 0.06, 550], [0.4, 0.65, 0.06, 650], [0.65, 0.66, 0.06, 500]]),
  mountain: () => bumps([[0.5, 0.5, 0.08, 2200]]),
  basin: () => field((u, v) => 800 * Math.exp(-Math.pow((d(u, v) - 0.22) / 0.08, 2))),
};

/** 一定不符合的地形：山地題給平地，其他題給一座 2200 m 的高山。 */
const WRONG = (landform: string) => (landform === 'mountain' ? new Float32Array(N * N) : IDEAL.mountain());

/** 把一整次作答答完：answerRight 決定每題要答對還是答錯。 */
async function playAttempt(uid: string, quizId: string, answerRight: (idx: number) => boolean) {
  const start = await call('POST', `/api/quizzes/${quizId}/attempts`, uid);
  expect(start.status).toBe(200);
  const id = start.body.attemptId as string;
  for (let n = 0; n < 5; n++) {
    const it = await call('POST', `/api/attempts/${id}/items/${n}/open`, uid);
    expect(it.status).toBe(200);
    if (it.body.kind === 'terrain') {
      const h = answerRight(n) ? IDEAL[it.body.landform]() : WRONG(it.body.landform);
      expect((await call('POST', `/api/attempts/${id}/items/${n}/submit`, uid, { terrain: await encodeHeights(h) })).status).toBe(200);
    } else {
      const q = QUESTIONS.find((x) => x.stem === it.body.stem)!;
      const right = (it.body.options as string[]).indexOf(q.options[q.answer]);
      const choice = answerRight(n) ? right : (right + 1) % 4;
      expect((await call('POST', `/api/attempts/${id}/items/${n}/submit`, uid, { choice })).status).toBe(200);
    }
  }
  return (await call('POST', `/api/attempts/${id}/finish`, uid)).body;
}

describe('身分驗證與權限', () => {
  it('沒有 token 或 token 被偽造 → 401', async () => {
    expect((await call('GET', '/api/me', null)).status).toBe(401);
    const forged = await token('s1', 'admin', otherKey);
    const res = await worker.fetch(new Request('https://api.example/api/me', { headers: { Authorization: `Bearer ${forged}` } }), env);
    expect(res.status).toBe(401);
  });

  it('學生不能呼叫老師 API → 403', async () => {
    expect((await call('GET', '/api/roster', 's1')).status).toBe(403);
    expect((await call('POST', '/api/quizzes', 's1', { title: 'x', mode: 'solo' })).status).toBe(403);
  });

  it('CORS 只允許自己的網站', async () => {
    const ok = await worker.fetch(new Request('https://api.example/api/health', { headers: { Origin: ORIGIN } }), env);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const bad = await worker.fetch(new Request('https://api.example/api/health', { headers: { Origin: 'https://evil.example' } }), env);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('測驗流程', () => {
  it('草稿不會出現在學生端；發布後出現且標示新測驗', async () => {
    const id = await setupClass();
    expect((await call('GET', '/api/quizzes', 's1')).body).toHaveLength(0);
    expect((await teacher('POST', `/api/quizzes/${id}/publish`)).status).toBe(200);
    const list = (await call('GET', '/api/quizzes', 's1')).body;
    expect(list).toHaveLength(1);
    expect(list[0].isNew).toBe(true);
  });

  it('不在名單上的人不能作答', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    expect((await call('POST', `/api/quizzes/${id}/attempts`, 'stranger')).status).toBe(403);
  });

  it('每次 5 題：地形 3 種不重複＋選擇題 2 題；題目要依序開；選擇題不會送出答案', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    const a = (await call('POST', `/api/quizzes/${id}/attempts`, 's1')).body;
    expect(a.items).toHaveLength(5);
    expect(a.items.filter((i: any) => i.kind === 'terrain')).toHaveLength(3);
    expect((await call('POST', `/api/attempts/${a.attemptId}/items/1/open`, 's1')).status).toBe(409);
    const kinds = new Set<string>();
    const mcs = new Set<string>();
    for (let n = 0; n < 5; n++) {
      const it = (await call('POST', `/api/attempts/${a.attemptId}/items/${n}/open`, 's1')).body;
      expect(JSON.stringify(it)).not.toMatch(/answer|explanation/);
      if (it.kind === 'terrain') {
        kinds.add(it.landform);
        expect(it.remainingMs).toBeLessThanOrEqual(60000);
      } else {
        mcs.add(it.stem);
        expect(it.options).toHaveLength(4);
        expect(it.remainingMs).toBeLessThanOrEqual(30000);
      }
      await call('POST', `/api/attempts/${a.attemptId}/items/${n}/submit`, 's1', {});
    }
    expect(kinds.size).toBe(3);
    expect(mcs.size).toBe(2);
  });

  it('全對 5 星、全錯 0 星；重考取最高分', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    const good = await playAttempt('s1', id, () => true);
    expect(good.stars).toBe(5);
    expect(good.items.filter((i: any) => i.correct)).toHaveLength(5);
    const bad = await playAttempt('s1', id, () => false);
    expect(bad.stars).toBe(0);
    expect(bad.best).toBe(5);
    const list = (await call('GET', '/api/quizzes', 's1')).body;
    expect(list[0].best).toBe(5);
    expect(list[0].attempts).toBe(2);
  });

  it('地形題「檢查」只能用 1 次', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    const a = (await call('POST', `/api/quizzes/${id}/attempts`, 's1')).body;
    const n = a.items.findIndex((i: any) => i.kind === 'terrain');
    for (let k = 0; k < n; k++) {
      await call('POST', `/api/attempts/${a.attemptId}/items/${k}/open`, 's1');
      await call('POST', `/api/attempts/${a.attemptId}/items/${k}/submit`, 's1', {});
    }
    await call('POST', `/api/attempts/${a.attemptId}/items/${n}/open`, 's1');
    const landform = (await call('GET', `/api/attempts/${a.attemptId}`, 's1')).body.items[n].kind;
    expect(landform).toBe('terrain');
    const opened = await call('POST', `/api/attempts/${a.attemptId}/items/${n}/open`, 's1');
    const terrain = await encodeHeights(WRONG(opened.body.landform));
    const c1 = await call('POST', `/api/attempts/${a.attemptId}/items/${n}/check`, 's1', { terrain });
    expect(c1.status).toBe(200);
    expect(c1.body.hints.length).toBeGreaterThan(0);
    expect((await call('POST', `/api/attempts/${a.attemptId}/items/${n}/check`, 's1', { terrain })).status).toBe(409);
  });

  it('超過時間才提交的答案算錯', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    const a = (await call('POST', `/api/quizzes/${id}/attempts`, 's1')).body;
    const it = (await call('POST', `/api/attempts/${a.attemptId}/items/0/open`, 's1')).body;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000 + 3_500);
    const payload =
      it.kind === 'terrain'
        ? { terrain: await encodeHeights(IDEAL[it.landform]()) }
        : { choice: (it.options as string[]).indexOf(QUESTIONS.find((q) => q.stem === it.stem)!.options[QUESTIONS.find((q) => q.stem === it.stem)!.answer]) };
    const r = await call('POST', `/api/attempts/${a.attemptId}/items/0/submit`, 's1', payload);
    expect(r.body.late).toBe(true);
    vi.restoreAllMocks();
    const fin = await call('POST', `/api/attempts/${a.attemptId}/finish`, 's1');
    expect(fin.body.items[0].correct).toBe(false);
  });

  it('送出超過黏土量的人造地形會被擋下', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    const a = (await call('POST', `/api/quizzes/${id}/attempts`, 's1')).body;
    const n = a.items.findIndex((i: any) => i.kind === 'terrain');
    for (let k = 0; k <= n; k++) {
      await call('POST', `/api/attempts/${a.attemptId}/items/${k}/open`, 's1');
      if (k < n) await call('POST', `/api/attempts/${a.attemptId}/items/${k}/submit`, 's1', {});
    }
    const huge = new Float32Array(N * N).fill(0.9);
    const r = await call('POST', `/api/attempts/${a.attemptId}/items/${n}/submit`, 's1', { terrain: await encodeHeights(huge) });
    expect(r.status).toBe(422);
  });

  it('測驗關閉後不能再作答', async () => {
    const id = await setupClass();
    await teacher('POST', `/api/quizzes/${id}/publish`);
    const a = (await call('POST', `/api/quizzes/${id}/attempts`, 's1')).body;
    await teacher('POST', `/api/quizzes/${id}/close`);
    expect((await call('POST', `/api/attempts/${a.attemptId}/items/0/open`, 's1')).status).toBe(409);
    expect((await call('POST', `/api/quizzes/${id}/attempts`, 's1')).status).toBe(409);
  });
});

describe('分組與結算', () => {
  it('關閉前不能結算；小組平均把沒作答的組員算 0 星', async () => {
    const id = await setupClass('team');
    await teacher('POST', `/api/quizzes/${id}/publish`);
    await playAttempt('s1', id, () => true); // 5 星
    await playAttempt('s2', id, (i) => i < 3); // 最多 3 星（依題序）
    await teacher('PUT', `/api/quizzes/${id}/teams`, { uid: 's1', team: 1 });
    await teacher('PUT', `/api/quizzes/${id}/teams`, { uid: 's3', team: 1 }); // 沒作答
    await teacher('PUT', `/api/quizzes/${id}/teams`, { uid: 's2', team: 2 });
    expect((await teacher('POST', `/api/quizzes/${id}/settle`)).status).toBe(409);
    await teacher('POST', `/api/quizzes/${id}/close`);
    const r = (await teacher('POST', `/api/quizzes/${id}/settle`)).body;
    const t1 = r.teams.find((t: any) => t.team === 1);
    expect(t1.avg).toBe(2.5); // (5 + 0) / 2
    expect(r.unassigned).toBe(0);
    // 結算後不能再改分組
    expect((await teacher('PUT', `/api/quizzes/${id}/teams`, { uid: 's1', team: 2 })).status).toBe(409);
  });

  it('同分並列同名次；沒有組員的組不排名', () => {
    const r = settle('team', 3, [
      { uid: 'a', no: 1, name: 'a', best: 4, attempts: 1, team: 1 },
      { uid: 'b', no: 2, name: 'b', best: 4, attempts: 1, team: 2 },
      { uid: 'c', no: 3, name: 'c', best: 2, attempts: 1, team: null },
    ]);
    expect(r.teams.find((t) => t.team === 1)!.rank).toBe(1);
    expect(r.teams.find((t) => t.team === 2)!.rank).toBe(1);
    expect(r.teams.find((t) => t.team === 3)!.rank).toBeNull();
    expect(r.unassigned).toBe(1);
  });

  it('匯出的 CSV 有 BOM，並防止公式注入', async () => {
    await teacher('PUT', '/api/roster', { students: [{ no: 1, uid: 's1', name: '=HYPERLINK("x")' }] });
    await teacher('PUT', '/api/questions', { questions: QUESTIONS });
    const id = (await teacher('POST', '/api/quizzes', { title: '測驗', mode: 'solo' })).body.id;
    const res = await worker.fetch(
      new Request(`https://api.example/api/quizzes/${id}/export.csv`, { headers: { Authorization: `Bearer ${await token('teacher1', 'admin')}` } }),
      env,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM，Excel 才不會亂碼
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('本機開發用的假身分', () => {
  it('正式環境（沒有 DEV_FAKE_AUTH）不接受假身分', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/me', { headers: { Authorization: 'Bearer dev:t1:admin:%E8%80%81%E5%B8%AB' } }), env);
    expect(res.status).toBe(401);
  });
  it('開了 DEV_FAKE_AUTH 但不是從 localhost 連進來，也不接受', async () => {
    const devEnv = { ...env, DEV_FAKE_AUTH: '1' };
    const res = await worker.fetch(new Request('https://api.example/api/me', { headers: { Authorization: 'Bearer dev:t1:admin:%E8%80%81%E5%B8%AB' } }), devEnv);
    expect(res.status).toBe(401);
    const ok = await worker.fetch(new Request('http://localhost/api/me', { headers: { Authorization: 'Bearer dev:t1:admin:%E8%80%81%E5%B8%AB' } }), devEnv);
    expect(ok.status).toBe(200);
  });
});
