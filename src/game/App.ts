import { CameraSource, type Facing } from '../camera/CameraSource';
import { ClayModel } from '../clay/ClayModel';
import { GRID } from '../constants';
import { GestureRecognizer, type GestureEnv, type GestureEvent } from '../gesture/GestureRecognizer';
import { TouchInput, type Tool } from '../gesture/TouchInput';
import { judge } from '../judge/judge';
import { Overlay } from '../render/Overlay';
import { Renderer } from '../render/Renderer';
import { HandTracker } from '../tracking/HandTracker';
import type { ClayCommand, JudgeResult, LevelDef, TerrainConfig } from '../types';
import { AudioManager } from './AudioManager';
import { params } from '../params';

type Phase = 'start' | 'levels' | 'brief' | 'play' | 'result';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PROGRESS_KEY = 'clay-terrain-progress';
const TRACK_INTERVAL_MS = 30;

export class App {
  private clay = new ClayModel(GRID);
  private renderer: Renderer;
  private overlay: Overlay;
  private camera: CameraSource;
  private tracker = new HandTracker();
  private recognizer = new GestureRecognizer();
  private touch: TouchInput;
  private audio = new AudioManager();
  private env: GestureEnv;

  private phase: Phase = 'start';
  private levelIndex = 0;
  private useHands = false;
  private lastTrack = 0;
  private lastHandSeen = 0;
  private lastT = performance.now() / 1000;
  private frame = 0;
  private fps = 0;
  private toastTimer = 0;
  private lastJudge: JudgeResult | null = null;
  private progress: Record<string, number> = {};
  private debug = params.has('debug');

