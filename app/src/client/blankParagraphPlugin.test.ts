import type { Nodes } from 'mdast';
import { describe, expect, it } from 'vitest';
import { isBlankParagraph } from './blankParagraphPlugin';

const position = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 7, offset: 6 } };
const paragraph = (value: string, withPosition = true): Nodes => ({
  type: 'paragraph',
  children: [{ type: 'text', value }],
  ...(withPosition ? { position } : {}),
});

describe('isBlankParagraph', () => {
  it('Markdownの文書から読み取った、「&nbsp;」(U+00A0)だけの段落は、空の段落', () => {
    expect(isBlankParagraph(paragraph(' '))).toBe(true);
  });

  it('位置情報の無い段落(エディタが、表のセルの中身を包むために作る仮の段落)は、対象外', () => {
    expect(isBlankParagraph(paragraph(' ', false))).toBe(false);
  });

  it('文字のある段落・ふつうの空白だけの段落・空白が複数の段落は、対象外', () => {
    for (const value of ['', ' ', 'a', ' a', 'a ', '  ', '　']) {
      expect(isBlankParagraph(paragraph(value)), JSON.stringify(value)).toBe(false);
    }
  });

  it('子が複数の段落・段落以外は、対象外', () => {
    expect(isBlankParagraph({ type: 'paragraph', position, children: [{ type: 'text', value: ' ' }, { type: 'text', value: 'a' }] })).toBe(false);
    expect(isBlankParagraph({ type: 'paragraph', position, children: [] })).toBe(false);
    expect(isBlankParagraph({ type: 'heading', depth: 1, position, children: [{ type: 'text', value: ' ' }] })).toBe(false);
  });
});
