import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discardOcrDraft, documentPdfUrl, getReadiness, listEquipmentNames, listOcrDrafts, ocrDraftPdfUrl, RagApiError, registerDocument, searchManuals, startOcr, updateOcrDraft,
} from './ragApi';

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

// fetchを、決めた応答を返す代役に差し替える。呼び出し(宛先・メソッド・本文)を記録する
function mockFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
  return calls;
}

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('エラーの整形', () => {
  it('FastAPIのdetail(文字列)を、メッセージにする', async () => {
    mockFetch(() => jsonResponse(400, { detail: 'PDFファイルのみ対応しています' }));

    const error = await listOcrDrafts().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagApiError);
    expect(error).toMatchObject({ message: 'PDFファイルのみ対応しています', status: 400, code: null });
  });

  it('FastAPIの検証エラー(detailが配列)は、msgを「 / 」でつなぐ', async () => {
    mockFetch(() => jsonResponse(422, { detail: [{ msg: '検索クエリが空です' }, { msg: 'Field required' }] }));

    await expect(searchManuals({ query: ' ' })).rejects.toMatchObject({ message: '検索クエリが空です / Field required', status: 422 });
  });

  it('このサーバの形式({error:{code,message}})は、コードとメッセージを取り出す', async () => {
    mockFetch(() => jsonResponse(502, { error: { code: 'rag_unavailable', message: 'OCR・RAGサービスに接続できません。' } }));

    await expect(listOcrDrafts()).rejects.toMatchObject({ message: 'OCR・RAGサービスに接続できません。', status: 502, code: 'rag_unavailable' });
  });

  it('本文がJSONでないエラーは、状態を含む一般的なメッセージにする', async () => {
    mockFetch(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }));

    await expect(listOcrDrafts()).rejects.toMatchObject({ message: 'サーバーがエラーを返しました(502 Bad Gateway)', status: 502 });
  });

  it('接続できなかった場合は、状態0・コードnetworkのRagApiErrorにする', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));

    await expect(listOcrDrafts()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('中止(AbortError)は、エラーに変えず、そのまま投げる', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new DOMException('aborted', 'AbortError')));

    await expect(listOcrDrafts(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('② OCR', () => {
  it('startOcrは、PDFとパスワードをmultipartで /api/rag/ocr-drafts へ送る', async () => {
    const calls = mockFetch(() => jsonResponse(202, { id: 'd1', status: 'QUEUED' }));
    const file = new File(['%PDF-1.4'], 'R-1.pdf', { type: 'application/pdf' });

    const draft = await startOcr(file, 'secret');

    expect(draft).toMatchObject({ id: 'd1', status: 'QUEUED' });
    expect(calls[0]?.url).toBe('/api/rag/ocr-drafts');
    expect(calls[0]?.init?.method).toBe('POST');
    const form = calls[0]?.init?.body as FormData;
    expect((form.get('file') as File).name).toBe('R-1.pdf');
    expect(form.get('password')).toBe('secret');
  });

  it('パスワードが空なら、送らない', async () => {
    const calls = mockFetch(() => jsonResponse(202, {}));

    await startOcr(new File(['x'], 'a.pdf'), '');

    expect((calls[0]?.init?.body as FormData).has('password')).toBe(false);
  });

  it('updateOcrDraftは、本文をPATCHで送る', async () => {
    const calls = mockFetch(() => jsonResponse(200, {}));

    await updateOcrDraft('d 1', '修正後');

    expect(calls[0]?.url).toBe('/api/rag/ocr-drafts/d%201');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ draft_markdown: '修正後' });
  });

  it('discardOcrDraftは、破棄のPOSTを送る', async () => {
    const calls = mockFetch(() => jsonResponse(200, { message: 'ok' }));

    await discardOcrDraft('d1');

    expect(calls[0]?.url).toBe('/api/rag/ocr-drafts/d1/discard');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('原本PDFのURLは、IDをエンコードする', () => {
    expect(ocrDraftPdfUrl('a/b')).toBe('/api/rag/ocr-drafts/a%2Fb/pdf');
    expect(documentPdfUrl('x y')).toBe('/api/rag/documents/x%20y/pdf');
  });
});

describe('③ RAG', () => {
  it('registerDocumentは、Markdown・題名・タグ名(複数)・原本PDFをmultipartで送る', async () => {
    const calls = mockFetch(() => jsonResponse(201, { id: 'doc1' }));

    await registerDocument({
      markdown: '# 見出し\n本文', fileName: 'R-1.md', title: '  チラー  ', equipmentNames: ['R-1', 'R-2'],
      pdf: { blob: new Blob(['%PDF-1.4']), fileName: 'R-1.pdf' },
    });

    expect(calls[0]?.url).toBe('/api/rag/documents');
    const form = calls[0]?.init?.body as FormData;
    const markdown = form.get('markdown_file') as File;
    expect(markdown.name).toBe('R-1.md');
    expect(await markdown.text()).toBe('# 見出し\n本文');
    expect(form.get('title')).toBe('チラー');
    expect(form.getAll('equipment_names')).toEqual(['R-1', 'R-2']);
    expect((form.get('pdf_file') as File).name).toBe('R-1.pdf');
  });

  it('題名が空・タグ名なし・PDFなしなら、その項目を送らない', async () => {
    const calls = mockFetch(() => jsonResponse(201, {}));

    await registerDocument({ markdown: '本文', fileName: 'a.md', title: '  ', equipmentNames: [] });

    const form = calls[0]?.init?.body as FormData;
    expect(form.has('title')).toBe(false);
    expect(form.has('equipment_names')).toBe(false);
    expect(form.has('pdf_file')).toBe(false);
  });

  it('searchManualsは、タグ名が空なら絞り込みを送らず、top_kを送る', async () => {
    const calls = mockFetch(() => jsonResponse(200, []));

    await searchManuals({ query: 'ポンプ', equipmentName: '', topK: 10 });
    await searchManuals({ query: 'ポンプ', equipmentName: 'ESP-1' });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ query: 'ポンプ', top_k: 10 });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ query: 'ポンプ', equipment_name: 'ESP-1' });
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('listEquipmentNamesは、タグ名の文字列の配列にする', async () => {
    mockFetch(() => jsonResponse(200, [{ equipment_name: 'AHU-1' }, { equipment_name: 'ESP-1' }]));

    expect(await listEquipmentNames()).toEqual(['AHU-1', 'ESP-1']);
  });
});

