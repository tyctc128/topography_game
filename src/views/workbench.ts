import { Board, type ViewPreset } from '../board/Board';
import type { Tool } from '../gesture/TouchInput';
import type { AudioManager } from '../game/AudioManager';
import type { LevelDef, TerrainConfig } from '../types';
import { esc, modal, toast } from '../ui/dom';
import { icon } from '../ui/icons';

const TOOLS: [Tool, string, string][] = [
  ['drop', 'plus', '放黏土'],
  ['raise', 'up', '拉高'],
  ['press', 'flat', '壓平'],
  ['smooth', 'smooth', '抹平'],
  ['rotate', 'rotate', '轉動'],
];

/** 每一關一開始建議的工具。 */
const SUGGESTED_TOOL: Record<string, Tool> = {
  plain: 'press',
  tableland: 'smooth',
  hills: 'drop',
  mountain: 'drop',
  basin: 'press',
  profile: 'drop',
};

export interface MissionOptions {
  exam: boolean;
  /** 任務卡底部的按鈕區（已跳脫的 HTML），由呼叫端決定。 */
  footerHtml: string;
}

/** 土盤＋任務卡的 HTML；把 Board 掛上去要再呼叫 Workbench。 */
export function workbenchMarkup(level: LevelDef, cfg: TerrainConfig, opts: MissionOptions): string {
  const stops = [...cfg.ramp].reverse();
  const grad = cfg.ramp.map((s, i) => `${s.color} ${Math.round((i / (cfg.ramp.length - 1)) * 100)}%`).join(',');
  return `<div class="workspace">
  <section class="playground" aria-label="可操作地形土盤">
    <div class="surface-texture"></div>
    <div class="scene-top"><span class="scene-label">你的地形工作臺</span><label class="toggle-label"><input type="checkbox" checked data-act="contours">顯示等高線</label></div>
    <div class="tools" role="toolbar" aria-label="黏土工具">${TOOLS.map(
      ([key, ic, label]) => `<button class="tool" data-tool="${key}" aria-pressed="false" title="${label}">${icon(ic)}${label}</button>`,
    ).join('')}</div>
    <div class="altitude" aria-label="海拔圖例"><div class="altitude-labels">${stops
      .map((s) => `<span class="${s.m === cfg.contour.highlight ? 'hi' : ''}">${s.m} m</span>`)
      .join('')}</div><div class="altitude-bar" style="background:linear-gradient(to top,${grad})"></div></div>
    <span class="canvas-note" data-role="note">${opts.exam ? '開始捏出你的地形' : '從黏土罐拖一團黏土到土盤上試試'}</span>
    <div class="scene-bottom"><div class="view-buttons">${(
      [
        ['top', '俯視'],
        ['side', '側看'],
        ['orbit', '還原'],
      ] as const
    )
      .map(([k, t]) => `<button data-view="${k}" class="${k === 'orbit' ? 'active' : ''}">${t}</button>`)
      .join('')}</div><span class="scene-hint">${icon('hand')}土盤外拖曳旋轉 · 雙指縮放</span><div class="scene-actions"><button class="secondary icon-btn" data-act="undo" title="復原" aria-label="復原上一步">${icon('undo')}</button><button class="secondary icon-btn" data-act="reset" title="重新捏塑" aria-label="重新捏塑">${icon('rotate')}</button></div></div>
  </section>
  <aside class="mission">
    <div class="mission-label">${icon('target')}${opts.exam ? '你的測驗任務' : '今天的小任務'}</div>
    <h2>捏出「${esc(level.title)}」</h2>
    <p>${esc(level.intro)}</p>
    <div class="rule-line"></div>
    <span class="target-label">觀察這兩個特徵</span>
    <div class="target-list">${level.targets.map((t) => `<div class="target-item">${icon('check')}<span>${esc(t)}</span></div>`).join('')}</div>
    <div class="tip">${icon('bulb')}<span>${esc(level.tip)}</span></div>
    <div class="mission-footer">${opts.footerHtml}</div>
  </aside>
</div>`;
}

/** 把 Board 掛到 workbenchMarkup 產生的畫面上，並接好工具列、視角與復原等按鈕。 */
export class Workbench {
  readonly board: Board;
  private idleNote: string;

  constructor(
    private root: HTMLElement,
    cfg: TerrainConfig,
    audio: AudioManager,
    level: LevelDef,
  ) {
    const pg = root.querySelector('.playground') as HTMLElement;
    this.board = new Board(pg, cfg, audio);
    const note = root.querySelector('[data-role=note]') as HTMLElement;
    this.idleNote = note.textContent ?? '';
    this.board.onNote = (text) => (note.textContent = text);

    root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        this.setTool(b.dataset.tool as Tool);
        audio.play('click');
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        this.board.setView(b.dataset.view as ViewPreset);
        root.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
      }),
    );
    (root.querySelector('[data-act=contours]') as HTMLInputElement).addEventListener('change', (e) =>
      this.board.setContours((e.target as HTMLInputElement).checked),
    );
    root.querySelector('[data-act=undo]')!.addEventListener('click', () => {
      if (this.board.undo()) toast('已復原上一步');
      else toast('沒有可以復原的步驟');
    });
    root.querySelector('[data-act=reset]')!.addEventListener('click', async () => {
      const v = await modal('重新開始捏塑？', '<p>土盤會恢復到這一關一開始的樣子，黏土罐也會裝滿。</p>', [
        { label: '保留地形', value: 'keep' },
        { label: '重新開始', primary: true, value: 'reset' },
      ]);
      if (v === 'reset') {
        this.load(this.level);
        toast('重新開始這一關');
      }
    });
    this.level = level;
    this.load(level);
  }

  private level: LevelDef;

  load(level: LevelDef): void {
    this.level = level;
    this.board.load(level);
    this.setTool(SUGGESTED_TOOL[level.id] ?? 'drop');
    const note = this.root.querySelector('[data-role=note]');
    if (note) note.textContent = this.idleNote;
  }

  setTool(t: Tool): void {
    this.board.setTool(t);
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      const on = b.dataset.tool === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  destroy(): void {
    this.board.destroy();
  }
}
