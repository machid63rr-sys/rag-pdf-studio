import { addImportVisitor$, realmPlugin, type MdastImportVisitor } from '@mdxeditor/editor';
import { $createParagraphNode, $isElementNode } from 'lexical';
import type { Nodes, Paragraph } from 'mdast';

/*
 * 書式付きエディタの、文書の直下にある「&nbsp;」(改行しない空白。U+00A0)だけの段落を、空の段落にして表示する。
 * 空の段落は、「&nbsp;」だけの段落として保存される(blankLines.ts)ため、読み込むときに、元の空の段落に戻す。
 * 戻さないと、空白の段落に文字を入力したときに、先頭に見えない空白が残ってしまう。
 *
 * 戻すのは、文書の直下の段落だけ。リストの項目・引用の中や、表のセルは、そのまま(元の内容を変えない)。
 * 表のセルの中身は、エディタが、位置情報の無い仮の段落に包んで読み込むため、位置情報の有無で、文書の段落と見分ける。
 */

/** 「&nbsp;」(U+00A0)だけの段落か(Markdownの文書から読み取った段落だけ。エディタが作った仮の段落は、含めない) */
export function isBlankParagraph(node: Nodes): node is Paragraph {
  if (node.type !== 'paragraph' || node.position === undefined || node.children.length !== 1) {
    return false;
  }
  const [only] = node.children;
  return only?.type === 'text' && only.value === ' ';
}

const blankParagraphVisitor: MdastImportVisitor<Paragraph> = {
  // ふつうの段落の読み込み(優先度 0)より先に、試す
  priority: 100,
  testNode: (node) => isBlankParagraph(node),
  visitNode({ lexicalParent, actions }) {
    if (!$isElementNode(lexicalParent) || lexicalParent.getType() !== 'root') {
      actions.nextVisitor();
      return;
    }
    lexicalParent.append($createParagraphNode());
  },
};

export const blankParagraphPlugin = realmPlugin({
  init(realm) {
    realm.pub(addImportVisitor$, blankParagraphVisitor as MdastImportVisitor<Nodes>);
  },
});
