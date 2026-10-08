import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatMessage, ChatSession, DiffSegment, DocumentSummary, ManualReference, OcrDraft, OcrDraftStatus, SearchResult } from '../../src/client/ragApi.js';
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

export interface FakeChatSession extends Omit<ChatSession, 'title'> {
  // 最初の質問で決まる(本物と同じ)
  title: string | null;
  messages: ChatMessage[];
}

/** 質問に対して、偽サーバが流す回答 */
export interface ChatReply {
  // 最初に流す、参照マニュアル(根拠が無いときは null)
  references: ManualReference[] | null;
  // 順に流す、回答の断片
  chunks: string[];
  // 設定すると、断片をすべて流したあと、完了の代わりに、このエラーのイベントを流す
  error?: string;
  // true にすると、完了もエラーも流さずに、ストリームを終える(サーバーが途中で落ちたときの再現)
  endWithoutDone?: boolean;
  // 設定すると、この個数の断片を流したあと、releaseChat() が呼ばれる(または、ブラウザが切断する)まで止まる
  holdAfterChunks?: number;
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
  // ---- チャット ----
  readonly chatSessions: FakeChatSession[] = [];
  chatReply: ChatReply = { references: null, chunks: ['回答です。'] };
  // 設定すると、質問の送信(ストリームの開始前)が、この状態・理由で失敗する
  chatMessageError: { status: number; detail: string } | null = null;
  // 受け取った質問(会話のIDと本文)
  readonly chatQuestions: { sessionId: string; question: string }[] = [];
  // 直近の、会話の作成のリクエスト本文
  lastCreateSessionBody: unknown = null;
  // 回答の途中で、ブラウザが切断した(停止した)回数
  chatAborted = 0;
  // 回答のストリームが、holdAfterChunks で止まっているか
  chatHeld = false;
  private chatRelease: (() => void) | null = null;

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

  /** 会話を直接作る(画面を開く前の状態を用意する)。新しい会話が、一覧の先頭になる */
  addChatSession(partial: Partial<FakeChatSession> = {}): FakeChatSession {
    const session: FakeChatSession = {
      session_id: randomUUID(),
      equipment_name: null,
      title: null,
      created_at: new Date().toISOString(),
      messages: [],
      ...partial,
    };
    this.chatSessions.unshift(session);
    return session;
  }

  /** チャットの状態を、初期状態に戻す */
  resetChat(): void {
    this.chatSessions.length = 0;
    this.chatReply = { references: null, chunks: ['回答です。'] };
    this.chatMessageError = null;
    this.chatQuestions.length = 0;
    this.lastCreateSessionBody = null;
    this.chatAborted = 0;
    this.chatHeld = false;
    this.chatRelease?.();
  }

  /** holdAfterChunks で止めていた回答を、続きから流す */
  releaseChat(): void {
    this.chatRelease?.();
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
    } else if (root === 'chat' && id === 'sessions') {
      this.chatRoute(res, body, method, segments[2], segments[3]);
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

  private chatRoute(res: ServerResponse, body: Buffer, method: string, sessionId: string | undefined, sub: string | undefined): void {
    if (sessionId === undefined) {
      if (method === 'POST') {
        const request = JSON.parse(body.toString('utf8')) as { equipment_name?: string | null };
        this.lastCreateSessionBody = request;
        const session = this.addChatSession({ equipment_name: request.equipment_name ?? null });
        this.json(res, 201, { session_id: session.session_id, equipment_name: session.equipment_name, created_at: session.created_at });
      } else if (method === 'GET') {
        this.json(res, 200, this.chatSessions.map(({ messages: _messages, ...summary }) => summary));
      } else {
        this.json(res, 405, { detail: 'Method Not Allowed' });
      }
      return;
    }

    const session = this.chatSessions.find((s) => s.session_id === sessionId);
    if (session === undefined) {
      this.json(res, 404, { detail: `チャットセッション ${sessionId} が見つかりません` });
    } else if (sub === undefined && method === 'DELETE') {
      this.chatSessions.splice(this.chatSessions.indexOf(session), 1);
      res.writeHead(204);
      res.end();
    } else if (sub === 'messages' && method === 'GET') {
      this.json(res, 200, session.messages);
    } else if (sub === 'messages' && method === 'POST') {
      this.chatAnswer(res, body, session);
    } else {
      this.json(res, 404, { detail: 'Not Found' });
    }
  }

  /** 質問を受け取り、回答をストリーム(改行区切りのJSON)で流す。保存は、本物と同じく、質問は先に、回答は完了したときだけ */
  private chatAnswer(res: ServerResponse, body: Buffer, session: FakeChatSession): void {
    if (this.chatMessageError !== null) {
      this.json(res, this.chatMessageError.status, { detail: this.chatMessageError.detail });
      return;
    }
    const question = (JSON.parse(body.toString('utf8')) as { question?: string }).question ?? '';
    if (question.trim() === '') {
      this.json(res, 400, { detail: '質問文が空です' });
      return;
    }
    this.chatQuestions.push({ sessionId: session.session_id, question });
    const now = (): string => new Date().toISOString();
    session.messages.push({ message_id: randomUUID(), role: 'user', content: question, manual_references: null, created_at: now() });
    session.title ??= question.slice(0, 255);

    const reply = this.chatReply;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const send = (event: unknown): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };
    // 回答の途中で、ブラウザが切断した(停止した)ことを知る。止めていた回答も、ここで解く
    let disconnected = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        disconnected = true;
        this.chatAborted += 1;
        this.chatRelease?.();
      }
    });

    void (async () => {
      send({ type: 'manual_references', manual_references: reply.references });
      for (const [index, text] of reply.chunks.entries()) {
        if (disconnected) {
          return;
        }
        send({ type: 'delta', text });
        if (reply.holdAfterChunks === index + 1) {
          this.chatHeld = true;
          await new Promise<void>((resolve) => {
            this.chatRelease = resolve;
          });
          this.chatRelease = null;
          this.chatHeld = false;
        }
      }
      if (disconnected) {
        return;
      }
      if (reply.error !== undefined) {
        send({ type: 'error', detail: reply.error });
      } else if (reply.endWithoutDone !== true) {
        const answer: ChatMessage = { message_id: randomUUID(), role: 'assistant', content: reply.chunks.join(''), manual_references: reply.references, created_at: now() };
        session.messages.push(answer);
        send({ type: 'done', message_id: answer.message_id, created_at: answer.created_at });
      }
      res.end();
    })();
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
