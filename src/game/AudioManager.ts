type Sound = 'grab' | 'drop' | 'empty' | 'pass' | 'fail' | 'click';

/** 音效用 Web Audio 即時合成，不需要音檔。iOS 要在點擊事件裡先 unlock。 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  muted = false;

  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find((v) => v.lang === 'zh-TW') ?? vs.find((v) => v.lang.startsWith('zh')) ?? null;
      };
      pick();
      speechSynthesis.addEventListener('voiceschanged', pick);
      // iOS：第一次說話必須在使用者點擊時觸發
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  }

  play(s: Sound): void {
    if (this.muted || !this.ctx) return;
    const seq: Record<Sound, [number, number][]> = {
      grab: [[440, 0.07], [660, 0.09]],
      drop: [[220, 0.12]],
      empty: [[300, 0.12], [200, 0.16]],
      pass: [[523, 0.12], [659, 0.12], [784, 0.12], [1046, 0.25]],
      fail: [[392, 0.15], [330, 0.25]],
      click: [[880, 0.04]],
    };
    let t = this.ctx.currentTime;
    for (const [f, d] of seq[s]) {
      this.tone(f, t, d, s === 'drop' ? 'sine' : 'triangle');
      t += d * 0.9;
    }
  }

  /** 倒數用的短嗶聲。 */
  beep(freq: number, dur: number): void {
    if (this.muted || !this.ctx) return;
    this.tone(freq, this.ctx.currentTime, dur, 'square');
  }

  speak(text: string): void {
    if (this.muted || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    if (this.voice) u.voice = this.voice;
    u.rate = 1;
    speechSynthesis.speak(u);
  }

  private tone(freq: number, at: number, dur: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}
