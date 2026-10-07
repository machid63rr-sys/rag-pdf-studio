import { validateBaseName } from '../../filename';
import type { OcrDraftStatus, OcrDraftSummary } from '../../ragApi';

/*
 * 機能②(PDF → OCR → MD)の、画面に依存しない判定・変換。
 * 状態の表示名、進捗の計算、アップロード前のファイル検証、出力するファイル名など。
 */

// ocr-ragのアップロード上限(既定100MB)。超えるファイルは、送る前に断る
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

export type FileCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** アップロード前の、PDFファイルの確認(拡張子・空・大きさ)。使えない場合は、理由を返す */
export function validatePdfFile(file: { readonly name: string; readonly size: number }): FileCheck {
  if (!/\.pdf$/i.test(file.name)) {
    return { ok: false, message: `「${file.name}」はPDFではありません。拡張子が .pdf のファイルを選んでください。` };
  }
  if (file.size === 0) {
    return { ok: false, message: `「${file.name}」は空のファイルです。` };
  }
  if (file.size > MAX_PDF_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, message: `「${file.name}」は大きすぎます(${megabytes}MB)。上限は${MAX_PDF_BYTES / (1024 * 1024)}MBです。` };
  }
  return { ok: true };
}

/** OCRが実行中・順番待ちで、まだ結果が出ていない状態か(画面が、状態を見に行き続ける間) */
export const isActiveStatus = (status: OcrDraftStatus): boolean => status === 'QUEUED' || status === 'RUNNING';

type StatusFields = Pick<OcrDraftSummary, 'status' | 'page_count' | 'pages_done'>;

/** 一覧に出す、状態の表示名 */
export function statusLabel(draft: StatusFields): string {
  switch (draft.status) {
    case 'QUEUED':
      return '待機中';
    case 'RUNNING':
      return draft.page_count > 0 ? `実行中 ${draft.pages_done}/${draft.page_count}ページ` : '実行中(準備中)';
    case 'DRAFT':
      return '確認待ち';
    case 'FAILED':
      return '失敗';
    case 'DISCARDED':
      return '破棄済み';
  }
}

export interface Progress {
  // 総ページ数が分かっているか(PDFを画像にするまでは分からない)
  readonly known: boolean;
  readonly done: number;
  readonly total: number;
  // 0〜100
  readonly percent: number;
  // 進捗バーの横に出す文
  readonly label: string;
}

/** 実行中の下書きの進捗。総ページ数が分からない間は、割合を出さない */
export function progressOf(draft: StatusFields): Progress {
  if (draft.status === 'QUEUED') {
    return { known: false, done: 0, total: 0, percent: 0, label: '待機中(前のOCRが終わるのを待っています)' };
  }
  if (draft.page_count <= 0) {
    return { known: false, done: 0, total: 0, percent: 0, label: '準備中(PDFを画像にしています)' };
  }
  const total = draft.page_count;
  const done = Math.min(Math.max(draft.pages_done, 0), total);
  return { known: true, done, total, percent: Math.round((done / total) * 100), label: `${done} / ${total} ページ` };
}

const INVALID_FILE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/g;
const FALLBACK_STEM = 'document';

/**
 * 元のPDFのファイル名から、Markdownとして保存・引き渡しするファイル名(「R-1.pdf」→「R-1.md」)を作る。
 * Windowsで使えない文字は「_」にする。それでも名前として使えない場合は「document」にする。
 */
export function markdownFileNameOf(sourceFileName: string): string {
  const stem = sourceFileName.replace(/\.pdf$/i, '').replace(INVALID_FILE_NAME_CHARACTERS, '_').trim().replace(/\.+$/, '');
  return `${validateBaseName(stem).ok ? stem : FALLBACK_STEM}.md`;
}

/** 作成日時の表示(日本語の形式)。日時として読めない値は、そのまま返す */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ja-JP');
}
