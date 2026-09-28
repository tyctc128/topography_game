import levelsJson from '../../public/config/levels.json';
import terrainJson from '../../public/config/terrain.json';
import { buildStart } from '../../src/clay/startShapes';
import { judge } from '../../src/judge/judge';
import { decodeHeights, encodeMask } from '../../src/shared/heightmap';
import type { Landform, LevelDef, TerrainConfig } from '../../src/types';
import { bearer, verifyToken, type Who } from './auth';
import type { DB } from './db';
import {
  GRACE_MS,
  MC_SECONDS,
  planAttempt,
  settle,
  TERRAIN_SECONDS,
  toCsv,
  type BoardStudent,
} from './logic';

export interface Env {
  DB: DB;
  ALLOWED_ORIGINS: string; // 逗號分隔
  SSO_PROJECT: string;
  /** 只在本機 wrangler dev（.dev.vars）設定；正式環境沒有這個變數。 */
  DEV_FAKE_AUTH?: string;
}

const CLASS = 'main';
const N = 128;
const cfg = terrainJson as TerrainConfig;
const LEVELS = levelsJson as LevelDef[];
const LANDFORM_NAME: Record<string, string> = { plain: '平原', tableland: '台地', hills: '丘陵', mountain: '山地', basin: '盆地' };

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const fail = (status: number, code: string): never => {
  throw new HttpError(status, code);
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function withCors(res: Response, origin: string | null, env: Env): Response {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const h = new Headers(res.headers);
  if (origin && allowed.includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
    h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    h.set('Access-Control-Max-Age', '86400');
  }
  return new Response(res.body, { status: res.status, headers: h });
}

async function body<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 600_000) fail(413, 'too_large');
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return fail(400, 'bad_json');
  }
}

// 起始黏土量 + 黏土罐容量：提交的地形不可能超過這個量（防止送出人造地形）
const MAX_VOLUME: Record<string, number> = {};
for (const lv of LEVELS) {
  const h = buildStart(lv.start, N, cfg.maxElevation);
  MAX_VOLUME[lv.target] = h.reduce((a, b) => a + b, 0) / h.length + lv.budget + 0.003;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin, env);
    let res: Response;
    try {
      res = await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.code }, e.status);
      else {
        console.error(e);
        res = json({ error: 'server_error' }, 500);
      }
    }
    return withCors(res, origin, env);
  },
};

/**
 * 本機開發用的假身分「dev:學號:角色:姓名」：必須同時開了 DEV_FAKE_AUTH 且是從 localhost 連進來，
 * 正式部署沒有 DEV_FAKE_AUTH，一律走 SSO 驗證。
 */
