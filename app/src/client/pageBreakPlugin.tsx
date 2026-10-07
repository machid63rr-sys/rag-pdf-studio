import React from 'react';
import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  ButtonWithTooltip,
  realmPlugin,
  rootEditor$,
  useCellValue,
  type LexicalExportVisitor,
  type MdastImportVisitor,
} from '@mdxeditor/editor';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  DecoratorNode,
  type EditorConfig,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  type RangeSelection,
  type SerializedLexicalNode,
} from 'lexical';
import type { Html, Nodes, Paragraph } from 'mdast';
import { isPageBreakHtml, PAGE_BREAK_MARKUP } from '../shared/pageBreak';

/*
 * 書式付きエディタの、手動の改ページ。
 *
 * Markdownでは、改ページは、<div style="page-break-after: always"></div> の1行で書く(shared/pageBreak.ts)。
 * エディタは、Markdownを読み込む前に、「<」を「\<」にして、文字として扱わせている(mdxEscape.ts)ため、この1行は、
 * 「<div …></div>」という文字だけの段落として読み込まれる。それを、「改ページ」の区切りの表示(PageBreakNode)にする。
 * 書き出すときは、区切りを、HTMLのブロック(html。値は、そのまま出力される)にして、元の1行にする。
 * 文字の段落にすると、「=」などが「\=」にエスケープされて、印が崩れる。
 *
 * 区切りの表示は、文書の直下に置く(リストや引用の中には置かない)。PDFが、直下の改ページだけを扱うため。
 */

/** 文書から読み取った、改ページの印(「<div …></div>」の文字)だけの段落か。エディタが作った仮の段落は、含めない */
export function isPageBreakParagraph(node: Nodes): node is Paragraph {
  if (node.type !== 'paragraph' || node.position === undefined || node.children.length !== 1) {
    return false;
  }
  const [only] = node.children;
  return only?.type === 'text' && isPageBreakHtml(only.value);
}

/** 改ページの区切り。本文の文字を持たず、PDFで、その位置から新しいページになる */
export class PageBreakNode extends DecoratorNode<null> {
  static getType(): string {
    return 'page-break';
  }

  static clone(node: PageBreakNode): PageBreakNode {
    return new PageBreakNode(node.__key);
  }

  static importJSON(serializedNode: SerializedLexicalNode): PageBreakNode {
    return $createPageBreakNode().updateFromJSON(serializedNode);
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const key = this.getKey();
    const element = document.createElement('div');
    element.className = 'page-break-marker';
    element.contentEditable = 'false';
    const label = document.createElement('span');
    label.textContent = '改ページ';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'page-break-marker-remove';
    remove.textContent = '削除';
    remove.setAttribute('aria-label', '改ページを削除');
    remove.addEventListener('click', () => {
      editor.update(() => {
        $getNodeByKey(key)?.remove();
      });
    });
    element.append(label, remove);
    return element;
  }

  updateDOM(): boolean {
    return false;
  }

  getTextContent(): string {
    return '\n';
  }

  isInline(): boolean {
    return false;
  }

  decorate(): null {
    return null;
  }
}

export const $createPageBreakNode = (): PageBreakNode => $applyNodeReplacement(new PageBreakNode());

const pageBreakImportVisitor: MdastImportVisitor<Paragraph> = {
  // ふつうの段落の読み込み(優先度 0)より先に、試す
  priority: 100,
  testNode: (node) => isPageBreakParagraph(node),
  visitNode({ lexicalParent, actions }) {
    if (!$isElementNode(lexicalParent) || lexicalParent.getType() !== 'root') {
      actions.nextVisitor();
      return;
    }
    lexicalParent.append($createPageBreakNode());
  },
};

const pageBreakExportVisitor: LexicalExportVisitor<PageBreakNode, Html> = {
  testLexicalNode: (node): node is PageBreakNode => node instanceof PageBreakNode,
  visitLexicalNode({ mdastParent, actions }) {
    actions.appendToParent(mdastParent, { type: 'html', value: PAGE_BREAK_MARKUP });
  },
};

export const pageBreakPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addImportVisitor$]: pageBreakImportVisitor as MdastImportVisitor<Nodes>,
      [addLexicalNode$]: PageBreakNode,
      [addExportVisitor$]: pageBreakExportVisitor as LexicalExportVisitor<LexicalNode, Html>,
    });
  },
});

// 子を持たない(文字も、画像も、改行も無い)段落か
const isBlank = (node: ElementNode): boolean => node.getChildrenSize() === 0;

// いまの選択がある、文書の直下のブロック。選択が無ければ null
function topLevelBlockOfSelection(): ReturnType<LexicalNode['getTopLevelElement']> {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    return selection.anchor.getNode().getTopLevelElement();
  }
  if ($isNodeSelection(selection)) {
    return selection.getNodes().at(-1)?.getTopLevelElement() ?? null;
  }
  return null;
}

// 段落の、カーソルの位置で、段落を2つに分けて、間に区切りを入れる。空になった段落は、残さない
function splitParagraphAt(block: ParagraphNode, selection: RangeSelection, marker: PageBreakNode): void {
  const tail = selection.insertParagraph();
  block.insertAfter(marker);
  if (isBlank(block)) {
    block.remove();
  }
  // 区切りの後ろの空の段落(段落の末尾で入れた場合)は、文書の末尾でなければ、残さない(PDFで、ページの先頭に空行ができるため)
  if (tail !== null && isBlank(tail) && tail.getNextSibling() !== null) {
    tail.remove();
  }
}

/**
 * 改ページの区切りを、カーソルの位置に入れる。
 * - 段落の途中: そこで、段落を2つに分けて、間に入れる
 * - 段落の先頭・末尾: 段落の前・後ろに入れる(空の段落は、残さない)
 * - 空の段落: その段落を、区切りに置き換える
 * - 見出し・リスト・表など: そのブロックの後ろに入れる
 * 区切りが、文書の最後になるときは、続きを書くための空の段落を置く
 */
export function insertPageBreak(editor: LexicalEditor): void {
  editor.update(() => {
    const marker = $createPageBreakNode();
    const selection = $getSelection();
    const top = topLevelBlockOfSelection();
    if (top === null) {
      $getRoot().append(marker);
    } else if ($isParagraphNode(top) && $isRangeSelection(selection)) {
      splitParagraphAt(top, selection, marker);
    } else {
      top.insertAfter(marker);
    }
    if (marker.getNextSibling() === null) {
      const paragraph = $createParagraphNode();
      marker.insertAfter(paragraph);
      paragraph.select();
    } else {
      marker.selectNext(0, 0);
    }
  });
}

/** ツールバーのボタン。カーソルの位置に、改ページを入れる */
export const InsertPageBreak: React.FC = () => {
  const rootEditor = useCellValue(rootEditor$);
  return (
    <ButtonWithTooltip
      title="改ページを入れる(PDFで、ここから新しいページになります)"
      disabled={rootEditor === null}
      onClick={() => {
        if (rootEditor !== null) {
          rootEditor.focus(() => insertPageBreak(rootEditor), { defaultSelection: 'rootEnd' });
        }
      }}
    >
      <span className="page-break-button">改ページ</span>
    </ButtonWithTooltip>
  );
};
