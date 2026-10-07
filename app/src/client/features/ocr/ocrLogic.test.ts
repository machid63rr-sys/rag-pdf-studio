import { describe, expect, it } from 'vitest';
import { formatDateTime, isActiveStatus, markdownFileNameOf, MAX_PDF_BYTES, progressOf, statusLabel, validatePdfFile } from './ocrLogic';

describe('validatePdfFile', () => {
  it('拡張子が .pdf(大文字小文字は区別しない)で、空でなく、上限以内なら通す', () => {
    expect(validatePdfFile({ name: 'R-1.pdf', size: 1000 })).toEqual({ ok: true });
    expect(validatePdfFile({ name: 'R-1.PDF', size: 1 })).toEqual({ ok: true });
    expect(validatePdfFile({ name: 'big.pdf', size: MAX_PDF_BYTES })).toEqual({ ok: true });
  });

  it('PDF以外は、ファイル名を示して断る', () => {
    const check = validatePdfFile({ name: 'manual.docx', size: 1000 });

    expect(check).toEqual({ ok: false, message: '「manual.docx」はPDFではありません。拡張子が .pdf のファイルを選んでください。' });
  });

  it('「.pdf」で終わらない名前(pdfが途中にある)は断る', () => {
    expect(validatePdfFile({ name: 'a.pdf.txt', size: 10 }).ok).toBe(false);
  });

  it('空のファイルは断る', () => {
    expect(validatePdfFile({ name: 'a.pdf', size: 0 })).toMatchObject({ ok: false, message: '「a.pdf」は空のファイルです。' });
  });

  it('上限を超えるファイルは、大きさと上限を示して断る', () => {
    const check = validatePdfFile({ name: 'big.pdf', size: MAX_PDF_BYTES + 1 });

    expect(check).toMatchObject({ ok: false });
    expect(check.ok ? '' : check.message).toContain('上限は100MB');
  });
});

describe('statusLabel / isActiveStatus', () => {
  it.each([
    [{ status: 'QUEUED', page_count: 0, pages_done: 0 }, '待機中'],
    [{ status: 'RUNNING', page_count: 4, pages_done: 1 }, '実行中 1/4ページ'],
    [{ status: 'RUNNING', page_count: 0, pages_done: 0 }, '実行中(準備中)'],
    [{ status: 'DRAFT', page_count: 4, pages_done: 4 }, '確認待ち'],
    [{ status: 'FAILED', page_count: 2, pages_done: 1 }, '失敗'],
    [{ status: 'DISCARDED', page_count: 0, pages_done: 0 }, '破棄済み'],
  ] as const)('%j は「%s」', (draft, label) => {
    expect(statusLabel(draft)).toBe(label);
  });

  it('待機中・実行中だけが、結果待ち(状態を見に行き続ける)', () => {
    expect(isActiveStatus('QUEUED')).toBe(true);
    expect(isActiveStatus('RUNNING')).toBe(true);
    expect(isActiveStatus('DRAFT')).toBe(false);
    expect(isActiveStatus('FAILED')).toBe(false);
    expect(isActiveStatus('DISCARDED')).toBe(false);
  });
});

describe('progressOf', () => {
  it('総ページ数が分かれば、割合と「n / N ページ」を返す', () => {
    expect(progressOf({ status: 'RUNNING', page_count: 4, pages_done: 1 })).toEqual({ known: true, done: 1, total: 4, percent: 25, label: '1 / 4 ページ' });
    expect(progressOf({ status: 'RUNNING', page_count: 3, pages_done: 1 }).percent).toBe(33);
  });

  it('総ページ数が分からない間(実行の準備中)は、割合を出さない', () => {
    expect(progressOf({ status: 'RUNNING', page_count: 0, pages_done: 0 })).toEqual({ known: false, done: 0, total: 0, percent: 0, label: '準備中(PDFを画像にしています)' });
  });

  it('待機中は、前のOCRを待っていることを示す', () => {
    expect(progressOf({ status: 'QUEUED', page_count: 0, pages_done: 0 })).toMatchObject({ known: false, label: '待機中(前のOCRが終わるのを待っています)' });
  });

  it('完了ページ数が範囲を外れても、0〜総数に収める', () => {
    expect(progressOf({ status: 'RUNNING', page_count: 2, pages_done: 5 })).toMatchObject({ done: 2, percent: 100 });
    expect(progressOf({ status: 'RUNNING', page_count: 2, pages_done: -1 })).toMatchObject({ done: 0, percent: 0 });
  });
});

describe('markdownFileNameOf', () => {
  it('PDFの拡張子を .md に変える', () => {
    expect(markdownFileNameOf('R-1.pdf')).toBe('R-1.md');
    expect(markdownFileNameOf('チラー取扱説明書.PDF')).toBe('チラー取扱説明書.md');
  });

  it('ほかの「.」は残す', () => {
    expect(markdownFileNameOf('manual.v2.pdf')).toBe('manual.v2.md');
  });

  it('Windowsで使えない文字は「_」にする', () => {
    expect(markdownFileNameOf('a:b*c.pdf')).toBe('a_b_c.md');
  });

  it('名前として使えない(空・予約名・長すぎる)場合は「document」にする', () => {
    expect(markdownFileNameOf('.pdf')).toBe('document.md');
    expect(markdownFileNameOf('con.pdf')).toBe('document.md');
    expect(markdownFileNameOf(`${'あ'.repeat(100)}.pdf`)).toBe('document.md');
  });
});

describe('formatDateTime', () => {
  it('日時を日本語の形式にする', () => {
    expect(formatDateTime('2026-10-07T01:02:03Z')).toBe(new Date('2026-10-07T01:02:03Z').toLocaleString('ja-JP'));
  });

  it('日時として読めない値は、そのまま返す', () => {
    expect(formatDateTime('不明')).toBe('不明');
  });
});
