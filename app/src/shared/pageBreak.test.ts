import { describe, expect, it } from 'vitest';
import { isPageBreakHtml, PAGE_BREAK_MARKUP } from './pageBreak.js';

describe('isPageBreakHtml', () => {
  it('エディタが書き出す改ページの印は、改ページとして読める', () => {
    expect(isPageBreakHtml(PAGE_BREAK_MARKUP)).toBe(true);
  });

  it.each([
    '<div style="page-break-after: always"></div>',
    '<div style="page-break-after:always;"></div>',
    "<div style='page-break-after: always;'></div>",
    '<div style="PAGE-BREAK-AFTER: ALWAYS"></div>',
    '<div style="break-after: page"></div>',
    '<div style=" page-break-after : always ; "></div>',
    '  <div style="page-break-after: always"></div>\n',
    '<div style="page-break-after: always"> </div>',
    '<div style="page-break-after: always">\n</div>',
  ])('書き方が違っても、改ページとして読める: %j', (html) => {
    expect(isPageBreakHtml(html)).toBe(true);
  });

  it.each([
    ['別の改ページの指定(before)', '<div style="page-break-before: always"></div>'],
    ['別の値', '<div style="page-break-after: avoid"></div>'],
    ['style以外の属性が混ざる', '<div class="x" style="page-break-after: always"></div>'],
    ['style以外の属性だけ', '<div class="page-break"></div>'],
    ['ほかのスタイルが混ざる', '<div style="page-break-after: always; color: red"></div>'],
    ['属性が無い', '<div></div>'],
    ['中に文字がある', '<div style="page-break-after: always">本文</div>'],
    ['中にタグがある', '<div style="page-break-after: always"><b></b></div>'],
    ['閉じタグが無い', '<div style="page-break-after: always">'],
    ['div以外のタグ', '<p style="page-break-after: always"></p>'],
    ['後ろに文字が続く', '<div style="page-break-after: always"></div>\n本文'],
    ['前に文字がある', '本文\n<div style="page-break-after: always"></div>'],
    ['印が2つ', '<div style="page-break-after: always"></div><div style="page-break-after: always"></div>'],
    ['空の文字列', ''],
  ])('改ページとして読めない: %s', (_name, html) => {
    expect(isPageBreakHtml(html)).toBe(false);
  });
});
