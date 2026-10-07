/*
 * OCR・RAGサービス(ocr-rag、Python)のAPIクライアント。
 * ブラウザは、このアプリのサーバの /api/rag/* へ送り、サーバがocr-ragへ中継する(同じオリジンなので、CORSは要らない)。
 * エラーは、すべて RagApiError にそろえる(画面は、message をそのまま表示できる)。
 */

const BASE = '/api/rag';

export type OcrDraftStatus = 'QUEUED' | 'RUNNING' | 'DRAFT' | 'FAILED' | 'DISCARDED';

/** OCR下書きの、OCR結果の1箇所。「要確認」の箇所だけを人が確認すれば、全文を読み直さなくてよい */
export interface DiffSegment {
  readonly page: number;
  readonly segment_id: string;
  // キー名は旧方式(GLM-OCR 2回実行)時代のまま(保存済みの下書きとの互換のため)。
  // 現在の意味: glm_text=主文候補(vision LLM)、glm_alt_text=比較候補(GLM-OCR)
  readonly glm_text: string;
  readonly glm_alt_text: string;
  readonly status: 'match' | 'auto_corrected' | 'needs_review';
  readonly final_text: string;
  readonly reason: string | null;
}

export interface OcrDraftSummary {
  readonly id: string;
  readonly source_file_name: string;
  readonly title: string | null;
  readonly status: OcrDraftStatus;
  // 総ページ数(OCR待ちの間は0=未確定)と、OCR済みのページ数
  readonly page_count: number;
  readonly pages_done: number;
  readonly error_message: string | null;
  readonly has_pdf: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface OcrDraft extends OcrDraftSummary {
  readonly draft_markdown: string;
  readonly diff_segments: readonly DiffSegment[];
}

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly source_file_name: string;
  readonly equipment_names: readonly string[];
  readonly chunk_count: number;
  readonly has_pdf: boolean;
  readonly created_at: string;
}

export interface SearchResult {
  readonly content: string;
  readonly document_title: string;
  readonly document_id: string;
  // 類似度(1に近いほど、質問に近い内容)
  readonly similarity: number;
}

export type ReadinessCode = 'ok' | 'not_configured' | 'models_missing' | 'unavailable';

export interface Readiness {
  readonly ready: boolean;
  readonly code: ReadinessCode;
  // 画面にそのまま表示できる説明(ready のときは空)
  readonly message: string;
  readonly missingModels: readonly string[];
}

export class RagApiError extends Error {
  constructor(
    message: string,
    // HTTPの状態(接続できなかった場合は0)
    readonly status: number,
    // このサーバのエラーコード(rag_unavailable など)。無ければnull
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'RagApiError';
  }
}

const NETWORK_MESSAGE = 'サーバーに接続できません。ネットワークと、サービスの起動を確認してください。';

type ErrorBody = {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly detail?: unknown;
  readonly missing_models?: unknown;
};

async function readJson(response: Response): Promise<ErrorBody | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as ErrorBody) : null;
  } catch {
    return null;
  }
}

// FastAPIの422は、detail が [{loc, msg}, …] の配列になる
function detailText(detail: unknown): string | null {
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item: unknown) => {
      const msg = (item as { msg?: unknown } | null)?.msg;
      return typeof msg === 'string' ? [msg] : [];
    });
    return messages.length > 0 ? messages.join(' / ') : null;
  }
  return null;
}

async function toApiError(response: Response): Promise<RagApiError> {
  const body = await readJson(response);
  const code = typeof body?.error?.code === 'string' ? body.error.code : null;
  const message = (typeof body?.error?.message === 'string' ? body.error.message : null) ?? detailText(body?.detail) ?? `サーバーがエラーを返しました(${response.status} ${response.statusText})`;
  return new RagApiError(message, response.status, code);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new RagApiError(NETWORK_MESSAGE, 0, 'network');
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response;
}

async function callJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await call(path, init)).json()) as T;
}

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- 利用できる状態か ----

