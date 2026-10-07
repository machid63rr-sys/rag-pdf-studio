/*
 * Mermaid(図の記法)の描画設定と、描画結果(SVG)の扱い。
 * プレビュー(クライアント)とPDF(サーバ)で同じ設定を使い、図の見た目を揃える。
 */

// 図の文字のフォント。文書本文(document.css)と同じ並びにする
const FONT_FAMILY = "'Noto Sans CJK JP', 'Noto Sans JP', 'Yu Gothic', 'Meiryo', sans-serif";

export const MERMAID_CONFIG = {
  // ページを読み込んだだけで描画を始めない(描画は、こちらから呼んだときだけ)
  startOnLoad: false,
  // 図の文字に含まれるHTMLを無効にし、クリック時のスクリプト呼び出しも使えなくする。
  // 図の中から、この設定を緩めることもできない
  securityLevel: 'strict',
  theme: 'default',
  fontFamily: FONT_FAMILY,
  // 構文エラーのとき、エラー表示の図を画面に残さない(エラーは例外として受け取る)
  suppressErrorRendering: true,
} as const;

/** コードブロックの言語がMermaidか(「Mermaid」のような大文字も同じ扱い) */
export const isMermaidLanguage = (language: string | null | undefined): boolean =>
  language !== null && language !== undefined && language.trim().toLowerCase() === 'mermaid';

/*
 * Mermaidのコードブロックを、PDFでどう表示するか。コードブロックの言語名の後ろに `show=○○` と書いて選ぶ
 * (例: ```mermaid show=both)。書かなければ「図のみ」。
 *   diagram: 図だけ / code: コードだけ / both: コードと図の両方(コードの下に図)
 */
export type DiagramView = 'diagram' | 'code' | 'both';

export const DEFAULT_DIAGRAM_VIEW: DiagramView = 'diagram';

const SHOW_TOKEN = /^show=(.*)$/i;

/** コードブロックのメタ情報(言語名の後ろの文字)から、表示の選択を読む。無い・読めない値は、既定(図のみ) */
export function diagramViewOf(meta: string | null | undefined): DiagramView {
  const token = (meta ?? '').split(/\s+/).find((part) => SHOW_TOKEN.test(part));
  const value = token === undefined ? '' : (SHOW_TOKEN.exec(token)?.[1] ?? '').toLowerCase();
  return value === 'code' || value === 'both' || value === 'diagram' ? value : DEFAULT_DIAGRAM_VIEW;
}

/** メタ情報の表示の選択だけを変える(ほかの内容は残す)。既定(図のみ)にするときは、`show=` を書かない */
export function withDiagramView(meta: string | null | undefined, view: DiagramView): string {
  const others = (meta ?? '').split(/\s+/).filter((part) => part !== '' && !SHOW_TOKEN.test(part));
  return (view === DEFAULT_DIAGRAM_VIEW ? others : [...others, `show=${view}`]).join(' ');
}

// 図の描画結果。描けなかった場合は、利用者に見せる理由を添える
export type DiagramOutcome =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly message: string };

export interface SizedSvg {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

const ROOT_TAG = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*>/;
const VIEW_BOX = /\sviewBox="\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/;

/**
 * Mermaidが出力するSVGは、幅が「100%」のため、画像として置くと、図の大きさに関わらず行の幅いっぱいに引き伸ばされる。
 * 図そのものの大きさ(viewBox)を、幅・高さとして明示したSVGにする。大きさを読み取れなければ null。
 */
export function sizedSvg(svg: string): SizedSvg | null {
  const root = ROOT_TAG.exec(svg);
  const box = root === null ? null : VIEW_BOX.exec(root[0]);
  if (root === null || box === null) {
    return null;
  }
  const width = Math.ceil(Number(box[3]));
  const height = Math.ceil(Number(box[4]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const withoutSize = root[0].replace(/\s(?:width|height)="[^"]*"/g, '');
  const sized = withoutSize.replace(/^(\s*(?:<\?xml[^>]*>\s*)?<svg\b)/, `$1 width="${width}" height="${height}"`);
  return { svg: sized + svg.slice(root[0].length), width, height };
}

const MAX_MESSAGE_LENGTH = 200;

/** 描画に失敗した理由。Mermaidのエラーは、問題の箇所を示す複数行になるため、先頭の1行だけを見せる */
export function diagramErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const message = first.trim().slice(0, MAX_MESSAGE_LENGTH);
  return message === '' ? '図の記法を解釈できません' : message;
}
