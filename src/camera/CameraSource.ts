import type { Pt } from '../types';

export type Facing = 'environment' | 'user';

export class CameraSource {
  readonly video: HTMLVideoElement;
  facing: Facing = 'environment';
  private stream: MediaStream | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  get active(): boolean {
    return !!this.stream && this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** 前鏡頭畫面要左右鏡像，孩子看起來才自然。 */
  get mirrored(): boolean {
    return this.facing === 'user';
  }

  async start(facing: Facing): Promise<void> {
    if (!window.isSecureContext) throw new Error('insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    this.stop();
    this.facing = facing;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    });
    this.video.srcObject = this.stream;
    this.video.classList.toggle('mirrored', this.mirrored);
    this.video.classList.remove('hidden');
    await this.video.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** 影像正規化座標（0–1）→ 螢幕 CSS px；video 用 object-fit: cover 鋪滿。 */
  toScreen(x: number, y: number, sw: number, sh: number): Pt {
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    const scale = Math.max(sw / vw, sh / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const nx = this.mirrored ? 1 - x : x;
    return { x: (sw - dw) / 2 + nx * dw, y: (sh - dh) / 2 + y * dh };
  }
}