function devIdentity(req: Request, env: Env, token: string): Who | null {
  if (env.DEV_FAKE_AUTH !== '1' || !token.startsWith('dev:')) return null;
  const host = new URL(req.url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return null;
  const [, uid, role, name] = token.split(':');
  return uid ? { uid, role: role || 'student', name: decodeURIComponent(name || uid), no: null } : null;
}

async function authenticate(req: Request, env: Env): Promise<Who> {
  const token = bearer(req);
  if (!token) fail(401, 'missing_token');
  let who: Who;
  const dev = devIdentity(req, env, token!);
  if (dev) who = dev;
  else
    try {
      who = await verifyToken(token!, env.SSO_PROJECT);
    } catch {
      return fail(401, 'invalid_token');
    }
  await env.DB.prepare(
    'INSERT INTO players (uid, name, no, role, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ' +
      'ON CONFLICT(uid) DO UPDATE SET name = excluded.name, no = excluded.no, role = excluded.role, updated_at = excluded.updated_at',
  )
    .bind(who.uid, who.name, who.no, who.role, Date.now())
    .run();
  return who;
}

const isTeacher = (who: Who) => who.role === 'admin';
const requireTeacher = (who: Who) => {
  if (!isTeacher(who)) fail(403, 'teacher_only');
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith('/api/')) return json({ error: 'not_found' }, 404);
  if (p === '/api/health') return json({ ok: true });
  const who = await authenticate(req, env);
  const m = req.method;
  let r: RegExpMatchArray | null;

  if (p === '/api/me' && m === 'GET') return me(env, who);
  if (p === '/api/quizzes' && m === 'GET') return listQuizzes(env, who);
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)\/attempts$/)) && m === 'POST') return startAttempt(env, who, r[1]);
  if ((r = p.match(/^\/api\/attempts\/([\w-]+)$/)) && m === 'GET') return getAttempt(env, who, r[1]);
  if ((r = p.match(/^\/api\/attempts\/([\w-]+)\/items\/(\d)\/(open|check|submit)$/)) && m === 'POST') {
    const [, id, n, action] = r;
    if (action === 'open') return openItem(env, who, id, Number(n));
    if (action === 'check') return checkItem(env, who, id, Number(n), await body(req));
    return submitItem(env, who, id, Number(n), await body(req));
  }
  if ((r = p.match(/^\/api\/attempts\/([\w-]+)\/finish$/)) && m === 'POST') return finishAttempt(env, who, r[1]);

  // ---------- 老師 ----------
  requireTeacher(who);
  if (p === '/api/roster' && m === 'GET') return getRoster(env);
  if (p === '/api/roster' && m === 'PUT') return putRoster(env, await body(req));
  if (p === '/api/questions' && m === 'GET') return getQuestions(env);
  if (p === '/api/questions' && m === 'PUT') return putQuestions(env, await body(req));
  if (p === '/api/quizzes' && m === 'POST') return createQuiz(env, who, await body(req));
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)$/)) && m === 'DELETE') return deleteQuiz(env, r[1]);
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)\/(publish|close|settle)$/)) && m === 'POST') {
    if (r[2] === 'publish') return publishQuiz(env, r[1]);
    if (r[2] === 'close') return closeQuiz(env, r[1]);
    return settleQuiz(env, r[1]);
  }
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)\/board$/)) && m === 'GET') return board(env, r[1]);
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)\/teams$/)) && m === 'PUT') return setTeam(env, r[1], await body(req));
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)\/teams\/copy$/)) && m === 'POST') return copyTeams(env, r[1]);
  if ((r = p.match(/^\/api\/quizzes\/([\w-]+)\/export\.csv$/)) && m === 'GET') return exportCsv(env, r[1]);
  return json({ error: 'not_found' }, 404);
}

// ================= 學生 =================

interface QuizRow {
  id: string;
  title: string;
  mode: 'solo' | 'team';
  team_count: number;
  status: 'draft' | 'published' | 'closed' | 'settled';
  created_at: number;
  published_at: number | null;
  closed_at: number | null;
}

async function rosterEntry(env: Env, uid: string) {
  return env.DB.prepare('SELECT uid, no, name FROM roster WHERE class_id = ?1 AND uid = ?2')
    .bind(CLASS, uid)
    .first<{ uid: string; no: number; name: string }>();
}

async function me(env: Env, who: Who) {
  const r = await rosterEntry(env, who.uid);
  return json({ uid: who.uid, name: r?.name || who.name || who.uid, no: r?.no ?? who.no, role: who.role, inRoster: !!r });
}

