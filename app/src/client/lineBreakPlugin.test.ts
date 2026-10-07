import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { needsHardBreak } from './lineBreakPlugin';

// 段落の中身を、'a'(文字)と '|'(改行)で表し、各改行が、強制改行として書き出されるかを、先頭から順に返す
function hardBreaksOf(shape: string): boolean[] {
  const editor = createEditor({ onError: (error) => { throw error; } });
  let result: boolean[] = [];
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      const nodes: LexicalNode[] = [...shape].map((char) => (char === '|' ? $createLineBreakNode() : $createTextNode(char)));
      paragraph.append(...nodes);
      $getRoot().append(paragraph);
      result = nodes.filter((node) => node.getType() === 'linebreak').map((node) => needsHardBreak(node));
    },
    { discrete: true },
  );
  return result;
}

describe('needsHardBreak(段落の中の改行を、強制改行として書き出すか)', () => {
  it('文字と文字の間の、1つだけの改行は、ただの改行のまま', () => {
    expect(hardBreaksOf('a|b')).toEqual([false]);
    expect(hardBreaksOf('a|b|c')).toEqual([false, false]);
  });

  it('改行が続くときは、すべて強制改行(後ろに文字がある場合)', () => {
    expect(hardBreaksOf('a||b')).toEqual([true, true]);
    expect(hardBreaksOf('a|||b')).toEqual([true, true, true]);
    expect(hardBreaksOf('a||b|c')).toEqual([true, true, false]);
  });

  it('段落の先頭の改行は、強制改行(先頭の改行文字は、Markdownで消えるため)', () => {
    expect(hardBreaksOf('|a')).toEqual([true]);
    expect(hardBreaksOf('||a')).toEqual([true, true]);
  });

  it('段落の末尾に続く改行は、ただの改行のまま(末尾の「\\」が、文字として表示されないように)', () => {
    expect(hardBreaksOf('a|')).toEqual([false]);
    expect(hardBreaksOf('a||')).toEqual([false, false]);
    expect(hardBreaksOf('a||b||')).toEqual([true, true, false, false]);
  });

  it('改行だけの段落は、ただの改行のまま(後ろに文字が無い)', () => {
    expect(hardBreaksOf('||')).toEqual([false, false]);
  });
});