describe('getReadiness', () => {
  it('200なら、使える状態', async () => {
    mockFetch(() => jsonResponse(200, { status: 'ok', missing_models: [] }));

    expect(await getReadiness()).toEqual({ ready: true, code: 'ok', message: '', missingModels: [] });
  });

  it('モデルが足りない503は、足りないモデルと説明を返す', async () => {
    mockFetch(() => jsonResponse(503, { status: 'error', detail: 'Ollamaに未取得のモデルがあります: glm-ocr', missing_models: ['glm-ocr'] }));

    expect(await getReadiness()).toEqual({ ready: false, code: 'models_missing', message: 'Ollamaに未取得のモデルがあります: glm-ocr', missingModels: ['glm-ocr'] });
  });

  it('OCR_RAG_URLが未設定(rag_not_configured)は、not_configuredにする', async () => {
    mockFetch(() => jsonResponse(503, { error: { code: 'rag_not_configured', message: 'OCR・RAGサービスが設定されていません' } }));

    expect(await getReadiness()).toMatchObject({ ready: false, code: 'not_configured', message: 'OCR・RAGサービスが設定されていません' });
  });

  it('中継が失敗した(502)場合は、そのメッセージを返す', async () => {
    mockFetch(() => jsonResponse(502, { error: { code: 'rag_unavailable', message: 'OCR・RAGサービスに接続できません。' } }));

    expect(await getReadiness()).toMatchObject({ ready: false, code: 'unavailable', message: 'OCR・RAGサービスに接続できません。' });
  });

  it('DBに接続できない503(モデルの不足なし)は、unavailableにする', async () => {
    mockFetch(() => jsonResponse(503, { status: 'error', detail: 'DB接続に失敗しました: x', missing_models: [] }));

    expect(await getReadiness()).toMatchObject({ ready: false, code: 'unavailable', message: 'DB接続に失敗しました: x' });
  });

  it('サーバーに接続できない場合も、例外にせず、使えない状態として返す', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));

    expect(await getReadiness()).toMatchObject({ ready: false, code: 'unavailable' });
  });
});
