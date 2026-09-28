import { readSheet } from 'read-excel-file/browser';
import type { Settlement } from '../../worker/src/logic';
import { api, errorText } from '../api/client';
import type { AppContext, View } from '../app';
import { getProfile, login, logout } from '../auth/sso';
import { $, esc, isModalOpen, modal, stars, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { animateReveal, revealHtml } from './reveal';

type Tab = 'tests' | 'roster' | 'questions' | 'board';
type Status = 'draft' | 'published' | 'closed' | 'settled';

interface Quiz {
  id: string;
  title: string;
  mode: 'solo' | 'team';
  teamCount: number;
  status: Status;
  createdAt: number;
  participants?: number;
}
interface Student {
  uid: string;
  no: number;
  name: string;
  best: number;
  attempts: number;
  team: number | null;
  lastAt: number | null;
}
interface Board {
  quiz: Quiz;
  students: Student[];
  settlement: Settlement | null;
}
interface RosterRow {
  uid: string;
  no: number;
  name: string;
  attempts: number;
}
interface Question {
  id: string;
  stem: string;
  options: string[];
  answer: number;
  explanation: string;
  active: boolean;
}

const STATUS_TEXT: Record<Status, string> = { draft: '草稿', published: '已發布', closed: '已關閉', settled: '已結算' };
const STATUS_PILL: Record<Status, string> = { draft: 'gray', published: 'gold', closed: '', settled: '' };
const POLL_MS = 5000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const avgOf = (list: Student[]) => (list.length ? Math.round((list.reduce((s, x) => s + x.best, 0) / list.length) * 10) / 10 : 0);
const date = (ms: number) => new Date(ms).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });

/** 老師後台：只有 SSO 角色 admin（老師）能用，資料都來自伺服器。 */
export class TeacherView implements View {
  private main!: HTMLElement;
  private tab: Tab = 'tests';
  private quizzes: Quiz[] = [];
  private roster: RosterRow[] = [];
  private questions: Question[] = [];
  private board: Board | null = null;
  private boardId: string | null = null;
  private latestBoard: Board | null = null;
  private showReveal = false;
  private poll = 0;
  private dragging = false;
  private alive = true;

  constructor(private ctx: AppContext) {}

  mount(main: HTMLElement): void {
    this.main = main;
    void this.boot();
  }

  unmount(): void {
    this.alive = false;
    clearInterval(this.poll);
  }

  // ---------- 登入 ----------

  private async boot(): Promise<void> {
    this.main.innerHTML = this.header('老師的地形工作室', '正在確認學校身分…');
    let profile = null;
    try {
      profile = await getProfile();
    } catch {
      /* 統一登入頁連不上：當作未登入 */
    }
    if (!this.alive) return;
    if (!profile) return this.renderLogin();
    if (profile.role !== 'admin') return this.renderForbidden(profile.name);
    this.ctx.setUser({ name: profile.name || profile.account, detail: '老師' });
    await this.refreshAll();
    this.render();
    this.poll = window.setInterval(() => void this.pollBoard(), POLL_MS);
  }

