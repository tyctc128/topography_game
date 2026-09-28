import type { HandView, Mode } from '../gesture/GestureRecognizer';
import type { Tool } from '../gesture/TouchInput';
import type { Pt } from '../types';

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const MODE_STYLE: Record<Mode, { color: string; label: string }> = {
  idle: { color: 'rgba(255,255,255,0.9)', label: '' },
  pinch: { color: '#ff9800', label: '捏高' },
  press: { color: '#2196f3', label: '壓平' },
  smooth: { color: '#43a047', label: '抹平' },
  hold: { color: '#7cb342', label: '拿著黏土' },
};

const TOOL_STYLE: Record<Tool, { color: string; label: string }> = {
  raise: MODE_STYLE.pinch,
  press: MODE_STYLE.press,
  smooth: MODE_STYLE.smooth,
  drop: { color: '#7cb342', label: '' },
  rotate: { color: '#8e24aa', label: '' },
};

export class Overlay {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number): void {
    const dpr = Math.min(2, window.devicePixelRatio);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(hands: HandView[], touch: { pos: Pt | null; tool: Tool; carrying: boolean }, showSkeleton: boolean): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const h of hands) {
      if (!h.points.length) continue;
      const style = MODE_STYLE[h.mode];
      c.lineWidth = 3;
      c.strokeStyle = showSkeleton ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.4)';
      c.beginPath();
      for (const [a, b] of BONES) {
        c.moveTo(h.points[a].x, h.points[a].y);
        c.lineTo(h.points[b].x, h.points[b].y);
      }
      c.stroke();
      if (showSkeleton) {
        c.fillStyle = '#fff';
        for (const p of h.points) {
          c.beginPath();
          c.arc(p.x, p.y, 3, 0, Math.PI * 2);
          c.fill();
        }
      }
      if (h.mode === 'hold') this.clayBall(h.cursor);
      else this.ring(h.cursor, style.color, h.mode === 'idle' ? 14 : 22);
      if (style.label) this.label(h.cursor, style.label, style.color);
      if (showSkeleton) this.label({ x: h.cursor.x, y: h.cursor.y + 58 }, `${h.pose}/${h.mode}`, '#333');
    }

    if (touch.pos && touch.carrying) {
      // 手指拿著黏土：黏土球畫在手指上方一點，才不會被手指擋住
      this.clayBall({ x: touch.pos.x, y: touch.pos.y - 40 });
    } else if (touch.pos) {
      const s = TOOL_STYLE[touch.tool];
      this.ring(touch.pos, s.color, 30);
      if (s.label) this.label(touch.pos, s.label, s.color);
    }
  }

  private ring(p: Pt, color: string, r: number): void {
    const c = this.ctx;
    c.lineWidth = 5;
    c.strokeStyle = color;
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.stroke();
  }

  private clayBall(p: Pt): void {
    const c = this.ctx;
    const g = c.createRadialGradient(p.x - 8, p.y - 8, 4, p.x, p.y, 28);
    g.addColorStop(0, '#dcedc8');
    g.addColorStop(1, '#689f38');
    c.fillStyle = g;
    c.beginPath();
    c.arc(p.x, p.y, 26, 0, Math.PI * 2);
    c.fill();
  }

  private label(p: Pt, text: string, color: string): void {
    const c = this.ctx;
    c.font = 'bold 20px system-ui, sans-serif';
    const w = c.measureText(text).width + 20;
    const x = p.x - w / 2;
    const y = p.y - 64;
    c.fillStyle = color;
    c.beginPath();
    c.roundRect(x, y, w, 32, 16);
    c.fill();
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, p.x, y + 16);
  }
}
