import { describe, expect, it } from 'vitest';
import { lintMarkdown } from './lint';

const codes = (markdown: string): string[] => lintMarkdown(markdown).map((warning) => warning.code);
const linesOf = (markdown: string, code: string): readonly number[] | undefined =>
  lintMarkdown(markdown).find((warning) => warning.code === code)?.lines;

describe('lintMarkdown', () => {
  it('問題の無いMarkdownは警告なし', () => {
    const markdown = '# 見出し\n\n本文 **太字** と `code`。[リンク](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    expect(lintMarkdown(markdown)).toEqual([]);
  });

  describe('front matter', () => {
    it('先頭のfront matterを検出する', () => {
      expect(linesOf('---\ntitle: T\n---\n\n本文', 'front-matter')).toEqual([1]);
    });

    it('閉じていない---や、先頭でない---は対象外', () => {
      expect(codes('---\n本文だけ')).toEqual([]);
      expect(codes('本文\n\n---\nx\n---')).toEqual([]);
    });

    it('front matter内の記述は、他の検査の対象にしない', () => {
      expect(codes('---\nnote: <b>x</b>\n---\n本文')).toEqual(['front-matter']);
    });
  });

  describe('画像の<img>タグ(エディタで大きさを変えた画像)', () => {
    const tag = (src: string): string => `本文<img height="166" width="300" src="${src}" />`;

    it('画像として表示されるため、HTMLタグの警告は出ない(data URI)', () => {
      expect(codes(tag('data:image/png;base64,iVBORw=='))).toEqual([]);
    });

    it('取り込んだ画像を指していれば、警告は出ない', () => {
      expect(lintMarkdown(tag('images/a.png'), (reference) => reference === 'images/a.png')).toEqual([]);
    });

    it('表示できない画像(外部URL・取り込んだ中に無いもの)は、画像の警告になる(HTMLタグの警告にはならない)', () => {
      expect(codes(tag('https://example.com/a.png'))).toEqual(['unsupported-image']);
      expect(codes(tag('images/none.png'))).toEqual(['unsupported-image']);
    });

    it('画像として読めないHTMLタグ(srcなし・ほかのタグ)は、これまでどおり、HTMLタグの警告になる', () => {
      expect(codes('<img alt="x">')).toEqual(['raw-html']);
      expect(codes('<p><img src="data:image/png;base64,AA=="></p>')).toEqual(['raw-html']);
    });

    it('画像の<img>と、ほかのHTMLタグが同じ行にあれば、HTMLタグの警告は出る', () => {
      expect(codes('改行<br>' + tag('data:image/png;base64,AA=='))).toEqual(['raw-html']);
    });

    it('インラインコード・コードフェンスの中の<img>は、対象外', () => {
      expect(codes('`<img src="https://example.com/a.png">`')).toEqual([]);
      expect(codes('```\n<img src="https://example.com/a.png">\n```')).toEqual([]);
    });
  });

  describe('画像', () => {
    it('外部URLの画像を、行番号つきで検出する', () => {
      expect(linesOf('本文\n\n![図](https://example.com/a.png)', 'unsupported-image')).toEqual([3]);
      expect(linesOf('![図](./a.png)', 'unsupported-image')).toEqual([1]);
    });

    it('取り込んだ画像として表示できる参照は警告しない(表示できないものだけ警告する)', () => {
      const canDisplay = (reference: string): boolean => reference === 'images/a.png' || reference === '日本 図.png';
      expect(lintMarkdown('![図](images/a.png)\n![図](<日本 図.png>)', canDisplay)).toEqual([]);
      const warnings = lintMarkdown('![図](images/a.png)\n![図](images/none.png)\n![図](https://example.com/a.png)', canDisplay);
      expect(warnings.map((warning) => [warning.code, warning.lines])).toEqual([['unsupported-image', [2, 3]]]);
    });

    it('data URIの画像は警告しない(大文字小文字を問わない)', () => {
      expect(codes('![p](data:image/png;base64,AAAA)')).toEqual([]);
      expect(codes('![p](DATA:image/png;base64,AAAA)')).toEqual([]);
    });

    it('コードフェンス内・インラインコード内の画像記法は対象外', () => {
      expect(codes('```\n![図](https://example.com/a.png)\n```')).toEqual([]);
      expect(codes('書き方は `![図](https://example.com/a.png)` です')).toEqual([]);
    });
  });

  describe('生HTML', () => {
    it('<br>・<div>・コメントを検出する', () => {
      expect(linesOf('a<br>b\n\n<div>x</div>\n\n<!-- c -->', 'raw-html')).toEqual([1, 3, 5]);
      expect(codes('改行<br/>です')).toEqual(['raw-html']);
    });

    it('自動リンクや日本語の山括弧、比較式は生HTMLとみなさない', () => {
      expect(codes('<https://example.com/a> と <foo@example.com>')).toEqual([]);
      expect(codes('画面の <エラー一覧表> を見る')).toEqual([]);
      expect(codes('a < b かつ c > d')).toEqual([]);
    });

    it('コードの内側は対象外', () => {
      expect(codes('`<br>` と書く')).toEqual([]);
      expect(codes('```html\n<div>x</div>\n```')).toEqual([]);
    });
  });

  describe('手動の改ページ', () => {
    it('改ページの印の行は、改ページとして扱われるため、生HTMLの警告の対象外', () => {
      expect(codes('前\n\n<div style="page-break-after: always"></div>\n\n後')).toEqual([]);
      expect(codes('<div style="break-after: page"></div>')).toEqual([]);
    });

    it('改ページではないHTMLは、これまでどおり警告する', () => {
      expect(linesOf('前\n\n<div style="page-break-after: always"></div>\n<div>x</div>\n\n後', 'raw-html')).toEqual([4]);
      expect(codes('<div class="page-break"></div>')).toEqual(['raw-html']);
    });
  });

  describe('崩れた表', () => {
    it('表として成立しない表形式の行を、先頭行の行番号で報告する', () => {
      expect(linesOf('本文\n\n| a | b | c |\n| --- | --- |\n| 1 | 2 |', 'broken-table')).toEqual([3]);
    });
  });

  it('複数の警告は、front matter・表・画像・HTMLの順に並ぶ', () => {
    const markdown = '---\nt: 1\n---\n\n![a](x.png)\n\n<br>\n\n| a | b | c |\n| - | - |';
    expect(codes(markdown)).toEqual(['front-matter', 'broken-table', 'unsupported-image', 'raw-html']);
  });
});