  private renderLogin(): void {
    this.main.innerHTML = `${this.header('老師的地形工作室', '建立測驗、管理名單、計分與結算。')}
<section class="card login-card"><div class="login-icon">${icon('grid')}</div><h2>老師請用學校帳號登入</h2><p>只有老師帳號可以進入後台。</p><button class="primary" data-act="login">${icon('lock')}用學校帳號登入</button><button class="secondary" data-act="practice">回自由練習</button></section>`;
    this.main.querySelector('[data-act=login]')!.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('view', 'teacher');
      void login(url.toString());
    });
    this.main.querySelector('[data-act=practice]')!.addEventListener('click', () => this.ctx.nav('practice'));
  }

  private renderForbidden(name: string): void {
    this.main.innerHTML = `${this.header('老師的地形工作室', '這裡是老師專用的頁面。')}
<section class="card login-card"><div class="login-icon">${icon('lock')}</div><h2>${esc(name)}，這裡只有老師能進來</h2><p>要作答請到「班級測驗」。</p><button class="primary" data-act="quiz">去班級測驗</button><button class="secondary" data-act="relogin">換老師帳號登入</button></section>`;
    this.main.querySelector('[data-act=quiz]')!.addEventListener('click', () => this.ctx.nav('quiz'));
    this.main.querySelector('[data-act=relogin]')!.addEventListener('click', async () => {
      await logout();
      const url = new URL(location.href);
      url.searchParams.set('view', 'teacher');
      void login(url.toString());
    });
  }

  // ---------- 資料 ----------

  private async refreshAll(): Promise<void> {
    try {
      [this.quizzes, this.roster, this.questions] = await Promise.all([
        api.get<Quiz[]>('/api/quizzes'),
        api.get<RosterRow[]>('/api/roster'),
        api.get<Question[]>('/api/questions'),
      ]);
      const latest = this.quizzes.find((q) => q.status !== 'draft');
      this.latestBoard = latest ? await api.get<Board>(`/api/quizzes/${latest.id}/board`) : null;
      if (this.boardId) this.board = await api.get<Board>(`/api/quizzes/${this.boardId}/board`);
    } catch (e) {
      toast(errorText(e), 5000);
    }
  }

  private async pollBoard(): Promise<void> {
    if (!this.alive || this.tab !== 'board' || !this.boardId || this.dragging || this.showReveal || isModalOpen()) return;
    if (this.board?.quiz.status !== 'published') return;
    try {
      this.board = await api.get<Board>(`/api/quizzes/${this.boardId}/board`);
      if (!this.dragging && !isModalOpen()) this.renderBody();
    } catch {
      /* 下一次再試 */
    }
  }

  // ---------- 畫面 ----------

  private header(title: string, sub: string, right = ''): string {
    return `<div class="title-row"><div><div class="eyebrow">TEACHER’S WORKSPACE</div><h1>${esc(title)}</h1><p>${sub}</p></div>${right}</div>`;
  }

  private render(): void {
    const onBoard = this.tab === 'board' && this.board;
    const right = onBoard
      ? '<button class="secondary" data-act="back">← 返回測驗管理</button>'
      : `<button class="primary" data-act="create">${icon('plus')}建立測驗</button>`;
    this.main.innerHTML = `${this.header(onBoard ? this.board!.quiz.title : '老師的地形工作室', `${this.roster.length} 位學生${onBoard ? ` · ${this.board!.quiz.mode === 'team' ? `分組賽 · ${this.board!.quiz.teamCount} 組` : '個人賽'}` : ''}`, right)}
<nav class="teacher-nav">${(
      [
        ['tests', '測驗管理'],
        ['roster', '班級名單'],
        ['questions', '概念題題庫'],
        ['board', '計分面板'],
      ] as [Tab, string][]
    )
      .map(([k, t]) => `<button class="${this.tab === k ? 'active' : ''}" data-tab="${k}">${t}</button>`)
      .join('')}</nav><div data-role="body"></div>`;
    this.main.querySelector('[data-act=back]')?.addEventListener('click', () => this.setTab('tests'));
    this.main.querySelector('[data-act=create]')?.addEventListener('click', () => void this.createQuiz());
    this.main.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab as Tab)));
    this.renderBody();
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.showReveal = false;
    if (t === 'board' && !this.boardId) {
      const q = this.quizzes.find((x) => x.status !== 'draft') ?? this.quizzes[0];
      if (q) return void this.openBoard(q.id);
    }
    this.render();
  }

  private renderBody(): void {
    const body = this.main.querySelector('[data-role=body]') as HTMLElement | null;
    if (!body) return;
    if (this.tab === 'tests') body.innerHTML = this.testsHtml();
    else if (this.tab === 'roster') body.innerHTML = this.rosterHtml();
    else if (this.tab === 'questions') body.innerHTML = this.questionsHtml();
    else body.innerHTML = this.boardHtml();
    this.bindBody(body);
  }

  // ---------- 測驗管理 ----------

  private testsHtml(): string {
    const lb = this.latestBoard;
    const participated = lb ? lb.students.filter((s) => s.attempts > 0).length : 0;
    return `<div class="stats"><div class="stat"><small>班級學生</small><strong>${this.roster.length}<span> 人</span></strong></div>
<div class="stat"><small>進行中測驗</small><strong>${this.quizzes.filter((q) => q.status === 'published').length}<span> 份</span></strong></div>
<div class="stat"><small>已參與學生${lb ? `（${esc(lb.quiz.title)}）` : ''}</small><strong>${participated}<span> / ${this.roster.length}</span></strong></div>
<div class="stat"><small>全班平均${lb ? '（最近一次）' : ''}</small><strong>${avgOf(lb?.students ?? []).toFixed(1)}<span> 顆星</span></strong></div></div>
${
  this.quizzes.length
    ? `<div class="table-wrap"><table><thead><tr><th>測驗名稱</th><th>模式</th><th>狀態</th><th>建立日期</th><th>操作</th></tr></thead><tbody>${this.quizzes
        .map(
          (q) => `<tr><td><strong>${esc(q.title)}</strong></td><td>${q.mode === 'team' ? `分組賽 · ${q.teamCount} 組` : '個人賽'}</td>
<td><span class="pill ${STATUS_PILL[q.status]}">${STATUS_TEXT[q.status]}</span></td><td>${date(q.createdAt)}</td>
<td class="row-actions"><button data-board="${q.id}">${q.status === 'settled' ? '查看結果' : '計分面板'}</button>${
            q.status === 'draft'
              ? `<button data-publish="${q.id}">發布測驗 ↗</button><button data-delete="${q.id}" class="danger-text">刪除</button>`
              : q.status === 'published'
                ? `<button data-close="${q.id}">關閉</button>`
                : ''
          }</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<section class="card empty"><h2>還沒有測驗</h2><p>按右上角「建立測驗」開始。</p></section>`
}
<div class="learn-strip" style="margin-top:25px"><div class="learn-icon">${icon('bulb')}</div><div><h3>準備好了，再讓全班一起出發。</h3><p>先建立草稿，按「發布」後學生才會看到新測驗通知；「關閉」後學生不能再作答，接著就可以結算並揭曉成績。</p></div></div>`;
  }

  private async createQuiz(): Promise<void> {
    let error = '';
    for (;;) {
      const v = await modal(
        '建立新測驗',
        `<label class="form-field">測驗名稱<input id="f-title" maxlength="40" placeholder="例如：臺灣地形大挑戰"></label>
<label class="form-field">競賽模式<select id="f-mode"><option value="team">分組賽</option><option value="solo">個人賽</option></select></label>
<label class="form-field" id="f-team-field">小組數量<select id="f-teams">${[2, 3, 4, 5, 6, 7, 8]
          .map((i) => `<option ${i === 6 ? 'selected' : ''}>${i}</option>`)
          .join('')}</select></label><p>先存成草稿，準備好再發布給學生。每次作答 5 題：捏地形 3 題、概念選擇題 2 題。</p>${
          error ? `<p class="form-error">${esc(error)}</p>` : ''
        }`,
        [
          { label: '取消', value: 'cancel' },
          { label: '建立草稿', primary: true, value: 'ok' },
        ],
      );
      const dlg = document.getElementById('modal')!;
      const title = ($('#f-title', dlg) as HTMLInputElement).value.trim();
      const mode = ($('#f-mode', dlg) as HTMLSelectElement).value;
      const teams = Number(($('#f-teams', dlg) as HTMLSelectElement).value);
      if (v !== 'ok') return;
      if (!title) {
        error = '請輸入測驗名稱';
        continue;
      }
      try {
        await api.post('/api/quizzes', { title, mode, teamCount: teams });
        toast('草稿已建立，發布後才會出現在學生首頁。');
        await this.refreshAll();
        this.boardId = null;
        this.tab = 'tests';
        this.render();
      } catch (e) {
        toast(errorText(e), 5000);
      }
      return;
    }
  }

  private async publish(id: string): Promise<void> {
    const q = this.quizzes.find((x) => x.id === id)!;
    const v = await modal('發布測驗？', `<p>發布後，全班學生登入時會看到「${esc(q.title)}」的新測驗通知，可以開始作答。</p>`, [
      { label: '先不要', value: 'no' },
      { label: '發布', primary: true, value: 'yes' },
    ]);
    if (v !== 'yes') return;
    await this.act(() => api.post(`/api/quizzes/${id}/publish`), '測驗已發布，學生首頁會出現新測驗。');
  }

  private async close(id: string): Promise<void> {
    const v = await modal('確定要關閉測驗？', '<p>關閉後學生就不能再作答或重考；正在作答的同學，已提交的題目會保留，其餘算錯。關閉後就可以結算。</p>', [
      { label: '繼續開放', value: 'no' },
      { label: '確定關閉', primary: true, danger: true, value: 'yes' },
    ]);
    if (v !== 'yes') return;
    await this.act(() => api.post(`/api/quizzes/${id}/close`), '測驗已關閉，可以準備揭曉成績。');
  }

  private async remove(id: string): Promise<void> {
    const q = this.quizzes.find((x) => x.id === id)!;
    const v = await modal('刪除草稿？', `<p>「${esc(q.title)}」還沒發布，刪除後無法復原。</p>`, [
      { label: '保留', value: 'no' },
      { label: '刪除', primary: true, danger: true, value: 'yes' },
    ]);
    if (v !== 'yes') return;
    if (this.boardId === id) this.boardId = null;
    await this.act(() => api.del(`/api/quizzes/${id}`), '草稿已刪除。');
  }

  private async act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast(errorText(e), 5000);
    }
    await this.refreshAll();
    this.render();
  }

  // ---------- 班級名單 ----------

  private rosterHtml(): string {
    return `<div class="card-row" style="margin-bottom:20px"><p class="muted">${this.roster.length} 位學生 · 帳號就是學校 SSO 的學號，用來比對登入的學生</p>
<div class="row-actions"><label class="secondary file-btn">${icon('plus')}匯入 Excel（account.xlsx）<input type="file" accept=".xlsx" data-act="roster-file" hidden></label><button class="secondary" data-act="roster-paste">貼上名單</button></div></div>
${
  this.roster.length
    ? `<div class="table-wrap"><table><thead><tr><th>座號</th><th>帳號（學號）</th><th>姓名</th><th>作答狀態</th></tr></thead><tbody>${this.roster
        .map(
          (s) =>
            `<tr><td>${pad2(s.no)}</td><td>${esc(s.uid)}</td><td>${esc(s.name)}</td><td><span class="pill ${s.attempts ? '' : 'gray'}">${s.attempts ? '已參與' : '尚未作答'}</span></td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<section class="card empty"><h2>還沒有名單</h2><p>匯入 account.xlsx（欄位：no、account、name），或把 Excel 的三欄直接複製貼上。</p></section>`
}`;
  }

  private parseRows(rows: unknown[][]): { rows: { no: number; uid: string; name: string }[]; error: string } {
    const out: { no: number; uid: string; name: string }[] = [];
    for (const r of rows) {
      const cells = r.map((c) => String(c ?? '').trim());
      if (cells.every((c) => !c)) continue;
      if (!/^\d+$/.test(cells[0])) continue; // 標題列
      if (cells.length < 3 || !cells[1] || !cells[2]) return { rows: out, error: `第 ${cells[0]} 號的資料不完整` };
      out.push({ no: Number(cells[0]), uid: cells[1], name: cells[2] });
    }
    if (!out.length) return { rows: out, error: '沒有讀到任何學生：每一列要有座號、帳號、姓名' };
    if (new Set(out.map((r) => r.no)).size !== out.length) return { rows: out, error: '名單裡有重複的座號' };
    if (new Set(out.map((r) => r.uid)).size !== out.length) return { rows: out, error: '名單裡有重複的帳號' };
    return { rows: out, error: '' };
  }

  private async confirmRoster(rows: { no: number; uid: string; name: string }[]): Promise<void> {
    const v = await modal(
      '確認班級名單',
      `<p>共 <strong>${rows.length}</strong> 位學生，會取代目前的名單（已作答的成績不會刪除）。</p><div class="table-wrap preview"><table><thead><tr><th>座號</th><th>帳號</th><th>姓名</th></tr></thead><tbody>${rows
        .slice(0, 8)
        .map((r) => `<tr><td>${pad2(r.no)}</td><td>${esc(r.uid)}</td><td>${esc(r.name)}</td></tr>`)
        .join('')}${rows.length > 8 ? `<tr><td colspan="3">…還有 ${rows.length - 8} 位</td></tr>` : ''}</tbody></table></div>`,
      [
        { label: '取消', value: 'no' },
        { label: '套用名單', primary: true, value: 'yes' },
      ],
    );
    if (v !== 'yes') return;
    await this.act(() => api.put('/api/roster', { students: rows }), `已匯入 ${rows.length} 位學生。`);
  }

  private async rosterFromFile(file: File): Promise<void> {
    try {
      const data = await readSheet(file);
      const r = this.parseRows(data as unknown[][]);
      if (r.error) return void toast(r.error, 5000);
      await this.confirmRoster(r.rows);
    } catch {
      toast('讀不到這個 Excel 檔，請確認是 .xlsx 格式', 5000);
    }
  }

  private async rosterFromPaste(): Promise<void> {
    const v = await modal(
      '貼上班級名單',
      '<p>每行一位學生：座號、帳號、姓名，用逗號或 Tab 分隔（從 Excel 直接複製三欄貼上即可）。</p><textarea id="f-roster" aria-label="班級名單" placeholder="1,hs112001,王小明"></textarea>',
      [
        { label: '取消', value: 'no' },
        { label: '下一步', primary: true, value: 'yes' },
      ],
    );
    if (v !== 'yes') return;
    const text = ($('#f-roster', document.getElementById('modal')!) as HTMLTextAreaElement).value;
    const r = this.parseRows(text.split(/\r?\n/).map((l) => l.split(/[,\t、]/)));
    if (r.error) return void toast(r.error, 5000);
    await this.confirmRoster(r.rows);
  }

  // ---------- 概念題題庫 ----------

  private questionsHtml(): string {
    const active = this.questions.filter((q) => q.active);
    return `<div class="card-row" style="margin-bottom:20px"><p class="muted">啟用中 ${active.length} 題 · 每次作答隨機抽 2 題，選項順序也會打亂 · 答案只存在伺服器</p>
<label class="secondary file-btn">${icon('plus')}匯入／更新題庫（JSON）<input type="file" accept=".json,application/json" data-act="q-file" hidden></label></div>
${
  this.questions.length
    ? `<div class="table-wrap"><table><thead><tr><th>編號</th><th>題目</th><th>正確答案</th><th>狀態</th><th>操作</th></tr></thead><tbody>${this.questions
        .map(
          (q) => `<tr><td>${esc(q.id)}</td><td class="wrap">${esc(q.stem)}</td><td class="wrap">${esc(q.options[q.answer])}</td>
<td><span class="pill ${q.active ? '' : 'gray'}">${q.active ? '啟用' : '停用'}</span></td><td class="row-actions"><button data-edit-q="${esc(q.id)}">檢視／編輯</button></td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<section class="card empty"><h2>題庫是空的</h2><p>請匯入 question-bank.json（由 social-題目卷 與解析卷整理，已核對答案）。</p></section>`
}`;
  }

  private async questionsFromFile(file: File): Promise<void> {
    let list: Question[];
    try {
      const raw = JSON.parse(await file.text());
      list = (Array.isArray(raw) ? raw : raw.questions) as Question[];
      if (!Array.isArray(list)) throw new Error();
    } catch {
      return void toast('讀不到題庫：請選擇 question-bank.json', 5000);
    }
    const v = await modal('更新題庫？', `<p>檔案裡有 <strong>${list.length}</strong> 題。匯入後會取代目前的題庫；不在檔案裡的舊題目會停用（舊的作答紀錄仍保留）。</p>`, [
      { label: '取消', value: 'no' },
      { label: '匯入', primary: true, value: 'yes' },
    ]);
    if (v !== 'yes') return;
    await this.act(
      () =>
        api.put('/api/questions', {
          questions: list.map((q) => ({ id: q.id, stem: q.stem, options: q.options, answer: q.answer, explanation: q.explanation ?? '', active: q.active !== false })),
        }),
      `題庫已更新，共 ${list.length} 題。`,
    );
  }

  private async editQuestion(id: string): Promise<void> {
    const q = this.questions.find((x) => x.id === id)!;
    const v = await modal(
      `編輯題目 ${q.id}`,
      `<label class="form-field">題目<textarea id="f-stem" style="height:90px">${esc(q.stem)}</textarea></label>${q.options
        .map((o, j) => `<label class="form-field">選項 ${String.fromCharCode(65 + j)}<input id="f-opt-${j}" value="${esc(o)}"></label>`)
        .join('')}<label class="form-field">正確答案<select id="f-answer">${q.options
        .map((_, j) => `<option value="${j}" ${j === q.answer ? 'selected' : ''}>選項 ${String.fromCharCode(65 + j)}</option>`)
        .join('')}</select></label><label class="form-field">解析（作答後顯示給學生）<input id="f-exp" value="${esc(q.explanation)}"></label>
<label class="toggle-label"><input type="checkbox" id="f-active" ${q.active ? 'checked' : ''}>啟用這一題</label>`,
      [
        { label: '取消', value: 'no' },
        { label: '儲存', primary: true, value: 'yes' },
      ],
    );
    if (v !== 'yes') return;
    const dlg = document.getElementById('modal')!;
    const updated: Question = {
      id: q.id,
      stem: ($('#f-stem', dlg) as HTMLTextAreaElement).value.trim(),
      options: [0, 1, 2, 3].map((j) => ($(`#f-opt-${j}`, dlg) as HTMLInputElement).value.trim()),
      answer: Number(($('#f-answer', dlg) as HTMLSelectElement).value),
      explanation: ($('#f-exp', dlg) as HTMLInputElement).value.trim(),
      active: ($('#f-active', dlg) as HTMLInputElement).checked,
    };
    if (!updated.stem || updated.options.some((o) => !o) || new Set(updated.options).size !== 4)
      return void toast('請填入完整題目與四個不同的選項', 5000);
    await this.act(
      () => api.put('/api/questions', { questions: this.questions.map((x) => (x.id === id ? updated : x)) }),
      '題目已更新。',
    );
  }

  // ---------- 計分面板 ----------

  private async openBoard(id: string): Promise<void> {
    this.boardId = id;
    this.tab = 'board';
    this.showReveal = false;
    try {
      this.board = await api.get<Board>(`/api/quizzes/${id}/board`);
    } catch (e) {
      toast(errorText(e), 5000);
    }
    this.render();
  }

  private boardHtml(): string {
    const b = this.board;
    if (!b) return '<section class="card empty"><h2>還沒有測驗</h2><p>先到「測驗管理」建立並發布測驗。</p></section>';
    const q = b.quiz;
    if (this.showReveal && b.settlement) return revealHtml(b.settlement, q.title);
    const picker =
      this.quizzes.length > 1
        ? `<select class="quiz-picker" data-act="pick" aria-label="選擇測驗">${this.quizzes
            .map((x) => `<option value="${x.id}" ${x.id === q.id ? 'selected' : ''}>${esc(x.title)}（${STATUS_TEXT[x.status]}）</option>`)
            .join('')}</select>`
        : '';
    const settleDisabled = q.status === 'draft' || q.status === 'published';
    const actions = `<div class="board-actions"><span class="pill ${STATUS_PILL[q.status]}">${STATUS_TEXT[q.status]}</span>
<span class="muted small">${q.mode === 'team' ? '分組賽' : '個人賽'} · ${q.status === 'published' ? '每 5 秒自動更新' : '成績已保留'}</span>${picker}<span class="spacer"></span>
${q.mode === 'team' && q.status !== 'settled' ? '<button class="secondary" data-act="copy-teams">沿用上次分組</button>' : ''}
<button class="secondary" data-act="export">${icon('download')}匯出成績</button>
${q.status === 'published' ? `<button class="secondary danger" data-close="${q.id}">關閉測驗</button>` : q.status === 'draft' ? `<button class="secondary" data-publish="${q.id}">發布測驗</button>` : ''}
<button class="primary" data-act="settle" ${settleDisabled ? 'disabled title="請先關閉測驗，再進行結算"' : ''}>${icon('trophy')}${q.status === 'settled' ? '重播揭曉' : '結算並揭曉'}</button></div>`;
    return actions + (q.mode === 'team' ? this.teamHtml(b) : this.rankingHtml(b.students));
  }

  private cardHtml(s: Student, q: Quiz): string {
    const locked = q.status === 'settled';
    return `<div class="student" ${locked ? '' : `draggable="true" data-drag="${esc(s.uid)}"`}><span class="seat">${pad2(s.no)}</span><strong>${esc(s.name)}</strong>
<span class="star-score">${s.attempts || s.best ? `${s.best} ★` : '未作答'}</span>${
      locked
        ? ''
        : `<select data-move="${esc(s.uid)}" aria-label="${esc(s.name)}的組別"><option value="0" ${!s.team ? 'selected' : ''}>待分組</option>${Array.from(
            { length: q.teamCount },
            (_, i) => `<option value="${i + 1}" ${s.team === i + 1 ? 'selected' : ''}>第 ${i + 1} 組</option>`,
          ).join('')}</select>`
    }</div>`;
  }

  private teamHtml(b: Board): string {
    const q = b.quiz;
    const inTeam = (t: number) => b.students.filter((s) => s.team === t);
    const pool = b.students.filter((s) => !s.team || s.team > q.teamCount);
    return `<div class="board-layout"><div class="groups">${Array.from({ length: q.teamCount }, (_, i) => {
      const members = inTeam(i + 1);
      return `<section class="group" data-drop="${i + 1}"><div class="group-head"><h3><span class="group-num">${pad2(i + 1)}</span>第 ${i + 1} 組</h3><span class="group-score">${avgOf(members).toFixed(1)}<small> ★</small></span></div>
<p class="group-meta">${members.length} 位成員 · ${members.filter((s) => s.attempts || s.best).length} 人已作答</p>${members.map((s) => this.cardHtml(s, q)).join('') || '<div class="empty">拖曳學生到這裡</div>'}</section>`;
    }).join('')}</div>
<aside class="unassigned" data-drop="0"><h3>個人點數 <span class="pill">${pool.length}</span></h3><p>拖曳卡片到小組，或用選單選組別。</p>${
      pool.map((s) => this.cardHtml(s, q)).join('') || '<p class="empty">全班都已分組！</p>'
    }</aside></div>
<div class="underbar"><span>小組分數＝組員最高星數的平均 · 沒作答以 0 星計入</span><span data-role="save">分組變更會自動儲存</span></div>`;
  }

  private rankingHtml(list: Student[]): string {
    const sorted = [...list].sort((a, b) => b.best - a.best || a.no - b.no);
    const rank = (s: Student) => 1 + sorted.filter((o) => o.best > s.best).length;
    return `<div class="stats"><div class="stat"><small>全班平均</small><strong>${avgOf(list).toFixed(1)}<span> 顆星</span></strong></div>
<div class="stat"><small>已作答</small><strong>${list.filter((s) => s.attempts || s.best).length}<span> 人</span></strong></div>
<div class="stat"><small>滿星學生</small><strong>${list.filter((s) => s.best === 5).length}<span> 人</span></strong></div>
<div class="stat"><small>總作答次數</small><strong>${list.reduce((a, s) => a + s.attempts, 0)}<span> 次</span></strong></div></div>
<div class="table-wrap"><table><thead><tr><th>名次</th><th>座號</th><th>姓名</th><th>最高星數</th><th>作答次數</th></tr></thead><tbody>${sorted
      .map(
        (s) =>
          `<tr><td>${rank(s)}</td><td>${pad2(s.no)}</td><td>${esc(s.name)}</td><td class="stars">${stars(s.best)}</td><td>${s.attempts ? `${s.attempts} 次` : '尚未作答'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  }

  private async moveStudent(uid: string, team: number): Promise<void> {
    const b = this.board!;
    const s = b.students.find((x) => x.uid === uid);
    if (!s || (s.team ?? 0) === team) return;
    const before = s.team;
    s.team = team || null;
    this.renderBody();
    const save = this.main.querySelector('[data-role=save]');
    if (save) save.textContent = '儲存中…';
    try {
      await api.put(`/api/quizzes/${b.quiz.id}/teams`, { uid, team: team || null });
      const el = this.main.querySelector('[data-role=save]');
      if (el) el.textContent = '分組已儲存';
    } catch (e) {
      s.team = before;
      this.renderBody();
      const el = this.main.querySelector('[data-role=save]');
      if (el) el.textContent = '尚未儲存，請再試一次';
      toast(`${errorText(e)}（分組尚未儲存）`, 5000);
    }
  }

  private async settle(): Promise<void> {
    const b = this.board!;
    if (b.quiz.status === 'settled') {
      this.showReveal = true;
      this.renderBody();
      return;
    }
    const unassigned = b.quiz.mode === 'team' ? b.students.filter((s) => !s.team).length : 0;
    const v = await modal(
      '一起揭曉，努力的成果！',
      `<p>${unassigned ? `還有 <strong>${unassigned} 人未分組</strong>，這些同學不計入任何一組。<br>` : ''}${
        b.quiz.mode === 'team' ? '沒作答的組員以 0 星列入平均。' : '全班平均包含還沒作答的同學。'
      }結算後分組和結果就會固定。</p>`,
      [
        { label: '返回確認', value: 'no' },
        { label: '開始揭曉 ✦', primary: true, value: 'yes' },
      ],
    );
    if (v !== 'yes') return;
    try {
      const result = await api.post<Settlement>(`/api/quizzes/${b.quiz.id}/settle`);
      await this.refreshAll();
      this.board!.settlement = result;
      this.showReveal = true;
      this.render();
    } catch (e) {
      toast(errorText(e), 5000);
    }
  }

  private async exportCsv(): Promise<void> {
    const b = this.board!;
    try {
      const blob = await api.blob(`/api/quizzes/${b.quiz.id}/export.csv`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${b.quiz.title}_成績.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已匯出成績（可以用 Excel 開啟）。');
    } catch (e) {
      toast(errorText(e), 5000);
    }
  }

  // ---------- 事件 ----------

  private bindBody(body: HTMLElement): void {
    body.querySelectorAll<HTMLButtonElement>('[data-board]').forEach((b) => b.addEventListener('click', () => void this.openBoard(b.dataset.board!)));
    body.querySelectorAll<HTMLButtonElement>('[data-publish]').forEach((b) => b.addEventListener('click', () => void this.publish(b.dataset.publish!)));
    body.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => void this.close(b.dataset.close!)));
    body.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((b) => b.addEventListener('click', () => void this.remove(b.dataset.delete!)));
    body.querySelector<HTMLInputElement>('[data-act=roster-file]')?.addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void this.rosterFromFile(f);
    });
    body.querySelector('[data-act=roster-paste]')?.addEventListener('click', () => void this.rosterFromPaste());
    body.querySelector<HTMLInputElement>('[data-act=q-file]')?.addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void this.questionsFromFile(f);
    });
    body.querySelectorAll<HTMLButtonElement>('[data-edit-q]').forEach((b) => b.addEventListener('click', () => void this.editQuestion(b.dataset.editQ!)));
    body.querySelector<HTMLSelectElement>('[data-act=pick]')?.addEventListener('change', (e) => void this.openBoard((e.target as HTMLSelectElement).value));
    body.querySelector('[data-act=copy-teams]')?.addEventListener('click', async () => {
      try {
        await api.post(`/api/quizzes/${this.board!.quiz.id}/teams/copy`);
        toast('已套用上一次的分組。');
        this.board = await api.get<Board>(`/api/quizzes/${this.board!.quiz.id}/board`);
        this.renderBody();
      } catch (e) {
        toast(errorText(e), 5000);
      }
    });
    body.querySelector('[data-act=export]')?.addEventListener('click', () => void this.exportCsv());
    body.querySelector('[data-act=settle]')?.addEventListener('click', () => void this.settle());
    body.querySelector('[data-act=back-board]')?.addEventListener('click', () => {
      this.showReveal = false;
      this.renderBody();
    });
    if (this.showReveal) animateReveal(body, this.ctx.audio);

    // 分組：選單（觸控與鍵盤）＋拖曳（滑鼠、iPad 長按拖曳）
    body.querySelectorAll<HTMLSelectElement>('[data-move]').forEach((sel) =>
      sel.addEventListener('change', () => void this.moveStudent(sel.dataset.move!, Number(sel.value))),
    );
    body.querySelectorAll<HTMLElement>('[data-drag]').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        this.dragging = true;
        e.dataTransfer?.setData('text/plain', card.dataset.drag!);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        this.dragging = false;
        card.classList.remove('dragging');
      });
    });
    body.querySelectorAll<HTMLElement>('[data-drop]').forEach((zone) => {
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        this.dragging = false;
        const uid = e.dataTransfer?.getData('text/plain');
        if (uid) void this.moveStudent(uid, Number(zone.dataset.drop));
      });
    });
  }
}
