/*
 * 開いている下書きのIDを、このブラウザに覚えておく(再読み込みしても、続きから見られるように)。
 * localStorageが使えない(プライベートウィンドウ、サイトデータの無効化など)場合も、画面は動く(覚えないだけ)。
 */

const KEY = 'rag-pdf-studio.ocr.currentDraft';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// window.localStorageへの参照自体が例外になる環境があるため、使う時に取り出す
function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCurrentDraftId(storage: StorageLike | null = defaultStorage()): string | null {
  try {
    const value = storage?.getItem(KEY);
    return value === undefined || value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

export function saveCurrentDraftId(id: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY, id);
  } catch {
    // 覚えられないだけ。画面の動作には影響しない
  }
}

export function clearCurrentDraftId(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    // 同上
  }
}
