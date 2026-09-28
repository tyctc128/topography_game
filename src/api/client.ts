import { idToken } from '../auth/sso';

// 部署後由 GitHub Actions 帶入 VITE_API_BASE；本機開發連 wrangler dev
export const API_BASE: string =
  import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? 'http://localhost:8787' : 'https://topography-api.tyctc128.workers.dev');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { Authorization: `Bearer ${await idToken()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).message === 'not_logged_in') throw new ApiError(401, 'not_logged_in');
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? `http_${res.status}`);
  }
  return res;
}

export const api = {
  get: async <T>(path: string) => (await request('GET', path)).json() as Promise<T>,
  post: async <T>(path: string, body: unknown = {}) => (await request('POST', path, body)).json() as Promise<T>,
  put: async <T>(path: string, body: unknown) => (await request('PUT', path, body)).json() as Promise<T>,
  del: async <T>(path: string) => (await request('DELETE', path)).json() as Promise<T>,
  blob: async (path: string) => (await request('GET', path)).blob(),
};

/** 給小朋友和老師看的錯誤訊息。 */
export function errorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'network';
  return (
    {
      network: '連不上伺服器，請檢查網路後再試一次',
      not_logged_in: '請先用學校帳號登入',
      invalid_token: '登入已過期，請重新登入',
      not_in_roster: '老師還沒把你加入這個班級',
      quiz_not_open: '這份測驗目前沒有開放',
      quiz_closed: '老師已經關閉這份測驗了',
      time_up: '這一題的時間已經到了',
      no_checks_left: '這一題的檢查已經用過了',
      too_much_clay: '黏土的量不對，請重新捏一次',
      teacher_only: '只有老師帳號可以使用',
      close_first: '請先關閉測驗，再進行結算',
      need_questions: '題庫至少要有 2 題選擇題才能發布',
      bad_roster: '名單格式不對：每一列要有座號、帳號、姓名',
      duplicate_roster: '名單裡有重複的座號或帳號',
      bad_questions: '題目格式不對：每題要有題目、4 個選項和正確答案',
      no_previous_teams: '找不到上一次的分組',
      already_settled: '這份測驗已經結算，分組不能再改',
    } as Record<string, string>
  )[code] ?? `發生錯誤（${code}），請再試一次`;
}
