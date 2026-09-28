import { AudioManager } from './game/AudioManager';
import type { LevelDef, TerrainConfig } from './types';
import { esc, modal } from './ui/dom';
import { icon } from './ui/icons';
import { PracticeView } from './views/practice';
import { QuizView } from './views/quiz';
import { TeacherView } from './views/teacher';

export type Page = 'practice' | 'quiz' | 'teacher';

export interface View {
  mount(main: HTMLElement): void;
  unmount(): void;
  /** 回傳 false 表示不能離開（例如測驗作答中，使用者選擇繼續作答）。 */
  canLeave?(): Promise<boolean>;
}

export interface AppContext {
  cfg: TerrainConfig;
  levels: LevelDef[];
  audio: AudioManager;
  params: URLSearchParams;
  nav(page: Page): void;
  /** 右上角顯示的使用者（登入後由測驗／老師頁設定）。 */
  setUser(user: { name: string; detail?: string } | null): void;
}

const NAV: [Page, string, string][] = [
  ['practice', 'hand', '自由練習'],
  ['quiz', 'trophy', '班級測驗'],
  ['teacher', 'grid', '老師後台'],
];

export class App implements AppContext {
  readonly audio = new AudioManager();
  private page: Page = 'practice';
  private view: View | null = null;
  private main: HTMLElement;

  constructor(
    root: HTMLElement,
    readonly cfg: TerrainConfig,
    readonly levels: LevelDef[],
    readonly params: URLSearchParams,
  ) {
    root.innerHTML = `<div class="shell"><aside class="rail"><a class="brand-symbol" href="./" aria-label="黏土捏地形首頁" data-nav="practice">${icon('mountain')}</a>${NAV.map(
      ([p, ic, label]) => `<button data-nav="${p}">${icon(ic)}${label}</button>`,
    ).join('')}<span class="rail-label">EXPLORE · SHAPE · DISCOVER</span><button class="bottom" data-act="help">${icon('help')}使用說明</button></aside>
<header class="topbar"><a class="brand" href="./" data-nav="practice">黏土捏地形 <small>TERRAIN STUDIO</small></a><div class="top-actions"><button class="help-btn" data-act="help">玩法說明</button><div class="avatar"><span class="avatar-circle" data-role="avatar">訪</span><span data-role="user">小小地形探險家</span></div></div></header>
<main class="content" id="main"></main></div>`;
    this.main = root.querySelector('#main') as HTMLElement;
    root.querySelectorAll<HTMLElement>('[data-nav]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.nav(b.dataset.nav as Page);
      }),
    );
    root.querySelectorAll('[data-act=help]').forEach((b) => b.addEventListener('click', () => showHelp()));
    // iOS：第一次點擊時解鎖音效與語音
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });

    const v = params.get('view');
    this.show(v === 'quiz' || v === 'teacher' ? v : params.has('quiz') ? 'quiz' : 'practice');
  }

  async nav(page: Page): Promise<void> {
    if (page === this.page) return;
    if (this.view?.canLeave && !(await this.view.canLeave())) return;
    this.show(page);
  }

  private show(page: Page): void {
    this.view?.unmount();
    this.page = page;
    document.querySelectorAll<HTMLElement>('.rail [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === page));
    this.view = page === 'practice' ? new PracticeView(this) : page === 'quiz' ? new QuizView(this) : new TeacherView(this);
    this.main.innerHTML = '';
    window.scrollTo(0, 0);
    this.view.mount(this.main);
  }

  setUser(user: { name: string; detail?: string } | null): void {
    const avatar = document.querySelector('[data-role=avatar]');
    const label = document.querySelector('[data-role=user]');
    if (!avatar || !label) return;
    avatar.textContent = user ? user.name.slice(0, 1) : '訪';
    label.innerHTML = user ? `${esc(user.name)}${user.detail ? ` · ${esc(user.detail)}` : ''}` : '小小地形探險家';
  }
}

export function showHelp(): void {
  void modal(
    '一起捏出臺灣的地形',
    `<p>① 在上方選一種想認識的地形。<br>② 選下方的工具，在黏土上按住或拖曳；也可以從兩邊的黏土罐拖一團黏土到土盤上。<br>③ 觀察高度顏色和等高線，再按「檢查我的地形」。</p><p>在土盤外面拖曳可以轉動畫面，兩根手指可以縮放，也能用「俯視」「側看」「還原」。捏錯了可以按「復原」。</p><p>「班級測驗」要用學校帳號登入，每次 5 題，答對 1 題得 1 顆星。</p>`,
  );
}