  constructor(
    private cfg: TerrainConfig,
    private levels: LevelDef[],
  ) {
    this.renderer = new Renderer($<HTMLCanvasElement>('gl'), GRID, cfg);
    this.overlay = new Overlay($<HTMLCanvasElement>('overlay'));
    this.camera = new CameraSource($<HTMLVideoElement>('video'));
    this.env = {
      toUV: (p) => this.renderer.screenToUV(p, this.clay),
      jarAt: (p) => this.renderer.jarAt(p),
      hasClay: () => this.clay.budget > 1e-5,
      get screenH() {
        return window.innerHeight;
      },
    };
    this.touch = new TouchInput($('overlay'), this.env, this.renderer);
    try {
      this.progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}');
    } catch {
      this.progress = {};
    }
    this.clay.reset(levels[0], cfg.maxElevation);
    this.buildLegend();
    this.bindUI();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    // iPad 轉向、網址列收合時，Safari 可能把頁面捲掉一截；一律捲回頂端
    window.visualViewport?.addEventListener('resize', () => this.onResize());
    window.addEventListener('scroll', () => window.scrollTo(0, 0));
    document.addEventListener('visibilitychange', () => this.onVisibility());
    if (this.debug) {
      $('debug').classList.remove('hidden');
      (window as unknown as { __app: App }).__app = this;
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  // ---------- UI ----------

  private bindUI(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) =>
      b.addEventListener('click', () => this.onStart(b.dataset.cam as Facing | 'none')),
    );
    document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) =>
      b.addEventListener('click', () => this.setTool(b.dataset.tool as Tool)),
    );
    this.setTool('drop');
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        this.audio.play('click');
        const r = this.renderer;
        ({
          left: () => r.rotateBy(-45, 0),
          right: () => r.rotateBy(45, 0),
          top: () => r.setTilt(89),
          side: () => r.setTilt(14),
          reset: () => r.resetView(),
        })[b.dataset.view as 'left' | 'right' | 'top' | 'side' | 'reset']();
      }),
    );
    $('btn-undo').addEventListener('click', () => {
      this.audio.play('click');
      if (!this.clay.undo()) this.toast('沒有可以復原的步驟');
    });
    $('btn-reset').addEventListener('click', () => {
      this.audio.play('click');
      this.clay.reset(this.level, this.cfg.maxElevation);
      this.toast('重新開始這一關');
    });
    $('btn-levels').addEventListener('click', () => this.showLevels());
    $('btn-help').addEventListener('click', () => this.showBrief());
    $('btn-check').addEventListener('click', () => this.check());
    $('brief-go').addEventListener('click', () => {
      this.audio.play('click');
      this.setPhase('play');
    });
    $('result-retry').addEventListener('click', () => {
      this.audio.play('click');
      this.setPhase('play');
    });
    $('result-next').addEventListener('click', () => {
      this.audio.play('click');
      if (this.levelIndex + 1 < this.levels.length) this.loadLevel(this.levelIndex + 1);
      else this.showLevels();
    });
  }

  private get level(): LevelDef {
    return this.levels[this.levelIndex];
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    $('screen-start').classList.toggle('hidden', p !== 'start');
    $('screen-levels').classList.toggle('hidden', p !== 'levels');
    $('modal-brief').classList.toggle('hidden', p !== 'brief');
    $('modal-result').classList.toggle('hidden', p !== 'result');
    $('hud').classList.toggle('hidden', p === 'start' || p === 'levels');
    for (const id of ['jar-left', 'jar-right']) $(id).classList.toggle('hidden', p === 'start' || p === 'levels');
    if (p !== 'play') $('tag1000').classList.add('hidden');
  }

  private setTool(t: Tool): void {
    this.touch.tool = t;
    document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }

  private async onStart(cam: Facing | 'none'): Promise<void> {
    this.audio.unlock();
    this.audio.play('click');
    const msg = $('start-msg');
    if (cam !== 'none') {
      msg.textContent = '正在開啟鏡頭…';
      try {
        await this.camera.start(cam);
        this.useHands = true;
        msg.textContent = '';
        this.initTracker();
      } catch (e) {
        const err = e as Error;
        msg.textContent =
          err.message === 'insecure'
            ? '要用 https 網址開啟才能使用鏡頭。先用手指觸控玩吧！'
            : err.name === 'NotAllowedError'
              ? '鏡頭被拒絕了。可以到「設定 → Safari → 相機」改成允許。先用手指觸控玩吧！'
              : '打不開鏡頭，先用手指觸控玩吧！';
        this.useHands = false;
        await new Promise((r) => setTimeout(r, 2200));
      }
    }
    // 老師可以用網址指定關卡，例如 ?level=5 直接進盆地
    const lv = Number(params.get('level'));
    if (lv >= 1 && lv <= this.levels.length) this.loadLevel(lv - 1);
    else this.showLevels();
  }

  private initTracker(): void {
    if (this.tracker.ready) return;
    this.handStatus('手部追蹤載入中…');
    this.tracker
      .init()
      .then(() => {
        this.handStatus('');
        this.toast('準備好了！把手舉到鏡頭前面');
      })
      .catch((e) => {
        console.error(e);
        this.useHands = false;
        this.handStatus('');
        this.toast('手部追蹤載入失敗，請用手指觸控');
      });
  }

  private showLevels(): void {
    const grid = $('level-grid');
    grid.innerHTML = '';
    this.levels.forEach((lv, i) => {
      const b = document.createElement('button');
      b.className = 'level';
      const stars = this.progress[lv.id] ?? 0;
      b.innerHTML = `<span>${i + 1}. ${lv.title}</span><small>${lv.reveal.name}</small><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
      b.addEventListener('click', () => {
        this.audio.play('click');
        this.loadLevel(i);
      });
      grid.appendChild(b);
    });
    this.setPhase('levels');
  }

  private loadLevel(i: number): void {
    this.levelIndex = i;
    this.clay.reset(this.level, this.cfg.maxElevation);
    this.lastJudge = null;
    $('task-title').textContent = `${i + 1}. ${this.level.title}`;
    $('task-text').textContent = this.level.task;
    this.showBrief();
  }

  private showBrief(): void {
    $('brief-num').textContent = `第 ${this.levelIndex + 1} 關`;
    $('brief-title').textContent = this.level.title;
    $('brief-task').textContent = this.level.task;
    $('brief-tip').textContent = '💡 ' + this.level.tip;
    this.setPhase('brief');
    this.audio.speak(this.level.task);
  }

  private check(): void {
    const r = judge(this.clay.h, this.clay.n, this.level.target, this.cfg);
    this.lastJudge = r;
    this.clay.mask.set(r.problemMask);
    this.clay.version++;
    $('result-title').textContent = r.passed ? `🎉 你捏出了${this.level.title}！` : '再加油一下！';
    $('result-stars').textContent = r.passed ? '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars) : '';
    $('result-score').textContent = `分數：${r.score}`;
    const ul = $('result-hints');
    ul.innerHTML = '';
    for (const h of r.hints) {
      const li = document.createElement('li');
      li.textContent = h;
      ul.appendChild(li);
    }
    const reveal = $('result-reveal');
    reveal.classList.toggle('hidden', !r.passed);
    if (r.passed) {
      reveal.querySelector('.reveal-name')!.textContent = `臺灣的例子：${this.level.reveal.name}`;
      reveal.querySelector('.reveal-fact')!.textContent = this.level.reveal.fact;
      const best = Math.max(this.progress[this.level.id] ?? 0, r.stars);
      this.progress[this.level.id] = best;
      try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(this.progress));
      } catch {
        /* 私密瀏覽等情況存不了，不影響遊戲 */
      }
    }
    $('result-next').classList.toggle('hidden', !r.passed);
    $('result-retry').textContent = r.passed ? '再捏一次' : '繼續修改';
    this.audio.play(r.passed ? 'pass' : 'fail');
    this.audio.speak(r.passed ? `太棒了！你捏出了${this.level.title}` : r.hints[0] ?? '再試試看');
    this.setPhase('result');
  }

  private buildLegend(): void {
    const stops = this.cfg.ramp;
    const grad = stops.map((s, i) => `${s.color} ${(i / (stops.length - 1)) * 100}%`).join(', ');
    const ticks = stops
      .map((s) => `<span class="${s.m === this.cfg.contour.highlight ? 'hi' : ''}">${s.m}m</span>`)
      .join('');
    $('legend').innerHTML = `<div class="bar" style="background: linear-gradient(to top, ${grad})"></div><div class="ticks">${ticks}</div>`;
  }

  private toast(text: string, ms = 1800): void {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.add('hidden'), ms);
  }

  private handStatus(text: string): void {
    const el = $('hand-status');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  private onResize(): void {
    window.scrollTo(0, 0);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.resize(w, h);
    this.overlay.resize(w, h);
  }

  private onVisibility(): void {
    if (document.visibilityState === 'visible' && this.useHands && !this.camera.active) {
      this.camera.start(this.camera.facing).catch(() => this.toast('鏡頭重新開啟失敗'));
    }
  }

  // ---------- 主迴圈 ----------

  private apply(commands: ClayCommand[], events: GestureEvent[]): void {
    for (const c of commands) this.clay.apply(c);
    for (const e of events) {
      if (e === 'grab') this.audio.play('grab');
      else if (e === 'drop') this.audio.play('drop');
      else if (e === 'cancel') this.toast('把黏土拖到土盤上再放開');
      else if (e === 'empty') {
        this.audio.play('empty');
        this.toast('黏土罐空了！可以按「復原」拿回來');
      }
    }
  }

  private loop(now: number): void {
    requestAnimationFrame((t) => this.loop(t));
    this.step(now);
  }

  /** 一個畫面的工作；除錯時可從主控台用 __app.step(performance.now()) 手動推進。 */
  step(now: number): void {
    const t = now / 1000;
    const dt = Math.min(0.1, t - this.lastT);
    this.lastT = t;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
    this.frame++;

    if (this.phase === 'play') {
      if (this.useHands && this.tracker.ready && this.camera.active && now - this.lastTrack >= TRACK_INTERVAL_MS) {
        this.lastTrack = now;
        const raw = this.tracker.detect(this.camera.video);
        const seen = new Map<string, number>();
        const hands = raw.map((h) => {
          const n = seen.get(h.side) ?? 0;
          seen.set(h.side, n + 1);
          return {
            key: n ? `${h.side}${n}` : h.side,
            points: h.points.map((p) => this.camera.toScreen(p.x, p.y, window.innerWidth, window.innerHeight)),
          };
        });
        if (hands.length) this.lastHandSeen = t;
        const r = this.recognizer.update(hands, t, this.env);
        this.apply(r.commands, r.events);
        if (t - this.lastHandSeen > 4 && !this.touch.active) this.handStatus('把手舉到前鏡頭前面，看左下角的小畫面');
        else this.handStatus('');
      }
      const r = this.touch.update(dt);
      this.apply(r.commands, r.events);
    }

    this.renderer.update(this.clay, t, this.clay.budgetMax ? this.clay.budget / this.clay.budgetMax : 0);
    this.renderer.render();
    this.overlay.draw(this.phase === 'play' ? this.recognizer.views : [], { pos: this.touch.pos, tool: this.touch.tool, carrying: this.touch.carrying }, this.debug);
    if (this.frame % 6 === 0) this.updateLabels();
    if (this.debug && this.frame % 10 === 0) this.updateDebug();
  }

  private updateLabels(): void {
    const pct = this.clay.budgetMax ? Math.round((this.clay.budget / this.clay.budgetMax) * 100) : 0;
    for (const side of ['left', 'right'] as const) {
      const el = $(`jar-${side}`);
      const p = this.renderer.jarLabelPoint(side);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.textContent = `黏土 ${pct}%`;
    }
    // 1000 m 標籤：放在 1000 m 等高線上離鏡頭最近的地方
    const tag = $('tag1000');
    if (this.phase !== 'play') return;
    const { n, h } = this.clay;
    const target = this.cfg.contour.highlight / this.cfg.maxElevation;
    const tol = 40 / this.cfg.maxElevation;
    let best = -1;
    for (let y = n - 3; y >= 2 && best < 0; y -= 2)
      for (let x = 2; x < n - 2; x += 2) {
        const i = y * n + x;
        if (Math.abs(h[i] - target) < tol) {
          best = i;
          break;
        }
      }
    if (best < 0) {
      tag.classList.add('hidden');
      return;
    }
    const p = this.renderer.boardPoint((best % n) / (n - 1), Math.floor(best / n) / (n - 1), this.clay);
    tag.style.left = `${p.x}px`;
    tag.style.top = `${p.y}px`;
    tag.classList.remove('hidden');
  }

  private updateDebug(): void {
    const lines = [
      `FPS ${this.fps.toFixed(0)}  追蹤 ${this.tracker.lastMs.toFixed(1)}ms (${this.tracker.delegate})`,
      `鏡頭 ${this.camera.active ? `${this.camera.video.videoWidth}×${this.camera.video.videoHeight}` : '關'}  手部 ${this.useHands ? (this.tracker.ready ? '就緒' : '載入中') : '關'}`,
      ...this.recognizer.views.map((v) => `${v.key}: ${v.pose} / ${v.mode}`),
      `黏土罐 ${(this.clay.budget * 1000).toFixed(1)}‰  總量 ${(this.clay.volume() * 1000).toFixed(1)}‰`,
    ];
    if (this.lastJudge) {
      lines.push(`判定 ${this.lastJudge.score} ${this.lastJudge.passed ? '過關' : '未過'}`);
      for (const c of this.lastJudge.conditions) lines.push(`  ${c.key}: ${c.score.toFixed(2)}`);
      for (const [k, v] of Object.entries(this.lastJudge.features)) lines.push(`  ${k}: ${v.toFixed(2)}`);
    }
    $('debug').textContent = lines.join('\n');
  }
}
