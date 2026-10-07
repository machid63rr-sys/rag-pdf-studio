import { DEFAULT_PAGE_SETTINGS, parsePageSettings, type PageSettings } from '../shared/pageSettings';

/*
 * ページ設定(用紙・向き・余白・ページ番号)を、ブラウザに覚えておく。次に文書を開いたときも、前回の設定で始まる。
 * 保存できない・読めない・壊れている場合は、既定の設定で始める(編集・出力は、そのまま使える)。
 */

const KEY = 'md-pdf-editor:page-settings';

// localStorage と同じ形。テストでは、メモリ上の代役を渡す
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// プライベートウィンドウ・サイトデータの無効化などでは、localStorage に触れるだけで例外になることがある
function browserStorage(): SettingsStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadPageSettings(storage: SettingsStorage | undefined = browserStorage()): PageSettings {
  try {
    const raw = storage?.getItem(KEY);
    if (raw !== null && raw !== undefined) {
      return parsePageSettings(JSON.parse(raw)) ?? DEFAULT_PAGE_SETTINGS;
    }
  } catch {
    // 読めない・壊れている: 既定にする
  }
  return DEFAULT_PAGE_SETTINGS;
}

export function savePageSettings(settings: PageSettings, storage: SettingsStorage | undefined = browserStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても、設定は、この画面の間は使える
  }
}
