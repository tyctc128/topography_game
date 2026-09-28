import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

// hspssso 的 Firebase ID Token：用 Google 公開的 JWKS 驗簽，不需要任何金鑰
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

let keySource: JWTVerifyGetKey = GOOGLE_JWKS;

/** 只給自動測試用：改用測試自己產生的金鑰。正式執行不會呼叫。 */
export function useKeysForTesting(keys: JWTVerifyGetKey | null): void {
  keySource = keys ?? GOOGLE_JWKS;
}

export interface Who {
  uid: string; // 學號，例如 hs112001
  name: string;
  no: number | null;
  role: string; // student | admin（admin = 老師）
}

export async function verifyToken(token: string, projectId: string): Promise<Who> {
  const { payload } = await jwtVerify(token, keySource, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  });
  if (!payload.sub) throw new Error('token has no sub');
  const no = Number(payload.no);
  return {
    uid: payload.sub,
    name: String(payload.studentName ?? payload.name ?? ''),
    no: Number.isFinite(no) && payload.no !== null && payload.no !== undefined ? no : null,
    role: String(payload.role ?? 'student'),
  };
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
