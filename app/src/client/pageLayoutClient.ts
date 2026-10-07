import type { PageLayout } from '../shared/pageLayout';
import { PdfRequestError, defaultFetch, readErrorMessage, requestBody, type FetchLike, type PdfSource } from './pdfClient';

const isLayout = (value: unknown): value is PageLayout => {
  const layout = value as Partial<PageLayout> | null;
  return typeof layout === 'object' && layout !== null && typeof layout.pages === 'number' && Array.isArray(layout.starts);
};

/** MarkdownをPDFにしたときの、ページの区切り位置を、サーバに測ってもらう。中断(signal)できる */
export async function requestPageLayout(source: PdfSource, signal?: AbortSignal, fetchFn: FetchLike = defaultFetch): Promise<PageLayout> {
  let response: Response;
  try {
    response = await fetchFn('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(source)),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new PdfRequestError('サーバに接続できませんでした。');
  }
  if (!response.ok) {
    throw new PdfRequestError(await readErrorMessage(response));
  }
  const body: unknown = await response.json();
  if (!isLayout(body)) {
    throw new PdfRequestError('サーバの応答を読めませんでした。');
  }
  return body;
}
