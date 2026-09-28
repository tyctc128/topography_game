// 學校 hspssso 統一登入。sso-client.js 由統一登入頁提供，不複製到本站。
import { params } from '../params';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const PORTAL = LOCAL ? 'http://localhost:3000' : 'https://hspssso-portal.vercel.app';

export interface Profile {
  account: string; // 學號
  name: string;
  role: string; // student | admin
  no: number | null;
}

interface SsoClient {
  ready: Promise<unknown>;
  login(returnTo?: string): void;
  logout(): Promise<void>;
  getUser(): { getIdToken(): Promise<string> } | null;
  getProfile(): Promise<Profile | null>;
  getCallbackResult(): { ok: boolean; error?: string } | null;
}

/**
 * 本機開發測試用：網址加 ?devUser=學號:角色:姓名 就用假身分（只在 npm run dev 時有效，
 * 正式建置會整段移除；伺服器端也只在本機開了 DEV_FAKE_AUTH 才接受）。
 */
const devUser = import.meta.env.DEV ? params.get('devUser') : null;

let client: Promise<SsoClient> | null = null;

function load(): Promise<SsoClient> {
  client ??= (async () => {
    const sso = (await import(/* @vite-ignore */ `${PORTAL}/sso-client.js`)) as SsoClient;
    await sso.ready;
    return sso;
  })();
  return client;
}

export async function getProfile(): Promise<Profile | null> {
  if (devUser) {
    const [account, role, name] = devUser.split(':');
    return { account, role: role || 'student', name: name || account, no: null };
  }
  return (await load()).getProfile();
}

/** 轉到統一登入頁；登入後回到 returnTo（預設目前網址）。 */
export async function login(returnTo = location.href): Promise<void> {
  (await load()).login(returnTo);
}

export async function logout(): Promise<void> {
  if (devUser) return;
  await (await load()).logout();
}

/** 每次呼叫 API 前取最新的 ID Token（SDK 會自動續期，不要自己存）。 */
export async function idToken(): Promise<string> {
  if (devUser) {
    const [account, role, name] = devUser.split(':');
    return `dev:${account}:${role || 'student'}:${encodeURIComponent(name || account)}`;
  }
  const u = (await load()).getUser();
  if (!u) throw new Error('not_logged_in');
  return u.getIdToken();
}

export async function callbackError(): Promise<string | null> {
  if (devUser) return null;
  const r = (await load()).getCallbackResult();
  return r && !r.ok ? (r.error ?? 'login_failed') : null;
}
