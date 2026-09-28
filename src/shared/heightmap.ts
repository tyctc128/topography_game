// 前端與 Worker 共用：地形高度圖、問題區域遮罩的編碼（瀏覽器與 Workers 都有 CompressionStream）

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 高度 0–1 → Uint16 → gzip → base64（128×128 約數 KB 到數十 KB）。 */
export async function encodeHeights(h: Float32Array): Promise<string> {
  const u = new Uint16Array(h.length);
  for (let i = 0; i < h.length; i++) u[i] = Math.round(Math.min(1, Math.max(0, h[i])) * 65535);
  return toBase64(await pipe(new Uint8Array(u.buffer), new CompressionStream('gzip')));
}

/** encodeHeights 的反向；長度不對或資料壞掉會丟出錯誤。 */
export async function decodeHeights(b64: string, n: number): Promise<Float32Array> {
  if (typeof b64 !== 'string' || b64.length > 400_000) throw new Error('bad_terrain');
  const raw = await pipe(fromBase64(b64), new DecompressionStream('gzip'));
  if (raw.length !== n * n * 2) throw new Error('bad_terrain');
  const u = new Uint16Array(raw.buffer, raw.byteOffset, n * n);
  const h = new Float32Array(n * n);
  for (let i = 0; i < h.length; i++) h[i] = u[i] / 65535;
  return h;
}

/** 0/1 遮罩 → 位元組 → base64。 */
export function encodeMask(mask: Uint8Array): string {
  const bits = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >> 3] |= 1 << (i & 7);
  return toBase64(bits);
}

export function decodeMask(b64: string, length: number): Uint8Array {
  const bits = fromBase64(b64);
  const mask = new Uint8Array(length);
  for (let i = 0; i < length; i++) mask[i] = (bits[i >> 3] >> (i & 7)) & 1;
  return mask;
}
