import { addExportVisitor$, realmPlugin, type LexicalExportVisitor } from '@mdxeditor/editor';
import { $isLineBreakNode, type LexicalNode, type LineBreakNode } from 'lexical';
import type { Break } from 'mdast';

/*
 * 書式付きエディタで、Shift+Enter(段落の中の改行)を続けて押した場合の、Markdownへの書き出し。
 *
 * エディタは、段落の中の改行を、ただの改行文字(「\n」)として書き出す。1つだけなら、前後の文字がつながった行になるが、
 * 続けて2つ以上あると、空行になり、Markdownでは「別の段落」になってしまう(段落の中の空行は、書けない)。
 * エディタでは1つの段落(改行が続く)なのに、PDFでは2つの段落になり、見た目が違ううえ、
 * 段落の数が合わなくなるため、ページの区切りの位置もずれる。
 *
 * 改行が続くとき(と、段落の先頭の改行)は、行末に「\」を付けた改行(Markdownの強制改行)として書き出す。
 * 1つだけの改行(文字と文字の間)は、これまでどおり、ただの改行のまま(Markdownの見た目を変えない)。
 * 段落の末尾に続く改行は、PDFでは見えないため、そのまま(末尾の「\」は、文字として表示されてしまう)。
 */

// この改行の後ろに、改行以外のもの(文字・画像など)が続くか
const hasContentAfter = (node: LexicalNode): boolean => {
  for (let sibling = node.getNextSibling(); sibling !== null; sibling = sibling.getNextSibling()) {
    if (!$isLineBreakNode(sibling)) {
      return true;
    }
  }
  return false;
};

/** この改行は、強制改行(行末の「\」)として書き出す必要があるか */
export function needsHardBreak(node: LexicalNode): boolean {
  if (!$isLineBreakNode(node)) {
    return false;
  }
  const previous = node.getPreviousSibling();
  // 前後が文字などで、改行が1つだけ
  const alone = previous !== null && !$isLineBreakNode(previous) && !$isLineBreakNode(node.getNextSibling());
  return !alone && hasContentAfter(node);
}

const hardBreakVisitor: LexicalExportVisitor<LineBreakNode, Break> = {
  // 通常の改行の書き出し(優先度 0)より先に、試す
  priority: 100,
  testLexicalNode: (node): node is LineBreakNode => needsHardBreak(node),
  visitLexicalNode({ mdastParent, actions }) {
    actions.appendToParent(mdastParent, { type: 'break' });
  },
};

export const lineBreakPlugin = realmPlugin({
  init(realm) {
    realm.pub(addExportVisitor$, hardBreakVisitor as LexicalExportVisitor<LexicalNode, Break>);
  },
});
