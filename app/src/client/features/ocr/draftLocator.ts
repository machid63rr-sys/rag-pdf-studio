import type { DiffSegment } from '../../ragApi';

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 要確認セグメントが、下書き本文(Markdown)のどこにあるかを探す。
 * OCR結果は文字位置(座標)を持たないため、本文中の文字列検索で近似する。
 * 下書きは「## PDF N ページ目」見出しでページごとに区切られている(ocr-ragの run_ocr_pipeline が出す形)ため、
 * そのページの見出し以降から検索して、同じ文言が別ページにある場合の取り違えを避ける。
 * 採用テキスト→主文候補の順に試し、見つからなければ(本文を編集した等)nullを返す。
 */
export function findSegmentRange(markdown: string, segment: DiffSegment): TextRange | null {
  const headingIndex = markdown.indexOf(`## PDF ${segment.page}ページ目\n`);
  const searchFrom = headingIndex >= 0 ? headingIndex : 0;

  for (const candidate of [segment.final_text, segment.glm_text]) {
    const needle = candidate.trim();
    if (needle === '') {
      continue;
    }
    const start = markdown.indexOf(needle, searchFrom);
    if (start >= 0) {
      return { start, end: start + needle.length };
    }
  }
  return null;
}
