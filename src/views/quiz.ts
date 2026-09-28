import { api, ApiError, errorText } from '../api/client';
import type { AppContext, View } from '../app';
import { callbackError, getProfile, login, logout } from '../auth/sso';
import { decodeMask, encodeHeights } from '../shared/heightmap';
import { closeModal, esc, isModalOpen, modal, stars, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { Workbench, workbenchMarkup } from './workbench';

interface Me {
  uid: string;
  name: string;
  no: number | null;
  role: string;
  inRoster: boolean;
}
interface QuizCard {
  id: string;
  title: string;
  mode: 'solo' | 'team';
  status: 'draft' | 'published' | 'closed' | 'settled';
  publishedAt: number | null;
  createdAt: number;
  best: number;
  attempts: number;
  activeAttempt: string | null;
  isNew: boolean;
}
interface AttemptState {
  attemptId: string;
  quizId: string;
  total: number;
  next: number;
  items: { idx: number; kind: 'terrain' | 'mc'; submitted: boolean }[];
}
type ItemPayload =
  | { idx: number; kind: 'terrain'; landform: string; levelId: string; title: string; remainingMs: number; checksLeft: number }
  | { idx: number; kind: 'mc'; stem: string; options: string[]; remainingMs: number };
interface FinishResult {
  stars: number;
  best: number;
  attempts: number;
  items: { idx: number; kind: string; label: string; correct: boolean; answer?: string; explanation?: string }[];
}

const dateText = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '');

/** 班級測驗（學生端）：所有題目、答案、時間與分數都以伺服器為準。 */
export class QuizView implements View {
  private main!: HTMLElement;
  private me: Me | null = null;
  private attempt: AttemptState | null = null;
  private item: ItemPayload | null = null;
  private wb: Workbench | null = null;
  private timer = 0;
  private deadline = 0;
  private lastSecond = -1;
  private busy = false;
  private selected: number | null = null;
  private alive = true;

  constructor(private ctx: AppContext) {}

  mount(main: HTMLElement): void {
    this.main = main;
    void this.boot();
  }

  unmount(): void {
    this.alive = false;
    this.stopTimer();
    this.wb?.destroy();
    this.wb = null;
  }

  async canLeave(): Promise<boolean> {
    if (!this.attempt || !this.item) return true;
    const v = await modal('離開這次挑戰？', '<p>離開後這次作答會直接結算，還沒作答的題目算錯。之後可以再挑戰一次，成績取最高分。</p>', [
      { label: '繼續作答', value: 'stay' },
      { label: '離開測驗', primary: true, value: 'leave' },
    ]);
    if (v !== 'leave') return false;
    this.stopTimer();
    await api.post(`/api/attempts/${this.attempt.attemptId}/finish`).catch(() => undefined);
    this.attempt = null;
    this.item = null;
    return true;
  }

  // ---------- 登入與測驗列表 ----------

  private header(eyebrow: string, title: string, sub: string, right = ''): string {
    return `<div class="title-row"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${sub}</p></div>${right}</div>`;
  }

  private async boot(): Promise<void> {
    this.main.innerHTML = `${this.header('A LITTLE CHALLENGE, A BIG DISCOVERY', '和全班一起，挑戰地形！', '每一次挑戰，都是一次進步。')}<section class="card login-card"><div class="login-icon">${icon('lock')}</div><h2>正在確認學校身分…</h2></section>`;
    let err: string | null = null;
    let profile = null;
    try {
      err = await callbackError();
      profile = await getProfile();
    } catch {
      err = 'sso_unavailable';
    }
    if (!this.alive) return;
    if (!profile) return this.renderLogin(err);
    try {
      this.me = await api.get<Me>('/api/me');
    } catch (e) {
      return this.renderError(e);
    }
    this.ctx.setUser({ name: this.me.name, detail: this.me.no ? `${String(this.me.no).padStart(2, '0')} 號` : undefined });
    if (!this.me.inRoster && this.me.role !== 'admin') return this.renderNoRoster();
    await this.loadList();
  }