async function listQuizzes(env: Env, who: Who) {
  const teacher = isTeacher(who);
  const { results } = await env.DB.prepare(
    `SELECT q.*, (SELECT MAX(stars) FROM attempts a WHERE a.quiz_id = q.id AND a.uid = ?2) AS best,
       (SELECT COUNT(*) FROM attempts a WHERE a.quiz_id = q.id AND a.uid = ?2 AND a.status = 'finished') AS tries,
       (SELECT id FROM attempts a WHERE a.quiz_id = q.id AND a.uid = ?2 AND a.status = 'active') AS active_id,
       (SELECT COUNT(DISTINCT uid) FROM attempts a WHERE a.quiz_id = q.id) AS participants
     FROM quizzes q WHERE q.class_id = ?1 ${teacher ? '' : "AND q.status <> 'draft'"} ORDER BY q.created_at DESC`,
  )
    .bind(CLASS, who.uid)
    .all<QuizRow & { best: number | null; tries: number; active_id: string | null; participants: number }>();
  return json(
    results.map((q) => ({
      id: q.id,
      title: q.title,
      mode: q.mode,
      teamCount: q.team_count,
      status: q.status,
      createdAt: q.created_at,
      publishedAt: q.published_at,
      best: q.best ?? 0,
      attempts: q.tries,
      activeAttempt: q.active_id,
      isNew: q.status === 'published' && q.tries === 0 && !q.active_id,
      participants: teacher ? q.participants : undefined,
    })),
  );
}

interface AttemptRow {
  id: string;
  quiz_id: string;
  uid: string;
  status: 'active' | 'finished';
  stars: number;
}
interface ItemRow {
  attempt_id: string;
  idx: number;
  kind: 'terrain' | 'mc';
  target: string;
  option_order: string | null;
  served_at: number | null;
  deadline: number | null;
  checks_used: number;
  submitted_at: number | null;
  correct: number | null;
  score: number | null;
}

async function getQuiz(env: Env, id: string): Promise<QuizRow> {
  const q = await env.DB.prepare('SELECT * FROM quizzes WHERE id = ?1 AND class_id = ?2').bind(id, CLASS).first<QuizRow>();
  return q ?? fail(404, 'quiz_not_found');
}

async function startAttempt(env: Env, who: Who, quizId: string) {
  const quiz = await getQuiz(env, quizId);
  if (quiz.status !== 'published') fail(409, 'quiz_not_open');
  if (!isTeacher(who) && !(await rosterEntry(env, who.uid))) fail(403, 'not_in_roster');

  const active = await env.DB.prepare("SELECT * FROM attempts WHERE quiz_id = ?1 AND uid = ?2 AND status = 'active'")
    .bind(quizId, who.uid)
    .first<AttemptRow>();
  if (active) return attemptState(env, active);

  const last = await env.DB.prepare(
    "SELECT i.target FROM attempt_items i JOIN attempts a ON a.id = i.attempt_id WHERE a.quiz_id = ?1 AND a.uid = ?2 AND i.kind = 'mc' ORDER BY a.started_at DESC LIMIT 2",
  )
    .bind(quizId, who.uid)
    .all<{ target: string }>();
  const { results: qs } = await env.DB.prepare('SELECT id FROM questions WHERE active = 1').all<{ id: string }>();
  const plan = planAttempt(
    qs.map((q) => q.id),
    new Set(last.results.map((x) => x.target)),
  );
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO attempts (id, quiz_id, uid, started_at) VALUES (?1, ?2, ?3, ?4)').bind(id, quizId, who.uid, Date.now()),
    ...plan.map((it, idx) =>
      env.DB.prepare('INSERT INTO attempt_items (attempt_id, idx, kind, target, option_order) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
        id,
        idx,
        it.kind,
        it.target,
        it.optionOrder ? JSON.stringify(it.optionOrder) : null,
      ),
    ),
  ]);
  return attemptState(env, { id, quiz_id: quizId, uid: who.uid, status: 'active', stars: 0 });
}

async function loadItems(env: Env, attemptId: string): Promise<ItemRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM attempt_items WHERE attempt_id = ?1 ORDER BY idx')
    .bind(attemptId)
    .all<ItemRow>();
  return results;
}

async function attemptState(env: Env, a: AttemptRow) {
  const items = await loadItems(env, a.id);
  const next = items.findIndex((i) => i.submitted_at === null);
  return json({
    attemptId: a.id,
    quizId: a.quiz_id,
    status: a.status,
    total: items.length,
    next: next < 0 ? items.length : next,
    items: items.map((i) => ({ idx: i.idx, kind: i.kind, submitted: i.submitted_at !== null })),
  });
}

