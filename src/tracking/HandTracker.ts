import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export interface RawHand {
  side: string; // 'Left' | 'Right'
  score: number;
  points: { x: number; y: number; z: number }[]; // 21 點，影像正規化座標
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastTs = 0;
  delegate: 'GPU' | 'CPU' = 'GPU';
  lastMs = 0;

  get ready(): boolean {
    return !!this.landmarker;
  }

  async init(): Promise<void> {
    const base = import.meta.env.BASE_URL + 'mediapipe/';
    const fileset = await FilesetResolver.forVisionTasks(base + 'wasm');
    const make = (delegate: 'GPU' | 'CPU') =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'hand_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await make('GPU');
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate 失敗，改用 CPU', e);
      this.landmarker = await make('CPU');
      this.delegate = 'CPU';
    }
  }

  detect(video: HTMLVideoElement): RawHand[] {
    if (!this.landmarker) return [];
    // 時間戳記必須遞增
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    const t0 = performance.now();
    const r = this.landmarker.detectForVideo(video, ts);
    this.lastMs = performance.now() - t0;
    const hands = r.handedness ?? [];
    return r.landmarks.map((points, i) => ({
      side: hands[i]?.[0]?.categoryName ?? `H${i}`,
      score: hands[i]?.[0]?.score ?? 0,
      points,
    }));
  }
}
