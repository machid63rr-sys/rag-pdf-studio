export class DecodeError extends Error {}

/**
 * ファイルの内容をUTF-8として厳密に読み込む。
 * UTF-8として不正なバイトがあれば、文字化けした本文を黙って取り込まず、例外にする。
 * 先頭のBOMは取り除かれる。改行コード(CRLF)はそのまま保持する。
 */
export function decodeUtf8Strict(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DecodeError(
      'UTF-8として読み込めませんでした。文字コードがShift_JISなどの場合は、UTF-8で保存し直してください。',
    );
  }
}
