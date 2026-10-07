import type { PageSettings } from '../shared/pageSettings';

export class PdfRequestError extends Error {}

// PDFにする元。Markdownか、CSS適用済みのHTML(サーバは、どちらもそのまま受け取る)
export interface PdfSource {
  readonly kind: 'markdown' | 'html';
  readonly text: string;
  // Markdownの相対パスの画像(取り込んだ画像のdata: URI)。baseDirは、Markdownがあるフォルダ。HTMLは、画像を埋め込み済みで渡す
  readonly baseDir?: string;
  readonly assets?: Readonly<Record<string, string>>;
  // 用紙・向き・余白・ページ番号。省略すると、サーバの既定(A4縦・標準・ページ番号あり)。HTMLでは、ページ番号の有無だけが使われる
  readonly pageSettings?: PageSettings;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') {
      return body.error.message;
    }
  } catch {
    // JSONでない応答(プロキシのエラーページなど)は、下のステータス表示にまとめる
  }
  return `サーバがエラーを返しました (HTTP ${response.status})。`;
}

export function requestBody(source: PdfSource): Record<string, unknown> {
  const settings = source.pageSettings === undefined ? {} : { pageSettings: source.pageSettings };
  if (source.kind === 'html') {
    return { html: source.text, ...settings };
  }
  const hasAssets = source.assets !== undefined && Object.keys(source.assets).length > 0;
  return hasAssets ? { markdown: source.text, baseDir: source.baseDir ?? '', assets: source.assets, ...settings } : { markdown: source.text, ...settings };
}

/** 現在のMarkdownまたはHTMLからPDFを生成する。失敗した場合は、利用者に見せられるメッセージつきで例外にする */
export async function requestPdf(source: PdfSource, fetchFn: FetchLike = defaultFetch): Promise<Blob> {
  let response: Response;
  try {
    response = await fetchFn('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(source)),
    });
  } catch {
    throw new PdfRequestError('サーバに接続できませんでした。アプリが起動しているか確認してください。');
  }
  if (!response.ok) {
    throw new PdfRequestError(await readErrorMessage(response));
  }
  if (!(response.headers.get('content-type') ?? '').includes('application/pdf')) {
    throw new PdfRequestError('サーバの応答がPDFではありませんでした。');
  }
  return response.blob();
}
