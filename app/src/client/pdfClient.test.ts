import { describe, expect, it } from 'vitest';
import { PdfRequestError, requestPdf, type FetchLike, type PdfSource } from './pdfClient';

const markdown = (text: string): PdfSource => ({ kind: 'markdown', text });

const pdfResponse = (): Response =>
  new Response('%PDF-1.7 dummy', { status: 200, headers: { 'Content-Type': 'application/pdf' } });

const jsonError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { code: 'x', message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('requestPdf', () => {
  it('MarkdownをJSONで /api/pdf へPOSTし、PDFのBlobを返す', async () => {
    let captured: { input: string; init: RequestInit } | undefined;
    const fetchFn: FetchLike = (input, init) => {
      captured = { input, init };
      return Promise.resolve(pdfResponse());
    };

    const blob = await requestPdf(markdown('# 見出し'), fetchFn);

    expect(captured?.input).toBe('/api/pdf');
    expect(captured?.init.method).toBe('POST');
    expect(JSON.parse(String(captured?.init.body))).toEqual({ markdown: '# 見出し' });
    expect(await blob.text()).toBe('%PDF-1.7 dummy');
  });

  it('Markdownに添えた画像は、baseDirとassetsとして送る(画像が無ければ、含めない)', async () => {
    const bodies: unknown[] = [];
    const fetchFn: FetchLike = (_input, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(pdfResponse());
    };
    await requestPdf({ kind: 'markdown', text: '![図](a.png)', baseDir: 'docs', assets: { 'docs/a.png': 'data:image/png;base64,AAAA' } }, fetchFn);
    await requestPdf({ kind: 'markdown', text: '本文', baseDir: 'docs', assets: {} }, fetchFn);
    expect(bodies).toEqual([
      { markdown: '![図](a.png)', baseDir: 'docs', assets: { 'docs/a.png': 'data:image/png;base64,AAAA' } },
      { markdown: '本文' },
    ]);
  });

  it('HTMLは {html: …} としてPOSTする', async () => {
    let body: unknown;
    const fetchFn: FetchLike = (_input, init) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(pdfResponse());
    };
    await requestPdf({ kind: 'html', text: '<p>本文</p>' }, fetchFn);
    expect(body).toEqual({ html: '<p>本文</p>' });
  });

  it('サーバが返したエラーメッセージをそのまま例外にする', async () => {
    const fetchFn: FetchLike = () => Promise.resolve(jsonError(413, 'Markdownが大きすぎます。'));
    await expect(requestPdf(markdown('x'), fetchFn)).rejects.toThrowError('Markdownが大きすぎます。');
    await expect(requestPdf(markdown('x'), fetchFn)).rejects.toBeInstanceOf(PdfRequestError);
  });

  it('JSONでないエラー応答は、HTTPステータスを示すメッセージにする', async () => {
    const fetchFn: FetchLike = () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(requestPdf(markdown('x'), fetchFn)).rejects.toThrowError('HTTP 502');
  });

  it('接続できない場合は、起動確認を促すメッセージにする', async () => {
    const fetchFn: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(requestPdf(markdown('x'), fetchFn)).rejects.toThrowError('サーバに接続できませんでした');
  });

  it('成功応答でもPDFでなければ例外にする', async () => {
    const fetchFn: FetchLike = () =>
      Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(requestPdf(markdown('x'), fetchFn)).rejects.toThrowError('PDFではありません');
  });
});

describe('ページ設定(pageSettings)', () => {
  const custom = { paper: 'B5', orientation: 'landscape', margin: 'wide', pageNumbers: false } as const;
  const send = async (source: PdfSource): Promise<unknown> => {
    let body: unknown;
    const fetchFn: FetchLike = (_input, init) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(pdfResponse());
    };
    await requestPdf(source, fetchFn);
    return body;
  };

  it('Markdown・HTMLのどちらも、ページ設定を添えて送る', async () => {
    expect(await send({ kind: 'markdown', text: '# a', pageSettings: custom })).toEqual({ markdown: '# a', pageSettings: custom });
    expect(await send({ kind: 'html', text: '<p>a</p>', pageSettings: custom })).toEqual({ html: '<p>a</p>', pageSettings: custom });
  });

  it('画像つきのMarkdownにも、ページ設定を添える', async () => {
    expect(await send({ kind: 'markdown', text: '![図](a.png)', baseDir: 'd', assets: { 'd/a.png': 'data:image/png;base64,AA==' }, pageSettings: custom })).toEqual({
      markdown: '![図](a.png)',
      baseDir: 'd',
      assets: { 'd/a.png': 'data:image/png;base64,AA==' },
      pageSettings: custom,
    });
  });

  it('省略すれば、含めない(サーバが、既定にする)', async () => {
    expect(await send(markdown('# a'))).toEqual({ markdown: '# a' });
  });
});

