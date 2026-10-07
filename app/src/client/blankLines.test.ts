import { describe, expect, it } from 'vitest';
import { BLANK_PARAGRAPH, blankParagraphsToNbsp } from './blankLines';

const NBSP = BLANK_PARAGRAPH;

describe('blankParagraphsToNbsp(エディタの空の段落を、「&nbsp;」の段落にする)', () => {
  it('空の段落が無ければ(段落の間が、空行1つ)、そのまま', () => {
    const markdown = '# 題\n\n段落1\n\n段落2\n\n- a\n- b\n';
    expect(blankParagraphsToNbsp(markdown)).toBe(markdown);
  });

  it('空の段落1つ(空行が3行になる)を、「&nbsp;」の段落にする', () => {
    expect(blankParagraphsToNbsp('A\n\n\n\nB')).toBe(`A\n\n${NBSP}\n\nB`);
  });

  it('空の段落2つ以上は、その数だけ「&nbsp;」の段落にする', () => {
    expect(blankParagraphsToNbsp('A\n\n\n\n\n\nB')).toBe(`A\n\n${NBSP}\n\n${NBSP}\n\nB`);
    expect(blankParagraphsToNbsp('A\n\n\n\n\n\n\n\nB')).toBe(`A\n\n${NBSP}\n\n${NBSP}\n\n${NBSP}\n\nB`);
  });

  it('行数は変わらない(空行の連なりと、同じ行数に置き換える)', () => {
    for (const lines of [3, 4, 5, 6, 7, 9]) {
      const markdown = `A${'\n'.repeat(lines + 1)}B`;
      expect(blankParagraphsToNbsp(markdown).split('\n')).toHaveLength(markdown.split('\n').length);
    }
  });

  it('空行が偶数行(エディタは出さない形)のときは、余った空行を残す', () => {
    expect(blankParagraphsToNbsp('A\n\n\n\n\nB')).toBe(`A\n\n${NBSP}\n\n\nB`);
  });

  it('文書の先頭の空の段落も、「&nbsp;」の段落にする', () => {
    expect(blankParagraphsToNbsp('\n\nA')).toBe(`${NBSP}\n\nA`);
    expect(blankParagraphsToNbsp('\n\n\n\nA')).toBe(`${NBSP}\n\n${NBSP}\n\nA`);
  });

  it('文書の末尾の空行(末尾の空の段落)は、「&nbsp;」にしない', () => {
    expect(blankParagraphsToNbsp('A\n\n\n\n')).toBe('A\n\n\n\n');
    expect(blankParagraphsToNbsp('A\n')).toBe('A\n');
    expect(blankParagraphsToNbsp('A\n\nB\n\n\n\n\n\n')).toBe('A\n\nB\n\n\n\n\n\n');
  });

  it('コードフェンスの内側の空行は、そのまま(``` と ~~~ のどちらも)', () => {
    const backtick = '```\nA\n\n\n\n\n\nB\n```';
    const tilde = '~~~\nA\n\n\n\n\n\nB\n~~~';
    expect(blankParagraphsToNbsp(backtick)).toBe(backtick);
    expect(blankParagraphsToNbsp(tilde)).toBe(tilde);
  });

  it('フェンスの前後の空の段落は、「&nbsp;」にする。フェンスの中のコードは変えない', () => {
    const markdown = '前\n\n\n\n```\nx\n\n\n\ny\n```\n\n\n\n後';
    expect(blankParagraphsToNbsp(markdown)).toBe(`前\n\n${NBSP}\n\n\`\`\`\nx\n\n\n\ny\n\`\`\`\n\n${NBSP}\n\n後`);
  });

  it('閉じていないフェンス(書きかけ)の中は、そのまま', () => {
    expect(blankParagraphsToNbsp('```\nA\n\n\n\nB')).toBe('```\nA\n\n\n\nB');
  });

  it('空白だけの行も、空行として数える', () => {
    expect(blankParagraphsToNbsp('A\n\n  \n\nB')).toBe(`A\n\n${NBSP}\n\nB`);
  });

  it('書き直しても、結果は変わらない(2回かけても同じ)', () => {
    for (const markdown of ['A\n\n\n\n\n\nB', '\n\n\n\nA\n\n\n\nB\n\n\n\n', 'A\n\n```\nx\n\n\n\ny\n```\n\n\n\nB']) {
      const once = blankParagraphsToNbsp(markdown);
      expect(blankParagraphsToNbsp(once)).toBe(once);
    }
  });

  it('「&nbsp;」の段落は、空の段落ではない(空行を数えない)ので、そのまま', () => {
    const markdown = `A\n\n${NBSP}\n\n${NBSP}\n\nB`;
    expect(blankParagraphsToNbsp(markdown)).toBe(markdown);
  });
});