async function ownAttempt(env: Env, who: Who, id: string): Promise<AttemptRow> {
  const a = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?1').bind(id).first<AttemptRow>();
  if (!a || a.uid !== who.uid) fail(404, 'attempt_not_found');
  return a!;
}

async function getAttempt(env: Env, who: Who, id: string) {
  return attemptState(env, await ownAttempt(env, who, id));
}

/** 取得作答中的某一題，並檢查作答與測驗都還開著。 */
async function activeItem(env: Env, who: Who, id: string, n: number) {
  const a = await ownAttempt(env, who, id);
  if (a.status !== 'active') fail(409, 'attempt_finished');
  const quiz = await getQuiz(env, a.quiz_id);
  if (quiz.status !== 'published') fail(409, 'quiz_closed');
  const items = await loadItems(env, id);
  const item = items.find((i) => i.idx === n) ?? fail(404, 'item_not_found');
  return { a, items, item: item! };
}

const levelFor = (target: string) => LEVELS.find((l) => l.target === target)!;

async function openItem(env: Env, who: Who, id: string, n: number) {
  const { items, item } = await activeItem(env, who, id, n);
  const next = items.find((i) => i.submitted_at === null);
  if (!next || next.idx !== n) fail(409, 'not_next_item');
  const now = Date.now();
  if (item.served_at === null) {
    const secs = item.kind === 'terrain' ? TERRAIN_SECONDS : MC_SECONDS;
    item.served_at = now;
    item.deadline = now + secs * 1000;
    await env.DB.prepare('UPDATE attempt_items SET served_at = ?1, deadline = ?2 WHERE attempt_id = ?3 AND idx = ?4')
      .bind(item.served_at, item.deadline, id, n)
      .run();
  }
  const remainingMs = Math.max(0, item.deadline! - now);
  if (item.kind === 'terrain') {
    const lv = levelFor(item.target);
    return json({ idx: n, kind: 'terrain', landform: item.target, levelId: lv.id, title: LANDFORM_NAME[item.target], remainingMs, checksLeft: 1 - item.checks_used });
  }
  const q = await env.DB.prepare('SELECT stem, options_json FROM questions WHERE id = ?1')
    .bind(item.target)
    .first<{ stem: string; options_json: string }>();
  if (!q) fail(500, 'question_missing');
  const options = JSON.parse(q!.options_json) as string[];
  const order = JSON.parse(item.option_order!) as number[];
  return json({ idx: n, kind: 'mc', stem: q!.stem, options: order.map((k) => options[k]), remainingMs });
}

function assertServed(item: ItemRow) {
  if (item.served_at === null) fail(409, 'item_not_open');
  if (item.submitted_at !== null) fail(409, 'item_submitted');
}

async function readTerrain(b64: unknown, target: string): Promise<Float32Array> {
  let h: Float32Array;
  try {
    h = await decodeHeights(String(b64 ?? ''), N);
  } catch {
    return fail(400, 'bad_terrain');
  }
  let v = 0;
  for (let i = 0; i < h.length; i++) v += h[i];
  if (v / h.length > MAX_VOLUME[target]) fail(422, 'too_much_clay');
  return h;
}

async function checkItem(env: Env, who: Who, id: string, n: number, b: { terrain?: string }) {
  const { item } = await activeItem(env, who, id, n);
  if (item.kind !== 'terrain') fail(400, 'not_terrain');
  assertServed(item);
  if (Date.now() > item.deadline! + GRACE_MS) fail(409, 'time_up');
  if (item.checks_used >= 1) fail(409, 'no_checks_left');
  const h = await readTerrain(b.terrain, item.target);
  const r = judge(h, N, item.target as Landform, cfg);
  await env.DB.prepare('UPDATE attempt_items SET checks_used = checks_used + 1 WHERE attempt_id = ?1 AND idx = ?2').bind(id, n).run();
  return json({ passed: r.passed, score: r.score, hints: r.hints, mask: encodeMask(r.problemMask), checksLeft: 0 });
}

