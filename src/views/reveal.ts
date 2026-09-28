import type { Settlement } from '../../worker/src/logic';
import type { AudioManager } from '../game/AudioManager';
import { esc } from '../ui/dom';

const teamName = (n: number) => `第 ${n} 組`;
const starText = (v: number) => '★'.repeat(Math.floor(v)) + '☆'.repeat(5 - Math.floor(v));

interface Entry {
  name: string;
  score: number;
  rank: number;
  sub: string;
}

/** 結算揭曉：深綠舞台、逐一登場、數字累加、亮星、頒獎台與彩帶。資料來自伺服器保存的結算結果。 */
export function revealHtml(s: Settlement, title: string): string {
  const entries: Entry[] =
    s.mode === 'team'
      ? s.teams
          .filter((t) => t.rank !== null)
          .map((t) => ({
            name: teamName(t.team),
            score: t.avg,
            rank: t.rank!,
            sub: t.members.map((m) => m.name).join('、'),
          }))
      : s.ranking.slice(0, 10).map((r) => ({ name: r.name, score: r.stars, rank: r.rank, sub: `${String(r.no).padStart(2, '0')} 號` }));
  const top = entries.slice(0, 3);
  const order = top.length === 3 ? [top[1], top[0], top[2]] : top;
  const total = entries.length;
  const delay = (rank: number) => Math.max(0, total - rank) * 350;
  const confetti = Array.from(
    { length: 26 },
    (_, i) => `<i class="confetti" style="--x:${i * 4}%;--d:${(i % 5) * 0.3 + 1}s;--c:${['#eaca76', '#dbe8b9', '#e69f67'][i % 3]}"></i>`,
  ).join('');
  const rest = entries.slice(3);
  return `<section class="reveal">${confetti}<div class="eyebrow" style="color:#bacba3">A ROUND OF APPLAUSE FOR EVERYONE</div>
<h2>一起捏出，我們的高光時刻。</h2><p class="reveal-sub">${esc(title)} · 全班平均 ${s.classAvg.toFixed(1)} 顆星</p>
<div class="podiums">${order
    .map(
      (e) => `<div class="podium" style="animation-delay:${delay(e.rank)}ms"><h3>${e.rank === 1 ? '✦ ' : ''}${esc(e.name)}</h3>
<p><span class="count-score" data-score="${e.score}" data-delay="${delay(e.rank)}">0.0</span> <span style="font-size:15px">★</span></p>
<div class="reveal-stars" style="font-size:17px;color:#eaca76;margin-bottom:12px">☆☆☆☆☆</div><div class="bar" style="height:${210 - e.rank * 35}px">${e.rank}</div><div class="podium-sub">${esc(e.sub)}</div></div>`,
    )
    .join('')}</div>
${rest.length ? `<div class="reveal-rest">${rest.map((e) => `<span>第 ${e.rank} 名　${esc(e.name)}　${e.score.toFixed(1)} ★</span>`).join('')}</div>` : ''}
<p class="reveal-note">${s.mode === 'team' ? '小組分數＝組員最高星數的平均，沒作答的同學以 0 星計入。' : '個人成績取最高星數。'}平均取小數點後 1 位，同分並列同名次。</p>
<button class="secondary" data-act="back-board" style="margin-top:15px">返回計分面板</button></section>`;
}

/** 數字從 0 累加到分數、星星跟著亮起；全部揭曉後播放音效。 */
export function animateReveal(root: HTMLElement, audio: AudioManager): void {
  const start = performance.now();
  const nodes = [...root.querySelectorAll<HTMLElement>('.count-score')];
  let fanfare = false;
  const frame = (now: number) => {
    let pending = false;
    for (const el of nodes) {
      if (!el.isConnected) continue;
      const t = Math.max(0, Math.min(1, (now - start - Number(el.dataset.delay)) / 1400));
      const value = Number(el.dataset.score) * (1 - Math.pow(1 - t, 3));
      el.textContent = value.toFixed(1);
      const starsEl = el.parentElement?.nextElementSibling;
      if (starsEl) starsEl.textContent = starText(value);
      if (t < 1) pending = true;
    }
    if (pending) requestAnimationFrame(frame);
    else if (!fanfare && nodes.length && nodes[0].isConnected) {
      fanfare = true;
      audio.play('pass');
    }
  };
  requestAnimationFrame(frame);
}
