// 把 MediaPipe 的 wasm 與手部模型放進 public/mediapipe，讓網頁不依賴外部 CDN。
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'mediapipe');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const modelPath = join(outDir, 'hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

mkdirSync(outDir, { recursive: true });

if (!existsSync(join(outDir, 'wasm'))) {
  cpSync(wasmSrc, join(outDir, 'wasm'), { recursive: true });
  console.log('[setup] 已複製 MediaPipe wasm');
}

if (!existsSync(modelPath)) {
  console.log('[setup] 下載手部模型…');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`下載模型失敗：HTTP ${res.status}`);
  writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
  console.log('[setup] 已下載 hand_landmarker.task');
}
