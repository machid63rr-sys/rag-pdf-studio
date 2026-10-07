import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DiffSegment, DocumentSummary, OcrDraft, OcrDraftStatus, SearchResult } from '../../src/client/ragApi.js';
import { parseMultipart } from './multipart.js';

/*
 * ocr-rag(Python)の偽物。画面の結合テストで、本物のサーバ・DB・Ollamaなしに、APIの契約どおりに応答する。
 * 契約は ocr-rag/ocr_rag/api/*.py と同じ(状態の遷移・409・404・エラーの形式)。
 * OCRは自動では進まない。テストが progress() / complete() / fail() で進める(結果を決められるようにするため)。
 */

export interface FakeDraft extends OcrDraft {
  pdf: Buffer | null;
}

export interface FakeDocument extends DocumentSummary {
  readonly chunks: string[];
  pdf: Buffer | null;
}

export interface ReadyConfig {
  // false にすると /readyz は503
  ok: boolean;
  detail?: string;
  missingModels?: string[];
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake original pdf\n');

/** Markdownを、見出しごとのチャンクに分ける(本物の分割とは別物。件数が見出しに応じて変われば十分) */
export function fakeChunks(markdown: string): string[] {
  const chunks = markdown.split(/\n(?=#{1,6}\s)/).map((c) => c.trim()).filter((c) => c !== '');
  return chunks.length > 0 ? chunks : [markdown.trim()];
}

export class FakeRagServer {
  ready: ReadyConfig = { ok: true };
  readonly drafts = new Map<string, FakeDraft>();
  readonly documents: FakeDocument[] = [];
  // 受け取ったリクエスト(メソッドとパス)。呼び出しの有無・回数の確認用
  readonly requests: { method: string; path: string }[] = [];
  // 直近のOCR開始で受け取ったパスワード
  lastOcrPassword: string | null = null;
  // 設定すると、/search はこの結果をそのまま返す
  searchResults: SearchResult[] | null = null;
  // 直近の /search のリクエスト本文
  lastSearchBody: unknown = null;
  // 設定した文言で、全APIが500を返す(失敗時の画面の確認用)
  failAllWith: string | null = null;

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeRagServer> {
    let fake: FakeRagServer | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => fake?.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    fake = new FakeRagServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return fake;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- テストからの操作 ----

  /** 下書きを直接作る(画面を開く前の状態を用意する) */
  addDraft(partial: Partial<FakeDraft> & { source_file_name: string }): FakeDraft {
    const now = new Date().toISOString();
    const draft: FakeDraft = {
      id: randomUUID(),
      title: partial.source_file_name.replace(/\.pdf$/i, ''),
      status: 'DRAFT',
      page_count: 0,
      pages_done: 0,
      error_message: null,
      has_pdf: true,
      created_at: now,
      updated_at: now,
      draft_markdown: '',
      diff_segments: [],
      pdf: PDF_BYTES,
      ...partial,
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  addDocument(partial: Partial<FakeDocument> & { title: string; markdown: string }): FakeDocument {
    const { markdown, ...rest } = partial;
    const chunks = fakeChunks(markdown);
    const document: FakeDocument = {
      id: randomUUID(),
      source_file_name: `${partial.title}.md`,
      equipment_names: [],
      chunk_count: chunks.length,
      has_pdf: false,
      created_at: new Date().toISOString(),
      chunks,
      pdf: null,
      ...rest,
    };
    this.documents.unshift(document);
    return document;
  }

  /** OCRの進捗を進める(実行中になる) */
  progress(id: string, pagesDone: number, pageCount: number): void {
    this.update(id, { status: 'RUNNING', pages_done: pagesDone, page_count: pageCount });
  }

  complete(id: string, markdown: string, segments: readonly DiffSegment[], pageCount = 1): void {
    this.update(id, { status: 'DRAFT', draft_markdown: markdown, diff_segments: segments, page_count: pageCount, pages_done: pageCount });
  }

  fail(id: string, message: string): void {
    this.update(id, { status: 'FAILED', error_message: message });
  }

  draftOf(id: string): FakeDraft {
    const draft = this.drafts.get(id);
    if (draft === undefined) {
      throw new Error(`下書き ${id} がありません`);
    }
    return draft;
  }

  latestDraft(): FakeDraft {
    const all = [...this.drafts.values()];
    const last = all[all.length - 1];
    if (last === undefined) {
      throw new Error('下書きがありません');
    }
    return last;
  }

  private update(id: string, patch: Partial<FakeDraft>): void {
    this.drafts.set(id, { ...this.draftOf(id), ...patch, updated_at: new Date().toISOString() });
  }

  // ---- HTTP ----

  private handle(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname });
    if (this.failAllWith !== null && url.pathname !== '/readyz') {
      this.json(res, 500, { detail: this.failAllWith });
      return;
    }
    const segments = url.pathname.split('/').filter((s) => s !== '');
    const [root, id, sub] = segments;

    if (root === 'healthz') {
      this.json(res, 200, { status: 'ok' });
    } else if (root === 'readyz') {
      this.readyz(res);
    } else if (root === 'ocr-drafts') {
      this.ocrDrafts(req, res, body, method, id, sub);
    } else if (root === 'documents') {
      this.documentsRoute(req, res, body, method, id, sub);
    } else if (root === 'equipment-names' && method === 'GET') {
      const names = [...new Set(this.documents.flatMap((d) => d.equipment_names))].sort();
      this.json(res, 200, names.map((equipment_name) => ({ equipment_name })));
    } else if (root === 'search' && method === 'POST') {
      this.search(res, body);
    } else {
      this.json(res, 404, { detail: 'Not Found' });
    }
  }

  private readyz(res: ServerResponse): void {
    if (this.ready.ok) {
      this.json(res, 200, { status: 'ok', missing_models: [] });
    } else {
      this.json(res, 503, { status: 'error', detail: this.ready.detail ?? 'Ollamaに未取得のモデルがあります', missing_models: this.ready.missingModels ?? [] });
    }
  }

  private ocrDrafts(req: IncomingMessage, res: ServerResponse, body: Buffer, method: string, id: string | undefined, sub: string | undefined): void {
    if (id === undefined) {
      if (method === 'POST') {
        const parts = parseMultipart(req.headers['content-type'] ?? '', body);
        const file = parts.find((p) => p.name === 'file');
        if (file === undefined || file.filename === null) {
          this.json(res, 422, { detail: [{ msg: 'Field required' }] });
          return;
        }
        if (!file.filename.toLowerCase().endsWith('.pdf')) {
          this.json(res, 400, { detail: 'PDFファイルのみ対応しています' });
          return;
        }
        this.lastOcrPassword = parts.find((p) => p.name === 'password')?.data.toString('utf8') ?? null;
        const draft = this.addDraft({ source_file_name: file.filename, status: 'QUEUED', pdf: file.data });
        this.json(res, 202, this.publicDraft(draft));
      } else if (method === 'GET') {
        const live = [...this.drafts.values()].filter((d) => d.status !== 'DISCARDED').reverse();
        this.json(res, 200, live.map(({ draft_markdown: _m, diff_segments: _s, pdf: _p, ...summary }) => summary));
      } else {
        this.json(res, 405, { detail: 'Method Not Allowed' });
      }
      return;
    }

    const draft = this.drafts.get(id);
    if (draft === undefined) {
      this.json(res, 404, { detail: `下書き ${id} が見つかりません` });
      return;
    }
    if (sub === undefined && method === 'GET') {
      this.json(res, 200, this.publicDraft(draft));
    } else if (sub === undefined && method === 'PATCH') {
      if (draft.status !== 'DRAFT') {
        this.json(res, 409, { detail: `この下書きは${draft.status}のため編集できません（OCRが完了した下書きだけ編集できます）` });
        return;
      }
      this.update(id, { draft_markdown: (JSON.parse(body.toString('utf8')) as { draft_markdown: string }).draft_markdown });
      this.json(res, 200, this.publicDraft(this.draftOf(id)));
    } else if (sub === 'discard' && method === 'POST') {
      if (draft.status === 'DISCARDED') {
        this.json(res, 409, { detail: 'この下書きは既に破棄されています' });
        return;
      }
      this.update(id, { status: 'DISCARDED', has_pdf: false, pdf: null });
      this.json(res, 200, { message: '下書きを破棄しました。' });
    } else if (sub === 'pdf' && method === 'GET') {
      if (draft.pdf === null) {
        this.json(res, 404, { detail: `下書き ${id} の原本PDFはありません` });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''draft.pdf" });
      res.end(draft.pdf);
    } else {
      this.json(res, 404, { detail: 'Not Found' });
    }
  }

  private documentsRoute(req: IncomingMessage, res: ServerResponse, body: Buffer, method: string, id: string | undefined, sub: string | undefined): void {
    if (id === undefined && method === 'GET') {
      this.json(res, 200, this.documents.map(({ chunks: _c, pdf: _p, ...summary }) => summary));
    } else if (id === undefined && method === 'POST') {
      const parts = parseMultipart(req.headers['content-type'] ?? '', body);
      const markdown = parts.find((p) => p.name === 'markdown_file');
      if (markdown === undefined || markdown.filename === null) {
        this.json(res, 422, { detail: [{ msg: 'Field required' }] });
        return;
      }
      const text = markdown.data.toString('utf8');
      if (text.trim() === '') {
        this.json(res, 400, { detail: `${markdown.filename}: 本文が空です` });
        return;
      }
      const pdf = parts.find((p) => p.name === 'pdf_file');
      const title = parts.find((p) => p.name === 'title')?.data.toString('utf8') || markdown.filename.replace(/\.[^.]+$/, '');
      const equipmentNames = parts.filter((p) => p.name === 'equipment_names').map((p) => p.data.toString('utf8').trim()).filter((n) => n !== '');
      // 同じファイル名の再登録は、置き換える
      const existing = this.documents.findIndex((d) => d.source_file_name === markdown.filename);
      const previousPdf = existing >= 0 ? this.documents[existing]?.pdf ?? null : null;
      if (existing >= 0) {
        this.documents.splice(existing, 1);
      }
      const pdfData = pdf?.data ?? previousPdf;
      const document = this.addDocument({
        title, markdown: text, source_file_name: markdown.filename, equipment_names: [...new Set(equipmentNames)],
        has_pdf: pdfData !== null, pdf: pdfData,
      });
      const { chunks: _c, pdf: _p, ...summary } = document;
      this.json(res, 201, summary);
    } else if (id !== undefined && sub === 'pdf' && method === 'GET') {
      const document = this.documents.find((d) => d.id === id);
      if (document?.pdf === null || document === undefined) {
        this.json(res, 404, { detail: `マニュアル ${id} の原本PDFは登録されていません` });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''document.pdf" });
      res.end(document.pdf);
    } else {
      this.json(res, 404, { detail: 'Not Found' });
    }
  }

  private search(res: ServerResponse, body: Buffer): void {
    const request = JSON.parse(body.toString('utf8')) as { query?: string; equipment_name?: string; top_k?: number };
    this.lastSearchBody = request;
    if (this.searchResults !== null) {
      this.json(res, 200, this.searchResults);
      return;
    }
    if (request.query === undefined || request.query.trim() === '') {
      this.json(res, 422, { detail: [{ msg: '検索クエリが空です' }] });
      return;
    }
    const terms = request.query.split(/\s+/).filter((t) => t !== '');
    const candidates = this.documents
      .filter((d) => request.equipment_name === undefined || d.equipment_names.length === 0 || d.equipment_names.includes(request.equipment_name))
      .flatMap((d) => d.chunks.map((content): SearchResult => ({
        content,
        document_title: d.title,
        document_id: d.id,
        // 質問の語を含む本文は高く、含まない本文は低くする(本物の類似度ではない)
        similarity: terms.some((t) => content.includes(t)) ? 0.8 : 0.3,
      })))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, request.top_k ?? 5);
    this.json(res, 200, candidates);
  }

  private publicDraft(draft: FakeDraft): OcrDraft {
    const { pdf: _pdf, ...rest } = draft;
    return rest;
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }
}

export type { OcrDraftStatus };
