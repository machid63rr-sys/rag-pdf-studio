import { parseFragment } from 'parse5';

/*
 * Markdownの中の、手動の改ページ。
 *
 * Markdownには、改ページの記法が無いため、多くのMarkdown→PDFツール(VS Code・Typoraなど)が改ページとして扱う、
 * 次の1行を、改ページの印にする。前後は、空行で区切る(空行が無いと、前後の行も、同じHTMLのブロックになる)。
 *   <div style="page-break-after: always"></div>
 * Markdownの中のHTMLは、PDFでは文字として表示される(実行も、解釈もしない)が、この印だけは、改ページとして扱う。
 *
 * 印として読むのは、<div> のタグ1つだけで、中身が空(空白は可)で、属性が style だけのもの。
 * style は、「page-break-after: always」か「break-after: page」(後ろの「;」・空白・大文字小文字は問わない)に限る。
 * 閉じタグの無いもの、ほかの属性・タグ・文字が混ざるものは、印として読まない。
 */

/** エディタが書き出す、改ページの印(1行) */
export const PAGE_BREAK_MARKUP = '<div style="page-break-after: always"></div>';

const PAGE_BREAK_STYLE = /^\s*(?:page-break-after|break-after)\s*:\s*(?:always|page)\s*;?\s*$/i;
const CLOSING_DIV = /<\/div\s*>$/i;

/** HTMLのブロック(Markdownの html ノードの値)が、改ページの印か */
export function isPageBreakHtml(html: string): boolean {
  const trimmed = html.trim();
  // 閉じタグの無い <div ...> は、パーサが補って、空の <div> にしてしまうため、先に除く
  if (!CLOSING_DIV.test(trimmed)) {
    return false;
  }
  const nodes = parseFragment(trimmed).childNodes;
  const [node] = nodes;
  if (nodes.length !== 1 || node === undefined || node.nodeName !== 'div') {
    return false;
  }
  const { attrs, childNodes } = node as unknown as {
    attrs: { name: string; value: string }[];
    childNodes: { nodeName: string; value?: string }[];
  };
  const [attribute] = attrs;
  return (
    attrs.length === 1 &&
    attribute !== undefined &&
    attribute.name === 'style' &&
    PAGE_BREAK_STYLE.test(attribute.value) &&
    childNodes.every((child) => child.nodeName === '#text' && (child.value ?? '').trim() === '')
  );
}