async function submitItem(env: Env, who: Who, id: string, n: number, b: { terrain?: string; choice?: number | null }) {
  const { a, items, item } = await activeItem(env, who, id, n);
  assertServed(item);
  const now = Date.now();
  const late = now > item.deadline! + GRACE_MS;
  let correct = 0;
  let score: number | null = null;
  let answer: string | null = null;
  let terrain: string | null = null;
  if (item.kind === 'terrain') {
    if (!late && b.terrain) {
      const h = await readTerrain(b.terrain, item.target);
      const r = judge(h, N, item.target as Landform, cfg);
      correct = r.passed ? 1 : 0;
      score = r.score;
      terrain = b.terrain;
    }
  } else {
    const choice = b.choice;
    if (!late && Number.isInteger(choice) && choice! >= 0 && choice! < 4) {
      const order = JSON.parse(item.option_order!) as number[];
      const q = await env.DB.prepare('SELECT answer FROM questions WHERE id = ?1').bind(item.target).first<{ answer: number }>();
      answer = String(order[choice!]);
      correct = q && order[choice!] === q.answer ? 1 : 0;
    }
  }
  const stars = items.reduce((s, i) => s + (i.idx === n ? correct : (i.correct ?? 0)), 0);
  const done = items.every((i) => i.idx === n || i.submitted_at !== null);
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE attempt_items SET submitted_at = ?1, correct = ?2, score = ?3, answer = ?4, terrain = ?5 WHERE attempt_id = ?6 AND idx = ?7',
    ).bind(now, correct, score, answer, terrain, id, n),
    env.DB.prepare(
      `UPDATE attempts SET stars = ?1${done ? ", status = 'finished', finished_at = ?3" : ''} WHERE id = ?2`,
    ).bind(...(done ? [stars, a.id, now] : [stars, a.id])),
  ]);
  return json({ ok: true, late, done });
}

async function finishAttempt(env: Env, who: Who, id: string) {
  const a = await ownAttempt(env, who, id);
  const now = Date.now();
  if (a.status === 'active') {
    // 還沒作答的題目算錯
    await env.DB.batch([
      env.DB.prepare('UPDATE attempt_items SET submitted_at = ?1, correct = 0 WHERE attempt_id = ?2 AND submitted_at IS NULL').bind(now, id),
      env.DB.prepare(
        "UPDATE attempts SET status = 'finished', finished_at = ?1, stars = (SELECT COALESCE(SUM(correct), 0) FROM attempt_items WHERE attempt_id = ?2) WHERE id = ?2",
      ).bind(now, id),
    ]);
  }
  const items = await loadItems(env, id);
  const stars = items.reduce((s, i) => s + (i.correct ?? 0), 0);
  const best = await env.DB.prepare('SELECT MAX(stars) AS best, COUNT(*) AS tries FROM attempts WHERE quiz_id = ?1 AND uid = ?2')
    .bind(a.quiz_id, who.uid)
    .first<{ best: number; tries: number }>();
  const details = [];
  for (const i of items) {
    if (i.kind === 'terrain') details.push({ idx: i.idx, kind: 'terrain', label: `捏地形 · ${LANDFORM_NAME[i.target]}`, correct: !!i.correct });
    else {
      const q = await env.DB.prepare('SELECT stem, options_json, answer, explanation FROM questions WHERE id = ?1')
        .bind(i.target)
        .first<{ stem: string; options_json: string; answer: number; explanation: string }>();
      details.push({
        idx: i.idx,
        kind: 'mc',
        label: `概念題 · ${q?.stem ?? ''}`,
        correct: !!i.correct,
        answer: q ? (JSON.parse(q.options_json) as string[])[q.answer] : '',
        explanation: q?.explanation ?? '',
      });
    }
  }
  return json({ stars, best: best?.best ?? stars, attempts: best?.tries ?? 1, items: details });
}

// ================= 老師 =================

