/** HTML 跳脫：所有來自設定檔、伺服器或使用者的文字都要經過這裡。 */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T | null;

export const stars = (n: number, total = 5): string => '★'.repeat(Math.max(0, n)) + '☆'.repeat(Math.max(0, total - n));

let toastTimer = 0;
export function toast(text: string, ms = 3000): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

export interface ModalButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  value: string;
}

/** 目前顯示中的對話框；同一時間只有一個。 */
let active: { settle: (value: string) => void } | null = null;

/**
 * 顯示對話框，回傳使用者按的按鈕 value（按 Esc 或關閉則為 'cancel'）。
 * bodyHtml 必須是已跳脫的 HTML。
 *
 * 對話框開著時再呼叫一次，會直接換成新內容，舊的那個回傳 'cancel'。
 * 'close' 事件是非同步送出的：舊對話框遲到的 close 事件不能把新對話框的按鈕拆掉，
 * 所以按鈕的值在點擊當下就決定，close 事件只處理 Esc，而且對話框已重新打開時一律忽略。
 */
export function modal(title: string, bodyHtml: string, buttons: ModalButton[] = [{ label: '知道了', primary: true, value: 'ok' }]): Promise<string> {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  active?.settle('cancel');
  dlg.innerHTML = `<h2>${esc(title)}</h2>${bodyHtml}<div class="dialog-actions">${buttons
    .map(
      (b) =>
        `<button type="button" class="${b.primary ? 'primary' : 'secondary'}${b.danger ? ' danger' : ''}" data-value="${esc(b.value)}">${esc(b.label)}</button>`,
    )
    .join('')}</div>`;
  return new Promise((resolve) => {
    const me = {
      settle: (value: string) => {
        if (active !== me) return;
        active = null;
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('close', onClose);
        resolve(value);
      },
    };
    const onClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest('button[data-value]') as HTMLButtonElement | null;
      if (!btn) return;
      const value = btn.dataset.value ?? 'cancel';
      me.settle(value);
      if (dlg.open) dlg.close(value);
    };
    const onClose = () => {
      if (!dlg.open) me.settle(dlg.returnValue || 'cancel');
    };
    active = me;
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    if (!dlg.open) dlg.showModal();
  });
}

export function closeModal(): void {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  active?.settle('cancel');
  if (dlg.open) dlg.close('cancel');
}

export function isModalOpen(): boolean {
  return (document.getElementById('modal') as HTMLDialogElement).open;
}
