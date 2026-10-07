/*
 * PDFのページの区切り位置。サーバが、PDFと同じ文書・同じフォント・同じChromiumで測り、
 * 画面(プレビュー)が、その位置を、編集中の内容に対応づけて表示する。
 * 用紙・余白・本文の大きさは、ページ設定(pageSettings.ts)が決める。
 */

/*
 * 新しいページの最初になる位置。Markdownの「ブロック」(見出し・段落・リスト・表・コード・図・水平線など、
 * 本文の最上位の単位)の番号(0始まり)と、ブロックの中の位置で表す。
 *   start: ブロックの先頭から、新しいページ
 *   text:  ブロックの途中(段落・リストなどの行の途中)。空白を除いた文字の、offset 文字目(0始まり)から、新しいページ
 *   row:   表の途中。index 行目(見出しの行が0)から、新しいページ
 *   line:  コードの途中。index 行目(0始まり)から、新しいページ
 * tag は、PDFでの、そのブロックの要素(h1・p・ul・table・pre・figure など)。画面側が、対応づけの確認に使う。
 * snippet は、新しいページの最初の文字(空白を除いて24文字まで)。表示や検証のために添える
 */
interface StartBase {
  // この位置から始まるページの番号(1始まり。最初のページは含まない)
  readonly page: number;
  readonly block: number;
  readonly tag: string;
  readonly snippet: string;
}

export type PageStart =
  | (StartBase & { readonly kind: 'start' })
  | (StartBase & { readonly kind: 'text'; readonly offset: number })
  | (StartBase & { readonly kind: 'row'; readonly index: number })
  | (StartBase & { readonly kind: 'line'; readonly index: number });

export interface PageLayout {
  // PDFの全ページ数
  readonly pages: number;
  readonly starts: readonly PageStart[];
}
