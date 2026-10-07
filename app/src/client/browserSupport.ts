export interface PickerEnvironment {
  readonly isSecureContext: boolean;
  readonly showDirectoryPicker?: unknown;
}

export type PickerSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/*
 * File System Access API が使えるかを判定する。
 * 使えない場合は、ダウンロード等へ黙って切り替えず、理由を利用者に示す。
 */
function checkSupport(env: PickerEnvironment, api: unknown, feature: string): PickerSupport {
  if (!env.isSecureContext) {
    return {
      supported: false,
      reason: `この接続(http://IPアドレスなど)では${feature}を利用できません。http://localhost:ポート番号 でアクセスしてください。`,
    };
  }
  if (typeof api !== 'function') {
    return {
      supported: false,
      reason: `このブラウザは${feature}に対応していません。Chrome または Edge をお使いください。`,
    };
  }
  return { supported: true };
}

/** 「フォルダを選んで、そこへ書き込む」が使えるか */
export const checkDirectoryPickerSupport = (env: PickerEnvironment): PickerSupport =>
  checkSupport(env, env.showDirectoryPicker, 'フォルダへの直接出力');