  private renderLogin(err: string | null): void {
    this.main.innerHTML = `${this.header('A LITTLE CHALLENGE, A BIG DISCOVERY', '和全班一起，挑戰地形！', '每一次挑戰，都是一次進步。')}
<section class="card login-card"><div class="login-icon">${icon('trophy')}</div><h2>準備好收集星星了嗎？</h2><p>用學校帳號登入，就能看到老師發布的測驗。<br>5 道小挑戰，最高可以得到 5 顆星！</p><div class="stars" style="font-size:27px;margin:23px 0">☆ ☆ ☆ ☆ ☆</div>
${err ? `<p class="form-error">${err === 'sso_unavailable' ? '學校登入系統暫時連不上，請稍後再試。' : '登入沒有成功，請再試一次。'}</p>` : ''}
<button class="primary" data-act="login">${icon('lock')}用學校帳號登入</button><p style="font-size:12px">只會用到你的學號、姓名和座號。</p><button class="secondary" data-act="practice">先去自由練習</button></section>`;
    this.main.querySelector('[data-act=login]')!.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('view', 'quiz');
      void login(url.toString());
    });
    this.main.querySelector('[data-act=practice]')!.addEventListener('click', () => this.ctx.nav('practice'));
  }

  private renderNoRoster(): void {
    this.main.innerHTML = `${this.header('ALMOST THERE', '老師還沒把你加入這個班級', '請告訴老師你的學號，老師加入名單後就能作答。')}
<section class="card login-card"><div class="login-icon">${icon('users')}</div><h2>${esc(this.me!.name)}（${esc(this.me!.uid)}）</h2><p>你已經登入，但不在這個班級的名單上。</p><button class="primary" data-act="practice">先去自由練習</button><button class="secondary" data-act="relogin">換一個帳號登入</button></section>`;
    this.main.querySelector('[data-act=practice]')!.addEventListener('click', () => this.ctx.nav('practice'));
    this.main.querySelector('[data-act=relogin]')!.addEventListener('click', () => this.relogin());
  }

  private async relogin(): Promise<void> {
    await logout();
    const url = new URL(location.href);
    url.searchParams.set('view', 'quiz');
    await login(url.toString());
  }

  private renderError(e: unknown): void {
    const expired = e instanceof ApiError && e.status === 401;
    this.main.innerHTML = `${this.header('OOPS', '暫時連不上測驗', esc(errorText(e)))}<section class="card login-card"><div class="login-icon">${icon('clock')}</div><h2>${esc(errorText(e))}</h2><button class="primary" data-act="retry">${expired ? '重新登入' : '再試一次'}</button><button class="secondary" data-act="practice">先去自由練習</button></section>`;
    this.main.querySelector('[data-act=retry]')!.addEventListener('click', () => (expired ? void this.relogin() : void this.boot()));
    this.main.querySelector('[data-act=practice]')!.addEventListener('click', () => this.ctx.nav('practice'));
  }

  private async loadList(): Promise<void> {
    this.attempt = null;
    this.item = null;
    this.wb?.destroy();
    this.wb = null;
    let quizzes: QuizCard[];
    try {
      quizzes = await api.get<QuizCard[]>('/api/quizzes');
    } catch (e) {
      return this.renderError(e);
    }
    if (!this.alive) return;
    const me = this.me!;
    const first = me.name.slice(-2) || me.uid;
    const newCount = quizzes.filter((q) => q.isNew).length;
    this.main.innerHTML = `${this.header(
      'YOUR NEXT ADVENTURE',
      `${esc(first)}，來挑戰看看吧！`,
      `${me.no ? `${String(me.no).padStart(2, '0')} 號 · ` : ''}取最高星數，每次挑戰都算數。`,
      `<button class="badge" data-act="logout">${icon('logout')}登出</button>`,
    )}
${newCount ? `<div class="new-banner">${icon('trophy')}<span>老師發布了 <strong>${newCount}</strong> 份新測驗！</span></div>` : ''}
${
  quizzes.length
    ? `<div class="cards-grid">${quizzes.map((q) => this.cardHtml(q)).join('')}</div>`
    : `<section class="card empty"><div class="login-icon">${icon('leaf')}</div><h2>老師還沒發布新測驗</h2><p>先去練習捏地形吧！</p><button class="primary" data-act="practice">去自由練習</button></section>`
}`;
    this.main.querySelector('[data-act=logout]')!.addEventListener('click', async () => {
      await logout();
      this.ctx.setUser(null);
      this.renderLogin(null);
    });
    this.main.querySelector('[data-act=practice]')?.addEventListener('click', () => this.ctx.nav('practice'));
    this.main.querySelectorAll<HTMLButtonElement>('[data-start]').forEach((b) => b.addEventListener('click', () => void this.start(b.dataset.start!)));
  }

  private cardHtml(q: QuizCard): string {
    const open = q.status === 'published';
    const pill = open
      ? q.activeAttempt
        ? '<span class="pill gold">作答中</span>'
        : q.isNew
          ? '<span class="pill gold">新測驗</span>'
          : '<span class="pill">進行中</span>'
      : `<span class="pill gray">${q.status === 'settled' ? '已關閉 · 已結算' : '已關閉'}</span>`;
    const label = q.activeAttempt ? '繼續作答' : q.attempts ? '再挑戰一次' : '開始挑戰';
    return `<section class="card"><div class="card-row">${pill}<span class="card-date">${dateText(q.publishedAt ?? q.createdAt)}</span></div>
<h2>${esc(q.title)}</h2><p>捏地形 3 題 ＋ 概念題 2 題<br>地形每題 60 秒 · 概念每題 30 秒</p><div class="rule-line"></div>
<div class="card-row"><span class="card-meta">${open ? '目前最佳紀錄' : '最終成績'}${q.attempts ? ` · 已挑戰 ${q.attempts} 次` : ''}</span><strong class="stars">${stars(q.best)}</strong></div>
${
  open
    ? `<button class="primary" data-start="${esc(q.id)}">${label} ${icon('arrow')}</button>`
    : `<button class="secondary" disabled>測驗已關閉 ${icon('lock')}</button>`
}</section>`;
  }

  // ---------- 作答 ----------

  private async start(quizId: string): Promise<void> {
    this.ctx.audio.unlock();
    try {
      this.attempt = await api.post<AttemptState>(`/api/quizzes/${quizId}/attempts`);
    } catch (e) {
      toast(errorText(e), 4000);
      return void this.loadList();
    }
    await this.nextItem();
  }

  private async nextItem(): Promise<void> {
    const a = this.attempt!;
    if (a.next >= a.total) return this.finish();
    let payload: ItemPayload;
    try {
      payload = await api.post<ItemPayload>(`/api/attempts/${a.attemptId}/items/${a.next}/open`);
    } catch (e) {
      return this.onAttemptError(e);
    }
    if (!this.alive) return;
    this.item = payload;
    this.selected = null;
    this.busy = false;
    if (payload.kind === 'terrain') this.renderTerrain(payload);
    else this.renderChoice(payload);
    this.startTimer(payload.remainingMs);
  }

  private stepTrack(): string {
    const a = this.attempt!;
    return `<div class="step-track" aria-label="第 ${a.next + 1} 題，共 ${a.total} 題">${Array.from(
      { length: a.total },
      (_, i) => `<span class="${i <= a.next ? 'current' : ''}"></span>`,
    ).join('')}</div>`;
  }

  private timerHtml(ms: number): string {
    return `<div class="timer" data-role="timer" role="timer" aria-live="off">${Math.ceil(ms / 1000)} 秒</div>`;
  }

  private renderTerrain(p: Extract<ItemPayload, { kind: 'terrain' }>): void {
    this.wb?.destroy();
    const level = this.ctx.levels.find((l) => l.id === p.levelId)!;
    const n = this.attempt!.next;
    this.main.innerHTML = `${this.header('CLASS CHALLENGE', `第 ${n + 1} 題 · 捏出${esc(p.title)}`, '仔細觀察地形特徵，完成後記得提交答案。', this.timerHtml(p.remainingMs))}
<div class="step-row">${this.stepTrack()}</div>
<div data-role="bench">${workbenchMarkup(level, this.ctx.cfg, {
      exam: true,
      footerHtml: `<button class="primary" data-act="check" ${p.checksLeft < 1 ? 'disabled' : ''}>${icon('check')}${p.checksLeft < 1 ? '已使用檢查' : '檢查地形 · 剩 1 次'}</button><button class="secondary wide" data-act="submit">提交這一題 ${icon('arrow')}</button><div class="small-note">檢查會給提示，完成後仍要按「提交」</div>`,
    })}</div>
<div class="underbar"><span>${icon('clock')}每題獨立計時，時間到會自動提交。</span></div>`;
    const bench = this.main.querySelector('[data-role=bench]') as HTMLElement;
    this.wb = new Workbench(bench, this.ctx.cfg, this.ctx.audio, level);
    bench.querySelector('[data-act=check]')!.addEventListener('click', () => void this.check());
    bench.querySelector('[data-act=submit]')!.addEventListener('click', () => void this.submit(false));
    window.scrollTo(0, 0);
  }

  private renderChoice(p: Extract<ItemPayload, { kind: 'mc' }>): void {
    this.wb?.destroy();
    this.wb = null;
    const n = this.attempt!.next;
    this.main.innerHTML = `<div class="exam-layout">${this.header('CLASS CHALLENGE', `第 ${n + 1} 題 · 地形小知識`, '選出你認為最適合的答案。', this.timerHtml(p.remainingMs))}
${this.stepTrack()}
<section class="question-card"><span class="pill">概念選擇題</span><h2>${esc(p.stem)}</h2><div class="options">${p.options
      .map((o, i) => `<button class="option" data-opt="${i}" aria-pressed="false"><b>${String.fromCharCode(65 + i)}</b>${esc(o)}</button>`)
      .join('')}</div><button class="primary" data-act="submit" disabled>確定答案 ${icon('arrow')}</button><p class="small-note" style="text-align:left;margin-top:18px">送出後就不能修改了，想好再按喔。</p></section></div>`;
    this.main.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) =>
      b.addEventListener('click', () => {
        if (this.busy) return;
        this.selected = Number(b.dataset.opt);
        this.main.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((x) => {
          const on = x === b;
          x.classList.toggle('selected', on);
          x.setAttribute('aria-pressed', String(on));
        });
        (this.main.querySelector('[data-act=submit]') as HTMLButtonElement).disabled = false;
      }),
    );
    this.main.querySelector('[data-act=submit]')!.addEventListener('click', () => void this.submit(false));
    window.scrollTo(0, 0);
  }

  private startTimer(remainingMs: number): void {
    this.stopTimer();
    this.deadline = performance.now() + remainingMs;
    this.lastSecond = -1;
    const tick = () => {
      const left = Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000));
      const el = this.main.querySelector('[data-role=timer]');
      if (el) {
        el.textContent = `${left} 秒`;
        el.classList.toggle('urgent', left <= 10);
      }
      if (left !== this.lastSecond && left <= 10) {
        // 最後 10 秒每秒嗶一聲，最後 3 秒音調變高，時間到長音
        if (left === 0) this.ctx.audio.beep(330, 0.6);
        else this.ctx.audio.beep(left <= 3 ? 990 : 760, 0.08);
      }
      this.lastSecond = left;
      if (left === 0) {
        this.stopTimer();
        if (isModalOpen()) closeModal();
        toast('時間到，這一題已自動提交。');
        void this.submit(true);
      }
    };
    tick();
    this.timer = window.setInterval(tick, 200);
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = 0;
  }

  private async check(): Promise<void> {
    const p = this.item;
    if (!p || p.kind !== 'terrain' || p.checksLeft < 1 || this.busy) return;
    const btn = this.main.querySelector('[data-act=check]') as HTMLButtonElement;
    btn.disabled = true;
    p.checksLeft = 0;
    try {
      const r = await api.post<{ passed: boolean; score: number; hints: string[]; mask: string }>(
        `/api/attempts/${this.attempt!.attemptId}/items/${p.idx}/check`,
        { terrain: await encodeHeights(this.wb!.board.heights()) },
      );
      btn.innerHTML = `${icon('check')}已使用檢查`;
      const board = this.wb!.board;
      board.clay.mask.set(decodeMask(r.mask, board.clay.mask.length));
      board.clay.version++;
      this.ctx.audio.play(r.passed ? 'pass' : 'fail');
      void modal(
        r.passed ? '方向很棒，記得按提交！' : '再觀察一下地形',
        r.passed
          ? '<p>目前的地形符合條件了。倒數還在繼續，完成後請按「提交這一題」。</p>'
          : `<ul class="hint-list">${r.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul><p class="small-note">土盤上閃紅色的地方需要再調整。倒數還在繼續喔！</p>`,
        [{ label: '繼續捏', primary: true, value: 'ok' }],
      );
    } catch (e) {
      toast(errorText(e), 4000);
      if (e instanceof ApiError && e.code !== 'no_checks_left') return this.onAttemptError(e);
    }
  }

  private async submit(auto: boolean): Promise<void> {
    const p = this.item;
    const a = this.attempt;
    if (!p || !a || this.busy) return;
    if (!auto && p.kind === 'mc' && this.selected === null) return;
    this.busy = true;
    this.stopTimer();
    if (this.wb) this.wb.board.locked = true;
    this.main.querySelectorAll<HTMLButtonElement>('[data-act=submit],[data-act=check]').forEach((b) => (b.disabled = true));
    try {
      const payload =
        p.kind === 'terrain' ? { terrain: await encodeHeights(this.wb!.board.heights()) } : { choice: this.selected };
      await api.post(`/api/attempts/${a.attemptId}/items/${p.idx}/submit`, payload);
      this.ctx.audio.play('click');
      a.next = p.idx + 1;
      this.item = null;
      await this.nextItem();
    } catch (e) {
      this.onAttemptError(e);
    }
  }

  private async onAttemptError(e: unknown): Promise<void> {
    if (e instanceof ApiError && ['quiz_closed', 'attempt_finished', 'item_submitted', 'not_next_item'].includes(e.code)) {
      // 伺服器狀態為準：重新取得作答進度
      if (e.code === 'quiz_closed') {
        this.stopTimer();
        await modal('測驗已關閉', '<p>老師已經關閉這份測驗，已提交的題目都有保存。</p>');
        return this.loadList();
      }
      try {
        this.attempt = await api.get<AttemptState>(`/api/attempts/${this.attempt!.attemptId}`);
        return this.nextItem();
      } catch {
        return this.loadList();
      }
    }
    // 網路問題：保留地形，讓孩子可以再按一次
    this.busy = false;
    if (this.wb) this.wb.board.locked = false;
    this.main.querySelectorAll<HTMLButtonElement>('[data-act=submit]').forEach((b) => (b.disabled = false));
    toast(`${errorText(e)}（地形還在，可以再按一次提交）`, 5000);
  }

  private async finish(): Promise<void> {
    const a = this.attempt!;
    this.stopTimer();
    let r: FinishResult;
    try {
      r = await api.post<FinishResult>(`/api/attempts/${a.attemptId}/finish`);
    } catch (e) {
      toast(errorText(e), 4000);
      return this.loadList();
    }
    this.wb?.destroy();
    this.wb = null;
    const quizId = a.quizId;
    this.attempt = null;
    this.ctx.audio.play(r.stars >= 3 ? 'pass' : 'click');
    this.ctx.audio.speak(`挑戰完成！你得到 ${r.stars} 顆星`);
    this.main.innerHTML = `<div class="exam-layout">${this.header('EVERY TRY HELPS YOU GROW', '挑戰完成，做得好！', '看看這次的發現，下次還可以更進步。', `<span class="badge">第 ${r.attempts} 次挑戰</span>`)}
<div class="card"><div class="result-score">${r.stars}<span class="result-total"> / 5</span></div><div class="stars result-stars">${stars(r.stars)}</div>
<p class="result-best">目前最佳紀錄 <strong>${r.best} 顆星</strong>${r.stars === r.best ? ' · 這次也是你的最佳表現！' : ''}</p>
<div class="result-list">${r.items
      .map(
        (it, i) => `<div class="result-item"><span>${i + 1}. ${esc(it.label)}${
          it.kind === 'mc' && !it.correct ? `<br><small class="result-explain">正確答案：${esc(it.answer)}${it.explanation ? ` · ${esc(it.explanation)}` : ''}</small>` : ''
        }</span><strong class="${it.correct ? 'ok' : 'retry'}">${it.correct ? '★ 答對' : '再練習'}</strong></div>`,
      )
      .join('')}</div>
<div class="dialog-actions"><button class="secondary" data-act="list">回測驗首頁</button><button class="primary" data-act="again">再挑戰一次 ${icon('rotate')}</button></div></div></div>`;
    this.main.querySelector('[data-act=list]')!.addEventListener('click', () => void this.loadList());
    this.main.querySelector('[data-act=again]')!.addEventListener('click', () => void this.start(quizId));
    window.scrollTo(0, 0);
  }
}
