/**
 * ブラウザのダウンロード機能でファイルを保存する。保存先はブラウザのダウンロード設定に従う。
 * フォルダ選択(File System Access API)と違い、ブラウザの種類や、フォルダの制限(システムフォルダ等)に左右されない。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // ダウンロードの開始後に解放する(すぐに解放すると、保存が始まる前にURLが無効になることがある)
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