/** DBとOllamaのモデルが揃っていて、使える状態かを確認する(使えない理由を、画面に出せる文にして返す) */
export async function getReadiness(): Promise<Readiness> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/readyz`);
  } catch {
    return { ready: false, code: 'unavailable', message: NETWORK_MESSAGE, missingModels: [] };
  }
  if (response.ok) {
    return { ready: true, code: 'ok', message: '', missingModels: [] };
  }
  const body = await readJson(response);
  if (body?.error?.code === 'rag_not_configured') {
    return { ready: false, code: 'not_configured', message: String(body.error.message), missingModels: [] };
  }
  if (typeof body?.error?.message === 'string') {
    return { ready: false, code: 'unavailable', message: body.error.message, missingModels: [] };
  }
  const missing = Array.isArray(body?.missing_models) ? (body.missing_models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
  const detail = detailText(body?.detail) ?? 'OCR・RAGサービスが利用できる状態ではありません。';
  return { ready: false, code: missing.length > 0 ? 'models_missing' : 'unavailable', message: detail, missingModels: missing };
}

// ---- ② OCR下書き ----

/** PDFのOCRを開始する。OCRはバックグラウンドで実行されるため、すぐに返る(状態は getOcrDraft で見る) */
export function startOcr(file: File, password?: string): Promise<OcrDraft> {
  const form = new FormData();
  form.append('file', file);
  if (password !== undefined && password !== '') {
    form.append('password', password);
  }
  return callJson<OcrDraft>('/ocr-drafts', { method: 'POST', body: form });
}

export function listOcrDrafts(signal?: AbortSignal): Promise<OcrDraftSummary[]> {
  return callJson<OcrDraftSummary[]>('/ocr-drafts', signal === undefined ? undefined : { signal });
}

export function getOcrDraft(id: string, signal?: AbortSignal): Promise<OcrDraft> {
  return callJson<OcrDraft>(`/ocr-drafts/${encodeURIComponent(id)}`, signal === undefined ? undefined : { signal });
}

export function updateOcrDraft(id: string, draftMarkdown: string): Promise<OcrDraft> {
  return callJson<OcrDraft>(`/ocr-drafts/${encodeURIComponent(id)}`, jsonRequest('PATCH', { draft_markdown: draftMarkdown }));
}

/** 下書きを破棄する。OCR実行中なら、現在のページの処理が終わった時点で中止される */
export async function discardOcrDraft(id: string): Promise<void> {
  await call(`/ocr-drafts/${encodeURIComponent(id)}/discard`, { method: 'POST' });
}

/** 下書きの原本PDFのURL(新しいタブで開く。「#page=N」でページを指定できる) */
export const ocrDraftPdfUrl = (id: string): string => `${BASE}/ocr-drafts/${encodeURIComponent(id)}/pdf`;

export async function fetchOcrDraftPdf(id: string): Promise<Blob> {
  return (await call(`/ocr-drafts/${encodeURIComponent(id)}/pdf`)).blob();
}

// ---- ③ RAG: 登録・一覧・検索 ----

export interface RegisterDocumentInput {
  // 登録するMarkdownの本文と、そのファイル名(同じファイル名で再登録すると、置き換わる)
  readonly markdown: string;
  readonly fileName: string;
  // 表示名。省略すると、ファイル名(拡張子なし)になる
  readonly title?: string;
  // 対象の機器名。空なら、全機器共通の資料として扱う
  readonly equipmentNames: readonly string[];
  // 原本PDF(任意)
  readonly pdf?: { readonly blob: Blob; readonly fileName: string };
}

export function registerDocument(input: RegisterDocumentInput): Promise<DocumentSummary> {
  const form = new FormData();
  form.append('markdown_file', new File([input.markdown], input.fileName, { type: 'text/markdown' }));
  if (input.title !== undefined && input.title.trim() !== '') {
    form.append('title', input.title.trim());
  }
  for (const name of input.equipmentNames) {
    form.append('equipment_names', name);
  }
  if (input.pdf !== undefined) {
    form.append('pdf_file', input.pdf.blob, input.pdf.fileName);
  }
  return callJson<DocumentSummary>('/documents', { method: 'POST', body: form });
}

export function listDocuments(signal?: AbortSignal): Promise<DocumentSummary[]> {
  return callJson<DocumentSummary[]>('/documents', signal === undefined ? undefined : { signal });
}

export async function listEquipmentNames(signal?: AbortSignal): Promise<string[]> {
  const rows = await callJson<{ equipment_name: string }[]>('/equipment-names', signal === undefined ? undefined : { signal });
  return rows.map((row) => row.equipment_name);
}

/** 登録済み文書の原本PDFのURL(新しいタブで開く) */
export const documentPdfUrl = (id: string): string => `${BASE}/documents/${encodeURIComponent(id)}/pdf`;

export interface SearchInput {
  readonly query: string;
  // 指定すると、その機器名の資料と、機器名の無い(全機器共通の)資料に絞る
  readonly equipmentName?: string;
  readonly topK?: number;
}

export function searchManuals(input: SearchInput, signal?: AbortSignal): Promise<SearchResult[]> {
  const body: { query: string; equipment_name?: string; top_k?: number } = { query: input.query };
  if (input.equipmentName !== undefined && input.equipmentName !== '') {
    body.equipment_name = input.equipmentName;
  }
  if (input.topK !== undefined) {
    body.top_k = input.topK;
  }
  return callJson<SearchResult[]>('/search', { ...jsonRequest('POST', body), ...(signal === undefined ? {} : { signal }) });
}