async function getRoster(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT r.uid, r.no, r.name, (SELECT COUNT(*) FROM attempts a WHERE a.uid = r.uid) AS attempts
     FROM roster r WHERE r.class_id = ?1 ORDER BY r.no`,
  )
    .bind(CLASS)
    .all();
  return json(results);
}

async function putRoster(env: Env, b: { students?: { no: unknown; uid: unknown; name: unknown }[] }) {
  const list = Array.isArray(b.students) ? b.students : fail(400, 'bad_roster');
  const rows = list!.map((s) => ({ no: Number(s.no), uid: String(s.uid ?? '').trim(), name: String(s.name ?? '').trim() }));
  const bad = rows.some(
    (r) => !Number.isInteger(r.no) || r.no < 1 || r.no > 999 || !/^[\w.-]{1,40}$/.test(r.uid) || !r.name || r.name.length > 40,
  );
  if (bad || rows.length === 0 || rows.length > 200) fail(400, 'bad_roster');
  if (new Set(rows.map((r) => r.uid)).size !== rows.length || new Set(rows.map((r) => r.no)).size !== rows.length)
    fail(400, 'duplicate_roster');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster WHERE class_id = ?1').bind(CLASS),
    ...rows.map((r) => env.DB.prepare('INSERT INTO roster (class_id, uid, no, name) VALUES (?1, ?2, ?3, ?4)').bind(CLASS, r.uid, r.no, r.name)),
  ]);
  return json({ ok: true, count: rows.length });
}

async function getQuestions(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM questions ORDER BY id').all<{
    id: string;
    stem: string;
    options_json: string;
    answer: number;
    explanation: string;
    active: number;
  }>();
  return json(
    results.map((q) => ({ id: q.id, stem: q.stem, options: JSON.parse(q.options_json), answer: q.answer, explanation: q.explanation, active: !!q.active })),
  );
}

async function putQuestions(env: Env, b: { questions?: unknown[] }) {
  const list = Array.isArray(b.questions) ? b.questions : fail(400, 'bad_questions');
  const rows = (list as { id: unknown; stem: unknown; options: unknown; answer: unknown; explanation?: unknown; active?: unknown }[]).map((q) => ({
    id: String(q.id ?? '').trim(),
    stem: String(q.stem ?? '').trim(),
    options: Array.isArray(q.options) ? q.options.map((o) => String(o).trim()) : [],
    answer: Number(q.answer),
    explanation: String(q.explanation ?? '').trim(),
    active: q.active === false ? 0 : 1,
  }));
  const bad = rows.some(
    (q) =>
      !/^[\w-]{1,20}$/.test(q.id) ||
      !q.stem ||
      q.stem.length > 400 ||
      q.options.length !== 4 ||
      q.options.some((o) => !o || o.length > 200) ||
      !Number.isInteger(q.answer) ||
      q.answer < 0 ||
      q.answer > 3,
  );
  if (bad || rows.length === 0 || rows.length > 500) fail(400, 'bad_questions');
  if (new Set(rows.map((q) => q.id)).size !== rows.length) fail(400, 'duplicate_questions');
  await env.DB.batch([
    // 不在這次清單裡的舊題目停用（不刪除，舊作答紀錄仍看得到題目）
    env.DB.prepare('UPDATE questions SET active = 0'),
    ...rows.map((q) =>
      env.DB.prepare(
        'INSERT INTO questions (id, stem, options_json, answer, explanation, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
          'ON CONFLICT(id) DO UPDATE SET stem = excluded.stem, options_json = excluded.options_json, answer = excluded.answer, explanation = excluded.explanation, active = excluded.active',
      ).bind(q.id, q.stem, JSON.stringify(q.options), q.answer, q.explanation, q.active),
    ),
  ]);
  return json({ ok: true, count: rows.length });
}

async function createQuiz(env: Env, who: Who, b: { title?: unknown; mode?: unknown; teamCount?: unknown }) {
  const title = String(b.title ?? '').trim();
  const mode = b.mode === 'team' ? 'team' : b.mode === 'solo' ? 'solo' : fail(400, 'bad_mode');
  const teamCount = mode === 'team' ? Number(b.teamCount) : 0;
  if (!title || title.length > 40) fail(400, 'bad_title');
  if (mode === 'team' && (!Number.isInteger(teamCount) || teamCount < 2 || teamCount > 12)) fail(400, 'bad_team_count');
  const id = crypto.randomUUID().slice(0, 8);
  await env.DB.prepare('INSERT INTO quizzes (id, class_id, title, mode, team_count, status, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, CLASS, title, mode, teamCount, 'draft', who.uid, Date.now())
    .run();
  return json({ id });
}

async function deleteQuiz(env: Env, id: string) {
  const q = await getQuiz(env, id);
  if (q.status !== 'draft') fail(409, 'only_draft_can_be_deleted');
  await env.DB.batch([env.DB.prepare('DELETE FROM quizzes WHERE id = ?1').bind(id), env.DB.prepare('DELETE FROM team_members WHERE quiz_id = ?1').bind(id)]);
  return json({ ok: true });
}

async function publishQuiz(env: Env, id: string) {
  const q = await getQuiz(env, id);
  if (q.status !== 'draft') fail(409, 'not_draft');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE active = 1').first<{ n: number }>();
  if ((n?.n ?? 0) < 2) fail(409, 'need_questions');
  await env.DB.prepare("UPDATE quizzes SET status = 'published', published_at = ?1 WHERE id = ?2").bind(Date.now(), id).run();
  return json({ ok: true });
}

async function closeQuiz(env: Env, id: string) {
  const q = await getQuiz(env, id);
  if (q.status !== 'published') fail(409, 'not_published');
  const now = Date.now();
  // 關閉時作答中的學生：已提交的題目算數，其餘算錯
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE attempt_items SET submitted_at = ?1, correct = 0 WHERE submitted_at IS NULL AND attempt_id IN (SELECT id FROM attempts WHERE quiz_id = ?2 AND status = 'active')",
    ).bind(now, id),
    env.DB.prepare(
      "UPDATE attempts SET status = 'finished', finished_at = ?1, stars = (SELECT COALESCE(SUM(correct), 0) FROM attempt_items WHERE attempt_id = attempts.id) WHERE quiz_id = ?2 AND status = 'active'",
    ).bind(now, id),
    env.DB.prepare("UPDATE quizzes SET status = 'closed', closed_at = ?1 WHERE id = ?2").bind(now, id),
  ]);
  return json({ ok: true });
}

async function boardStudents(env: Env, quizId: string): Promise<(BoardStudent & { lastAt: number | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.uid, r.no, r.name,
       (SELECT MAX(stars) FROM attempts a WHERE a.quiz_id = ?1 AND a.uid = r.uid) AS best,
       (SELECT COUNT(*) FROM attempts a WHERE a.quiz_id = ?1 AND a.uid = r.uid AND a.status = 'finished') AS tries,
       (SELECT MAX(COALESCE(finished_at, started_at)) FROM attempts a WHERE a.quiz_id = ?1 AND a.uid = r.uid) AS last_at,
       (SELECT team_no FROM team_members t WHERE t.quiz_id = ?1 AND t.uid = r.uid) AS team
     FROM roster r WHERE r.class_id = ?2 ORDER BY r.no`,
  )
    .bind(quizId, CLASS)
    .all<{ uid: string; no: number; name: string; best: number | null; tries: number; last_at: number | null; team: number | null }>();
  return results.map((s) => ({ uid: s.uid, no: s.no, name: s.name, best: s.best ?? 0, attempts: s.tries, team: s.team, lastAt: s.last_at }));
}

