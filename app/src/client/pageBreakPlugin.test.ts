import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type TextNode } from 'lexical';
import type { Nodes } from 'mdast';
import { describe, expect, it } from 'vitest';
import { PAGE_BREAK_MARKUP } from '../shared/pageBreak';
import { insertPageBreak, isPageBreakParagraph, PageBreakNode } from './pageBreakPlugin';

const position = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 7, offset: 6 } };
const paragraph = (value: string, withPosition = true): Nodes => ({
  type: 'paragraph',
  children: [{ type: 'text', value }],
  ...(withPosition ? { position } : {}),
});

describe('isPageBreakParagraph', () => {
  it('Markdownの文書から読み取った、改ページの印の文字だけの段落は、改ページ', () => {
    expect(isPageBreakParagraph(paragraph(PAGE_BREAK_MARKUP))).toBe(true);
  });

  it('書き方が違う印(break-after: page・引用符・大文字小文字)も、改ページ(PDFと同じ判定)', () => {
    expect(isPageBreakParagraph(paragraph('<div style="break-after: page"></div>'))).toBe(true);
    expect(isPageBreakParagraph(paragraph("<div style='PAGE-BREAK-AFTER:always;'></div>"))).toBe(true);
  });

  it('位置情報の無い段落(エディタが、表のセルの中身を包むために作る仮の段落)は、対象外', () => {
    expect(isPageBreakParagraph(paragraph(PAGE_BREAK_MARKUP, false))).toBe(false);
  });

  it('改ページの印でない文字・ほかの文字が混ざる段落は、対象外', () => {
    for (const value of ['', '本文', '<div></div>', '<div class="x"></div>', `前${PAGE_BREAK_MARKUP}`, `${PAGE_BREAK_MARKUP}後`]) {
      expect(isPageBreakParagraph(paragraph(value)), JSON.stringify(value)).toBe(false);
    }
  });

  it('子が複数の段落・段落以外は、対象外', () => {
    expect(isPageBreakParagraph({ type: 'paragraph', position, children: [{ type: 'text', value: PAGE_BREAK_MARKUP }, { type: 'text', value: 'a' }] })).toBe(false);
    expect(isPageBreakParagraph({ type: 'paragraph', position, children: [] })).toBe(false);
    expect(isPageBreakParagraph({ type: 'heading', depth: 1, position, children: [{ type: 'text', value: PAGE_BREAK_MARKUP }] })).toBe(false);
  });
});

describe('insertPageBreak(カーソルの位置に、改ページの区切りを入れる)', () => {
  const MARK = '[改ページ]';

  /**
   * 段落(blocks。空文字は空の段落)を並べ、caret の位置(段落の番号と、文字の位置。focus を指定すれば範囲選択)にカーソルを置いて、
   * 区切りを入れる。結果を、文書の直下のブロックの並び(段落は文字、区切りは MARK)で返す。caret が null なら、選択なし
   */
  function run(blocks: string[], caret: { block: number; offset: number; focus?: number } | null): { outline: string[]; selectedBlock: number } {
    const editor = createEditor({ nodes: [PageBreakNode], onError: (error) => { throw error; } });
    editor.update(
      () => {
        const paragraphs = blocks.map((text) => {
          const paragraph = $createParagraphNode();
          if (text !== '') {
            paragraph.append($createTextNode(text));
          }
          return paragraph;
        });
        $getRoot().append(...paragraphs);
        if (caret !== null) {
          const target = paragraphs[caret.block];
          const text = target?.getFirstChild() as TextNode | null | undefined;
          if (text === null || text === undefined) {
            target?.select();
          } else {
            text.select(caret.offset, caret.focus ?? caret.offset);
          }
        }
      },
      { discrete: true },
    );
    insertPageBreak(editor);
    return editor.read(() => {
      const children = $getRoot().getChildren();
      const anchor = editor.getEditorState()._selection;
      const selected = anchor !== null && 'anchor' in anchor ? (anchor as { anchor: { getNode(): { getTopLevelElement(): unknown } } }).anchor.getNode().getTopLevelElement() : null;
      return {
        outline: children.map((node) => (node instanceof PageBreakNode ? MARK : node.getTextContent())),
        selectedBlock: children.findIndex((node) => node === selected),
      };
    });
  }

  it('段落の途中: そこで段落を2つに分け、間に区切りが入る。カーソルは、後ろの段落の先頭に移る', () => {
    const { outline, selectedBlock } = run(['abcdef'], { block: 0, offset: 3 });
    expect(outline).toEqual(['abc', MARK, 'def']);
    expect(selectedBlock).toBe(2);
  });

  it('段落の末尾: その段落の後ろに入る(空の段落は残らない)。カーソルは、次の段落の先頭に移る', () => {
    const { outline, selectedBlock } = run(['abc', 'xyz'], { block: 0, offset: 3 });
    expect(outline).toEqual(['abc', MARK, 'xyz']);
    expect(selectedBlock).toBe(2);
  });

  it('段落の先頭: その段落の前に入る(空の段落は残らない)', () => {
    expect(run(['abc', 'xyz'], { block: 1, offset: 0 }).outline).toEqual(['abc', MARK, 'xyz']);
    expect(run(['abc'], { block: 0, offset: 0 }).outline).toEqual([MARK, 'abc']);
  });

  it('空の段落: その段落が、区切りに置き換わる', () => {
    expect(run(['abc', '', 'xyz'], { block: 1, offset: 0 }).outline).toEqual(['abc', MARK, 'xyz']);
  });

  it('文書の最後の段落の末尾: 区切りの後ろに、続きを書くための空の段落ができ、カーソルはそこに置かれる', () => {
    const { outline, selectedBlock } = run(['abc'], { block: 0, offset: 3 });
    expect(outline).toEqual(['abc', MARK, '']);
    expect(selectedBlock).toBe(2);
  });

  it('文書に空の段落が1つだけのとき: 区切りと、続きを書く空の段落になる', () => {
    expect(run([''], { block: 0, offset: 0 }).outline).toEqual([MARK, '']);
  });

  it('範囲を選択しているとき: 選択した文字は消え、その位置で分かれる', () => {
    expect(run(['abcdef'], { block: 0, offset: 2, focus: 4 }).outline).toEqual(['ab', MARK, 'ef']);
  });

  it('選択が無いとき: 文書の最後に、区切りと、続きを書く空の段落を置く', () => {
    expect(run(['abc', 'xyz'], null).outline).toEqual(['abc', 'xyz', MARK, '']);
  });

  it('区切りは、文書の直下に入る(区切りの前後の段落の文字は、変わらない)', () => {
    const { outline } = run(['一つ目', '二つ目', '三つ目'], { block: 1, offset: 1 });
    expect(outline).toEqual(['一つ目', '二', MARK, 'つ目', '三つ目']);
  });
});
