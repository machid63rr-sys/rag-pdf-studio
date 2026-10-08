/*
 * ③ RAG(登録・確認)の、画面に依存しない規則(入力の検証・正規化・判定・整形)。
 * ocr-rag(Python)の検証と同じ上限を、画面でも先に確認する(送ってから断られるのを避けるため)。
 * 画面に出す文言は、利用者がそのまま読める日本語にする。
 */
import { RagApiError, type DocumentSummary, type SearchResult } from '../../ragApi';

// 類似度が、これ未満の検索結果は「関連度が低い」とする。
// 8文書・107チャンクへの10問の検証で、該当ありは0.58〜0.78、範囲外の質問は0.38〜0.43だった。
// 暫定の値(質問が少なく、質問も検証用に作ったもの)。実際のマニュアルで、要再確認。
export const LOW_SIMILARITY_THRESHOLD = 0.5;

// アップロードの上限(ocr-ragのMAX_UPLOAD_BYTESの既定と同じ)
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// 登録名・題名・タグ名の長さの上限(DBのVARCHAR(255)と同じ)
export const MAX_NAME_LENGTH = 255;
export const MAX_QUERY_LENGTH = 2000;

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;
export const SEARCH_TOP_K_OPTIONS = [5, 10, 20] as const;
export const DEFAULT_TOP_K = 5;

const mebibytes = (bytes: number): number => Math.floor(bytes / (1024 * 1024));

export const isMarkdownFileName = (name: string): boolean => MARKDOWN_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

export const isPdfFileName = (name: string): boolean => name.toLowerCase().endsWith('.pdf');

/** 画面に出す、エラーの文言(RagApiErrorのメッセージは、そのまま表示できる) */
export function errorMessage(cause: unknown): string {
  if (cause instanceof RagApiError || cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

// ---- 登録名・題名 ----

/** 登録名の拡張子(.md / .markdown / .txt)が無ければ、.md を補う。空白だけなら空文字 */
export function ensureMarkdownFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    return '';
  }
  return isMarkdownFileName(trimmed) ? trimmed : `${trimmed}.md`;
}

/** 取り込んだファイル名から、登録名の初期値を作る(拡張子が無ければ補う) */
export const defaultRegistrationName = (sourceName: string): string => ensureMarkdownFileName(sourceName);

/** 登録名(ensureMarkdownFileNameを通したもの)を検証する。問題があれば、その理由。無ければnull */
export function validateRegistrationName(name: string): string | null {
  const extension = MARKDOWN_EXTENSIONS.find((candidate) => name.toLowerCase().endsWith(candidate));
  const stem = extension === undefined ? name : name.slice(0, name.length - extension.length);
  if (stem.trim() === '') {
    return '登録名を入力してください。';
  }
  if (/[\\/]/.test(name)) {
    return '登録名に「/」「\\」は使えません。';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `登録名が長すぎます(${MAX_NAME_LENGTH}文字以内)。`;
  }
  return null;
}

export function validateTitle(title: string): string | null {
  return title.trim().length > MAX_NAME_LENGTH ? `題名が長すぎます(${MAX_NAME_LENGTH}文字以内)。` : null;
}

/** 同じ登録名で、既に登録されている文書(登録し直すと置き換わる)。無ければnull */
export function findExistingDocument(documents: readonly DocumentSummary[], registrationName: string): DocumentSummary | null {
  return documents.find((document) => document.source_file_name === registrationName) ?? null;
}

// ---- タグ名 ----

export type EquipmentNameResult = { readonly ok: true; readonly names: string[] } | { readonly ok: false; readonly message: string };

const SEPARATOR = /[,，、]/;

/**
 * 入力された文字列(カンマ区切りで、複数も可)を、タグ名の一覧に追加する。
 * 空・255文字超・重複が1つでもあれば、1つも追加せず、理由を返す(一部だけ黙って追加しない)。
 */
export function addEquipmentNames(current: readonly string[], input: string): EquipmentNameResult {
  const entered = input.split(SEPARATOR).map((part) => part.trim()).filter((part) => part !== '');
  if (entered.length === 0) {
    return { ok: false, message: 'タグ名を入力してください。' };
  }
  const names = [...current];
  for (const name of entered) {
    if (name.length > MAX_NAME_LENGTH) {
      return { ok: false, message: `タグ名が長すぎます(${MAX_NAME_LENGTH}文字以内): ${name.slice(0, 20)}…` };
    }
    if (names.includes(name)) {
      return { ok: false, message: `「${name}」は既に追加されています。` };
    }
    names.push(name);
  }
  return { ok: true, names };
}

/** タグ名の一覧を、画面に出す文言にする(空なら、共通(タグなし)の資料) */
export const describeEquipmentNames = (names: readonly string[]): string => (names.length === 0 ? '共通(タグなし)' : names.join('、'));

// ---- ファイル ----

interface FileLike {
  readonly name: string;
  readonly size: number;
}

export function validateMarkdownFile(file: FileLike): string | null {
  if (!isMarkdownFileName(file.name)) {
    return `Markdown(${MARKDOWN_EXTENSIONS.join(' / ')})のファイルを選んでください。選んだファイル: ${file.name}`;
  }
  if (file.size === 0) {
    return `${file.name}: ファイルが空です。`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name}: ファイルが大きすぎます(上限 ${mebibytes(MAX_UPLOAD_BYTES)}MB)。`;
  }
  return null;
}

export function validatePdfFile(file: FileLike): string | null {
  if (!isPdfFileName(file.name)) {
    return `原本PDF(.pdf)のファイルを選んでください。選んだファイル: ${file.name}`;
  }
  if (file.size === 0) {
    return `${file.name}: ファイルが空です。`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name}: ファイルが大きすぎます(上限 ${mebibytes(MAX_UPLOAD_BYTES)}MB)。`;
  }
  return null;
}

/** ファイルの大きさを、画面に出す文言にする */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.ceil(bytes / 1024))}KB`;
}

// ---- 検索 ----

export interface EnterKeyEvent {
  readonly key: string;
  readonly isComposing: boolean;
  readonly keyCode: number;
}

/**
 * Enterキーで、検索・追加を実行してよいか。日本語入力の変換を確定するEnterでは、実行しない
 * (Chromeは isComposing、Safariなどは keyCode 229 で、変換中であることを示す)。
 */
export const shouldSubmitOnEnter = (event: EnterKeyEvent): boolean => event.key === 'Enter' && !event.isComposing && event.keyCode !== 229;

export const isLowRelevance = (similarity: number): boolean => similarity < LOW_SIMILARITY_THRESHOLD;

/** 結果が1件以上あり、すべてが関連度が低い(該当する記載が無い可能性がある) */
export const allLowRelevance = (results: readonly SearchResult[]): boolean => results.length > 0 && results.every((result) => isLowRelevance(result.similarity));

export const formatSimilarity = (similarity: number): string => similarity.toFixed(2);

/** 類似度の棒グラフの長さ(0〜100) */
export const similarityPercent = (similarity: number): number => Math.round(Math.min(1, Math.max(0, similarity)) * 100);

export function validateQuery(query: string): string | null {
  if (query.trim() === '') {
    return '質問文を入力してください。';
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return `質問文が長すぎます(${MAX_QUERY_LENGTH}文字以内)。`;
  }
  return null;
}

// ---- 表示 ----

/** 登録日時を、日本語の表記にする。timeZoneを省略すると、ブラウザの時間帯 */
export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('ja-JP', timeZone === undefined ? {} : { timeZone });
}