function quizJson(q: QuizRow) {
  return { id: q.id, title: q.title, mode: q.mode, teamCount: q.team_count, status: q.status, createdAt: q.created_at };
}

async function board(env: Env, id: string) {
  const q = await getQuiz(env, id);
  const students = await boardStudents(env, id);
  const s = await env.DB.prepare('SELECT result_json FROM settlements WHERE quiz_id = ?1').bind(id).first<{ result_json: string }>();
  return json({ quiz: quizJson(q), students, settlement: s ? JSON.parse(s.result_json) : null });
}

async function setTeam(env: Env, id: string, b: { uid?: unknown; team?: unknown }) {
  const q = await getQuiz(env, id);
  if (q.mode !== 'team') fail(409, 'not_team_mode');
  if (q.status === 'settled') fail(409, 'already_settled');
  const uid = String(b.uid ?? '');
  if (!(await rosterEntry(env, uid))) fail(404, 'student_not_found');
  if (b.team === null || b.team === 0) {
    await env.DB.prepare('DELETE FROM team_members WHERE quiz_id = ?1 AND uid = ?2').bind(id, uid).run();
  } else {
    const team = Number(b.team);
    if (!Number.isInteger(team) || team < 1 || team > q.team_count) fail(400, 'bad_team');
    await env.DB.prepare('INSERT INTO team_members (quiz_id, uid, team_no) VALUES (?1, ?2, ?3) ON CONFLICT(quiz_id, uid) DO UPDATE SET team_no = excluded.team_no')
      .bind(id, uid, team)
      .run();
  }
  return json({ ok: true });
}

