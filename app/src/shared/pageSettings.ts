/*
 * PDFのページ設定(用紙・向き・余白・ページ番号)。画面で選び、サーバがPDFと、ページの区切りの測定に使う。
 *
 * 選べるのは、用紙(A4・A3・B5・B4・Letter)、向き(縦・横)、余白(標準・狭い・広い)、ページ番号(あり・なし)。
 * 余白は、プリセットだけにしている。Chromiumは用紙・余白を整数のポイントへ丸めて印刷するため、本文の大きさは、
 * 計算式どおりにならない。プリセットなら、全組み合わせ(30通り)を、統合テストで、PDFの実際の改ページと照らし合わせられる。
 *
 * HTMLを取り込んだ文書は、用紙・余白を、文書のCSS(@page)が決めるため、ページ番号の有無だけが、この設定に従う。
 */

export const PAPER_SIZES = ['A4', 'A3', 'B5', 'B4', 'Letter'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const ORIENTATIONS = ['portrait', 'landscape'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const MARGIN_PRESETS = ['standard', 'narrow', 'wide'] as const;
export type MarginPreset = (typeof MARGIN_PRESETS)[number];

export interface PageSettings {
  readonly paper: PaperSize;
  readonly orientation: Orientation;
  readonly margin: MarginPreset;
  // フッターに、ページ番号(「1 / 3」)を付けるか
  readonly pageNumbers: boolean;
}

/** 既定。これまでのPDFと同じ(A4縦・余白は上20mm・下25mm・左右20mm・ページ番号あり) */
export const DEFAULT_PAGE_SETTINGS: PageSettings = { paper: 'A4', orientation: 'portrait', margin: 'standard', pageNumbers: true };

export const PAPER_LABELS: Readonly<Record<PaperSize, string>> = {
  A4: 'A4 (210×297mm)',
  A3: 'A3 (297×420mm)',
  B5: 'B5 (182×257mm)',
  B4: 'B4 (257×364mm)',
  Letter: 'Letter (8.5×11インチ)',
};
export const ORIENTATION_LABELS: Readonly<Record<Orientation, string>> = { portrait: '縦', landscape: '横' };
export const MARGIN_LABELS: Readonly<Record<MarginPreset, string>> = {
  standard: '標準(上20・下25・左右20mm)',
  narrow: '狭い(上10・下15・左右10mm)',
  wide: '広い(上25・下30・左右25mm)',
};

export interface MarginsMm {
  readonly top: number;
  readonly bottom: number;
  readonly side: number;
}

export const MARGINS_MM: Readonly<Record<MarginPreset, MarginsMm>> = {
  standard: { top: 20, bottom: 25, side: 20 },
  narrow: { top: 10, bottom: 15, side: 10 },
  wide: { top: 25, bottom: 30, side: 25 },
};

// 用紙の大きさ(mm。縦向き)。JIS B列(B4・B5)は、Chromiumの用紙の名前に無いため、大きさで渡す
export const PAPER_MM: Readonly<Record<PaperSize, { readonly width: number; readonly height: number }>> = {
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  B5: { width: 182, height: 257 },
  B4: { width: 257, height: 364 },
  Letter: { width: 215.9, height: 279.4 },
};

/**
 * Chromiumが、実際に印刷で使う用紙の大きさ(ポイント。1/72インチ。縦向き)。用紙の大きさ(インチ・mm)を、整数のポイントに丸めた値
 * (実測: 用紙ごとに、PDFの画素から測った)。A4の幅だけが、四捨五入(595)ではなく596になる
 */
const PAPER_PT: Readonly<Record<PaperSize, { readonly width: number; readonly height: number }>> = {
  A4: { width: 596, height: 842 },
  A3: { width: 842, height: 1191 },
  B5: { width: 516, height: 729 },
  B4: { width: 729, height: 1032 },
  Letter: { width: 612, height: 792 },
};

// 余白は、整数のポイントへ、切り捨てられる
const marginPt = (mm: number): number => Math.floor((mm * 72) / 25.4);

export const pageSettingsEqual = (a: PageSettings, b: PageSettings): boolean =>
  a.paper === b.paper && a.orientation === b.orientation && a.margin === b.margin && a.pageNumbers === b.pageNumbers;

/** 向きを反映した、用紙の大きさ(mm) */
export function paperMm(settings: PageSettings): { readonly width: number; readonly height: number } {
  const { width, height } = PAPER_MM[settings.paper];
  return settings.orientation === 'landscape' ? { width: height, height: width } : { width, height };
}

/** 本文の高さ(mm。用紙の高さから、上下の余白を除いたもの)。縦長の図を、1ページに収めるための目安 */
export function bodyHeightMm(settings: PageSettings): number {
  const { top, bottom } = MARGINS_MM[settings.margin];
  return Math.round((paperMm(settings).height - top - bottom) * 10) / 10;
}

/**
 * PDFの本文が入る領域の大きさ(CSSピクセル)。ページの区切りの測定は、この大きさの「段」で、本文を折り返す。
 *
 * 本文の大きさは、整数のポイント(用紙 − 余白)で、CSSピクセルにすると、その4/3倍(A4縦・標準なら、484pt × 716pt)。
 * Chromiumは、印刷のレイアウトを、その値を、ピクセルの整数へ「切り上げた」大きさで行う(484pt = 645.33px → 646px。
 * ちょうど整数のとき(456pt = 608px)は、1ピクセル広い 609px。折り返す位置を探って実測した)。
 * 文字の折り返しや、行がページに入るかどうかが、この大きさで決まるため、測定には、画素の大きさ(645.33)ではなく、
 * このレイアウトの大きさを使う。Chromiumの版が変わって値が変わったときは、統合テスト(全組み合わせで、PDFの実際の改ページとの一致)が失敗する。
 */
export function contentSizePx(settings: PageSettings): { readonly width: number; readonly height: number } {
  const paper = PAPER_PT[settings.paper];
  const margins = MARGINS_MM[settings.margin];
  const [pageWidth, pageHeight] = settings.orientation === 'landscape' ? [paper.height, paper.width] : [paper.width, paper.height];
  const widthPt = pageWidth - 2 * marginPt(margins.side);
  const heightPt = pageHeight - marginPt(margins.top) - marginPt(margins.bottom);
  const layoutPx = (pt: number): number => Math.floor((pt * 4) / 3) + 1;
  return { width: layoutPx(widthPt), height: layoutPx(heightPt) };
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);

/** 外から来た値(リクエスト・保存してあった設定)を検査して、ページ設定にする。4つの項目がそろって正しくなければ undefined */
export function parsePageSettings(value: unknown): PageSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { paper, orientation, margin, pageNumbers } = value as Record<string, unknown>;
  if (!isOneOf(PAPER_SIZES, paper) || !isOneOf(ORIENTATIONS, orientation) || !isOneOf(MARGIN_PRESETS, margin) || typeof pageNumbers !== 'boolean') {
    return undefined;
  }
  return { paper, orientation, margin, pageNumbers };
}
