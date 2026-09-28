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

/**
 * 顯示對話框，回傳使用者按的按鈕 value（按 Esc 或關閉則為 'cancel'）。
 * bodyHtml 必須是已跳脫的 HTML。
 */
export function modal(title: string, bodyHtml: string, buttons: ModalButton[] = [{ label: '知道了', primary: true, value: 'ok' }]): Promise<string> {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  if (dlg.open) dlg.close('cancel');
  dlg.innerHTML = `<h2>${esc(title)}</h2>${bodyHtml}<div class="dialog-actions">${buttons
    .map(
      (b) =>
        `<button type="button" class="${b.primary ? 'primary' : 'secondary'}${b.danger ? ' danger' : ''}" data-value="${esc(b.value)}">${esc(b.label)}</button>`,
    )
    .join('')}</div>`;
  return new Promise((resolve) => {
    const onClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest('button[data-value]') as HTMLButtonElement | null;
      if (btn) dlg.close(btn.dataset.value);
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener(
      'close',
      () => {
        dlg.removeEventListener('click', onClick);
        resolve(dlg.returnValue || 'cancel');
      },
      { once: true },
    );
    dlg.returnValue = '';
    dlg.showModal();
  });
}

export function closeModal(): void {
  const dlg = document.getElementById('modal') as HTMLDialogElement;
  if (dlg.open) dlg.close('cancel');
}

export function isModalOpen(): boolean {
  return (document.getElementById('modal') as HTMLDialogElement).open;
}