async function copyTeams(env: Env, id: string) {
  const q = await getQuiz(env, id);
  if (q.mode !== 'team') fail(409, 'not_team_mode');
  if (q.status === 'settled') fail(409, 'already_settled');
  const prev = await env.DB.prepare(
    "SELECT q.id FROM quizzes q WHERE q.class_id = ?1 AND q.mode = 'team' AND q.id <> ?2 AND EXISTS (SELECT 1 FROM team_members t WHERE t.quiz_id = q.id) ORDER BY q.created_at DESC LIMIT 1",
  )
    .bind(CLASS, id)
    .first<{ id: string }>();
  if (!prev) fail(404, 'no_previous_teams');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM team_members WHERE quiz_id = ?1').bind(id),
    env.DB.prepare(
      'INSERT INTO team_members (quiz_id, uid, team_no) SELECT ?1, t.uid, t.team_no FROM team_members t JOIN roster r ON r.uid = t.uid AND r.class_id = ?3 WHERE t.quiz_id = ?2 AND t.team_no <= ?4',
    ).bind(id, prev!.id, CLASS, q.team_count),
  ]);
  return json({ ok: true, from: prev!.id });
}

async function settleQuiz(env: Env, id: string) {
  const q = await getQuiz(env, id);
  if (q.status === 'settled') {
    const s = await env.DB.prepare('SELECT result_json FROM settlements WHERE quiz_id = ?1').bind(id).first<{ result_json: string }>();
    return json(JSON.parse(s!.result_json));
  }
  if (q.status !== 'closed') fail(409, 'close_first');
  const result = settle(q.mode, q.team_count, await boardStudents(env, id));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO settlements (quiz_id, result_json, settled_at) VALUES (?1, ?2, ?3)').bind(id, JSON.stringify(result), now),
    env.DB.prepare("UPDATE quizzes SET status = 'settled', settled_at = ?1 WHERE id = ?2").bind(now, id),
  ]);
  return json(result);
}

async function exportCsv(env: Env, id: string) {
  const q = await getQuiz(env, id);
  const students = await boardStudents(env, id);
  const fmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short', hour12: false });
  const rows = [
    ['座號', '姓名', '帳號', '組別', '最高星數', '作答次數', '最後作答時間'],
    ...students.map((s) => [
      s.no,
      s.name,
      s.uid,
      q.mode === 'team' ? (s.team ? `第 ${s.team} 組` : '未分組') : '',
      s.best,
      s.attempts,
      s.lastAt ? fmt.format(new Date(s.lastAt)) : '',
    ]),
  ];
  return new Response(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(q.title)}.csv`,
    },
  });
}
