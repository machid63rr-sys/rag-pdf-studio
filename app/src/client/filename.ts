/*
 * 出力ファイル名(拡張子なし)の検証と、取り込んだファイル名からの初期値の生成。
 * 利用者が入力した名前は、黙って書き換えず、使えない場合は理由を表示する。
 * 書き換えるのは、取り込んだファイル名から作る「初期値」だけ。
 */

const INVALID_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/;
const INVALID_CHARACTERS_GLOBAL = /[\\/:*?"<>|\u0000-\u001f]/g;
// Windowsの予約名。「con.md」のように拡張子が付いても予約扱いになるため、最初のドットより前で判定する
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SOURCE_EXTENSION = /\.(md|markdown|mdown|txt|html?|xhtml)$/i;
// 「.markdown」「.pdf」「.html」を付けても255バイトに収まる余裕を持たせる
const MAX_BYTES = 200;
const FALLBACK_NAME = 'document';

export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export function validateBaseName(name: string): NameCheck {
  if (name === '') {
    return { ok: false, message: 'ファイル名を入力してください。' };
  }
  if (INVALID_CHARACTERS.test(name)) {
    return { ok: false, message: 'ファイル名に次の文字は使えません: \\ / : * ? " < > |' };
  }
  if (name !== name.trim()) {
    return { ok: false, message: 'ファイル名の先頭・末尾に空白は使えません。' };
  }
  if (name.endsWith('.')) {
    return { ok: false, message: 'ファイル名の末尾に「.」は使えません。' };
  }
  if (RESERVED_NAME.test(name.split('.')[0] ?? '')) {
    return { ok: false, message: `「${name}」はWindowsで予約されている名前のため使えません。` };
  }
  if (byteLength(name) > MAX_BYTES) {
    return { ok: false, message: `ファイル名が長すぎます(UTF-8で${MAX_BYTES}バイトまで)。` };
  }
  return { ok: true };
}

function truncateToBytes(value: string, maxBytes: number): string {
  let result = '';
  for (const char of value) {
    if (byteLength(result + char) > maxBytes) {
      break;
    }
    result += char;
  }
  return result;
}

// 取り込んだファイル名(貼り付けならnull)から、出力ファイル名の初期値を作る
export function defaultBaseName(sourceName: string | null): string {
  if (sourceName === null) {
    return FALLBACK_NAME;
  }
  const candidate = truncateToBytes(
    sourceName.replace(SOURCE_EXTENSION, '').replace(INVALID_CHARACTERS_GLOBAL, '_').trim().replace(/\.+$/, ''),
    MAX_BYTES,
  ).trim();
  return validateBaseName(candidate).ok ? candidate : FALLBACK_NAME;
}
