import type { AppContext, View } from '../app';
import type { LevelDef } from '../types';
import { esc, modal, stars, toast } from '../ui/dom';
import { icon, landIcon } from '../ui/icons';
import { Workbench, workbenchMarkup } from './workbench';

const PROGRESS_KEY = 'clay-terrain-progress';

function loadProgress(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveProgress(p: Record<string, number>): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* 私密瀏覽等情況存不了，不影響練習 */
  }
}

/** 自由練習：六種地形、可一直檢查、不限時間。 */
export class PracticeView implements View {
  private wb: Workbench | null = null;
  private index: number;
  private progress = loadProgress();
  private root!: HTMLElement;

  constructor(private ctx: AppContext) {
    const lv = Number(ctx.params.get('level'));
    this.index = lv >= 1 && lv <= ctx.levels.length ? lv - 1 : 0;
  }

  private get level(): LevelDef {
    return this.ctx.levels[this.index];
  }

  mount(main: HTMLElement): void {
    this.root = main;
    main.innerHTML = `<div class="title-row"><div><div class="eyebrow">LET’S GET OUR HANDS DIRTY</div><h1>把地形，捏在手心裡。</h1><p>一點黏土、一點想像，認識臺灣的每一種地形。</p></div><span class="badge">${icon('leaf')}自由練習 · 不限時間</span></div>
<nav class="levels" aria-label="選擇地形">${this.ctx.levels
      .map(
        (l, i) =>
          `<button class="level" data-level="${i}">${landIcon(l.target)}<span><span class="num">0${i + 1}</span><strong>${esc(l.title)}</strong></span><span class="done" data-done="${esc(l.id)}"></span></button>`,
      )
      .join('')}</nav>
<div data-role="bench"></div>
<div class="underbar"><span>${icon('leaf')}每一次揉捏，都是一個新發現。</span><button data-act="gesture">${icon('camera')}<span>試試手勢操作</span></button></div>
<div class="learn-strip"><div class="learn-icon">${icon('book')}</div><div><h3>地圖上的線條，藏著什麼祕密？</h3><p>等高線越密，坡度越陡；不同顏色，標示不同高度。</p></div><button data-act="contour-help">認識等高線${icon('arrow')}</button></div>
<footer class="page-footer"><span>用雙手探索，讓知識成形。</span><span>臺灣的地形 · 社會學習工作室</span></footer>`;

    main.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) =>
      b.addEventListener('click', () => this.setLevel(Number(b.dataset.level))),
    );
    main.querySelector('[data-act=gesture]')!.addEventListener('click', () => this.toggleGestures());
    main.querySelector('[data-act=contour-help]')!.addEventListener('click', () => contourHelp());
    this.renderBench();
  }

  private renderBench(): void {
    this.wb?.destroy();
    const bench = this.root.querySelector('[data-role=bench]') as HTMLElement;
    bench.innerHTML = workbenchMarkup(this.level, this.ctx.cfg, {
      exam: false,
      footerHtml: `<button class="primary" data-act="check">${icon('check')}檢查我的地形</button><div class="small-note">放心試試看，可以一直練習喔！</div>`,
    });
    this.wb = new Workbench(bench, this.ctx.cfg, this.ctx.audio, this.level);
    bench.querySelector('[data-act=check]')!.addEventListener('click', () => this.check());
    this.root.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) => {
      const on = Number(b.dataset.level) === this.index;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    this.root.querySelectorAll<HTMLElement>('[data-done]').forEach((el) => {
      const s = this.progress[el.dataset.done!] ?? 0;
      el.textContent = s ? '★'.repeat(s) : '';
      el.title = s ? `最佳 ${s} 顆星` : '';
    });
    this.syncGestureButton();
  }

  private setLevel(i: number): void {
    if (i === this.index) return;
    const gestures = this.wb?.board.gesturesEnabled;
    this.index = i;
    this.ctx.audio.play('click');
    this.renderBench();
    if (gestures) void this.wb!.board.enableGestures();
  }

  private async check(): Promise<void> {
    const wb = this.wb!;
    const lv = this.level;
    const r = wb.board.check(lv.target);
    this.ctx.audio.play(r.passed ? 'pass' : 'fail');
    if (r.passed) {
      this.progress[lv.id] = Math.max(this.progress[lv.id] ?? 0, r.stars);
      saveProgress(this.progress);
      this.renderDone();
      this.ctx.audio.speak(`太棒了！你捏出了${lv.title}`);
      const next = (this.index + 1) % this.ctx.levels.length;
      const v = await modal(
        `捏得很棒！認識真正的${lv.title}`,
        `<div class="stars result-stars">${stars(r.stars, 3)}</div><p><strong>臺灣的例子：${esc(lv.reveal.name)}</strong><br>${esc(lv.reveal.fact)}</p><p class="small-note">分數 ${r.score}</p>`,
        [
          { label: '繼續練習', value: 'stay' },
          { label: '挑戰下一種地形 →', primary: true, value: 'next' },
        ],
      );
      if (v === 'next') this.setLevel(next);
    } else {
      this.ctx.audio.speak(r.hints[0] ?? '再試試看');
      await modal(
        '再捏一下，就更接近了',
        `<ul class="hint-list">${r.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul><p class="small-note">分數 ${r.score} · 土盤上閃紅色的地方需要再調整</p>`,
      );
    }
  }

  private renderDone(): void {
    this.root.querySelectorAll<HTMLElement>('[data-done]').forEach((el) => {
      const s = this.progress[el.dataset.done!] ?? 0;
      el.textContent = s ? '★'.repeat(s) : '';
    });
  }

  private async toggleGestures(): Promise<void> {
    const board = this.wb!.board;
    if (board.gesturesEnabled) {
      board.disableGestures();
      this.syncGestureButton();
      return;
    }
    const v = await modal(
      '用手勢捏地形',
      '<p>會開啟 iPad 的前鏡頭，鏡頭畫面只顯示在土盤角落的小預覽，不會存檔也不會上傳。</p><p>✊ 在黏土罐上握拳抓黏土，移到土盤上張開手放下<br>🤏 拇指和食指捏住往上拉，可以拉高<br>✋ 張開手掌停住是壓平，來回抹是抹平</p>',
      [
        { label: '先不要', value: 'no' },
        { label: '開啟前鏡頭', primary: true, value: 'yes' },
      ],
    );
    if (v !== 'yes') return;
    this.ctx.audio.unlock();
    try {
      await board.enableGestures();
    } catch (e) {
      const err = e as Error;
      toast(
        err.message === 'insecure'
          ? '要用 https 網址開啟才能使用鏡頭'
          : err.name === 'NotAllowedError'
            ? '鏡頭被拒絕了，可以到「設定 → Safari → 相機」改成允許'
            : '打不開鏡頭，先用手指操作吧',
        4000,
      );
    }
    this.syncGestureButton();
  }

  private syncGestureButton(): void {
    const label = this.root.querySelector('[data-act=gesture] span');
    if (label) label.textContent = this.wb?.board.gesturesEnabled ? '關閉手勢操作' : '試試手勢操作';
  }

  unmount(): void {
    this.wb?.destroy();
    this.wb = null;
  }
}

export function contourHelp(): void {
  void modal(
    '讀懂等高線',
    '<p>等高線把高度相同的地方連在一起。線條越密，坡度越陡；越疏，坡度越和緩。</p><p>每 100 公尺一條細線，每 500 公尺一條粗線。1000 公尺用紅線標示，幫助你分辨丘陵和山地：超過紅線就是山地。</p>',
  );
}
