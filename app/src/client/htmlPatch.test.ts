import { describe, expect, it } from 'vitest';
import { patchHtmlSource } from './htmlPatch';

// プレビューの編集後の文書を、本文(body)の中身だけで表す(headの違いは無視される)
const edited = (body: string, head = ''): string => `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
const patch = (source: string, editedHtml: string): string => patchHtmlSource(source, editedHtml).html;

const PAGE = [
  '<!DOCTYPE html>',
  '<html lang="ja">',
  "<head>",
  '  <meta charset="utf-8">',
  '  <title>手順書</title>',
  "  <style>h1 { color: red; } a>b { margin: 0 }</style>",
  '</head>',
  '<body class=main>',
  '  <h1 id=top>見出し &amp; タイトル</h1>',
  "  <p class='lead'>最初の段落です。&copy; 2026</p>",
  '  <!-- メモ -->',
  '  <ul>',
  '    <li>項目1',
  '    <li>項目2',
  '  </ul>',
  '  <table><tr><td>A</td><td>B</td></tr></table>',
  '  <pre>  整形済み\n    テキスト</pre>',
  '</body>',
  '</html>',
  '',
].join('\n');

describe('編集していない場合は、ソースが1文字も変わらない', () => {
  const sources: Record<string, string> = {
    '整った文書': PAGE,
    '省略タグ(</p>・</li>)': '<p>one\n<p>two\n<ul><li>a<li>b</ul>',
    '暗黙のtbody': '<table><tr><td>x</td></tr></table>',
    'html/head/bodyが無い断片': '<h1>タイトル</h1>\n<p>本文</p>\n',
    'CRLF': '<!doctype html>\r\n<body>\r\n<p>a</p>\r\n</body>\r\n',
    '大文字タグ・属性の引用符': '<BODY><P CLASS="x" id=\'y\'>テキスト</P></BODY>',
    '空の文書': '',
    'doctypeだけ': '<!DOCTYPE html>',
    '</body></html>の前後に空白': '<body><p>x</p>\n</body>\n</html>\n',
    'コメントだけの本文': '<body><!-- a --></body>',
  };

  it.each(Object.entries(sources))('%s', (_name, source) => {
    // ブラウザが解釈し直して出力した文書(ここでは、ソースをそのままパースした結果)と同じ内容
    expect(patchHtmlSource(source, source)).toEqual({ html: source, rewroteBody: false });
  });

  it('headにCSSの埋め込みなど、プレビュー用の変更があっても、無視される', () => {
    const preview = PAGE.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">').replace(
      '</head>',
      '<style>p { color: blue }</style></head>',
    );
    expect(patch(PAGE, preview)).toBe(PAGE);
  });
});

describe('文字の編集', () => {
  it('編集した段落の文字だけが変わり、他の部分(インデント・属性・実体参照・コメント)はそのまま', () => {
    const result = patch(PAGE, PAGE.replace('最初の段落です。&copy; 2026', '書き換えました。&copy; 2026'));
    expect(result).toBe(PAGE.replace('最初の段落です。&copy; 2026', '書き換えました。© 2026'));
    // 触っていない見出しの「&amp;」・省略タグ・引用符は、そのまま残る
    expect(result).toContain('<h1 id=top>見出し &amp; タイトル</h1>');
    expect(result).toContain('<li>項目1\n    <li>項目2');
    expect(result).toContain("<p class='lead'>");
    expect(result).toContain('<body class=main>');
  });

  it('編集した文字は、<・&・改行なしスペース(nbsp)が実体参照になる', () => {
    const source = '<p>abc</p>';
    expect(patch(source, edited('<p>a &lt; b &amp; c&nbsp;d</p>'))).toBe('<p>a &lt; b &amp; c&nbsp;d</p>');
  });

  it('見出しの中の実体参照(&amp;)は、その見出しを編集しない限り変わらない', () => {
    const result = patch(PAGE, PAGE.replace('<li>項目1', '<li>項目1(改)'));
    expect(result).toBe(PAGE.replace('<li>項目1', '<li>項目1(改)'));
  });

  it('終了タグが省略された段落の中の文字を編集できる', () => {
    const source = '<p>one\n<p>two\n<ul><li>a<li>b</ul>';
    expect(patch(source, edited('<p>one\n</p><p>TWO\n</p><ul><li>a</li><li>b</li></ul>'))).toBe('<p>one\n<p>TWO\n<ul><li>a<li>b</ul>');
  });

  it('暗黙のtbodyがある表のセルを編集できる', () => {
    const source = '<table><tr><td>A</td><td>B</td></tr></table>';
    expect(patch(source, edited('<table><tbody><tr><td>A</td><td>BBB</td></tr></tbody></table>'))).toBe(
      '<table><tr><td>A</td><td>BBB</td></tr></table>',
    );
  });

  it('<pre>の中の空白・改行は、その外を編集しても保たれ、中を編集した場合はその部分だけが変わる', () => {
    const outside = patch(PAGE, PAGE.replace('<li>項目2', '<li>項目2(改)'));
    expect(outside).toContain('<pre>  整形済み\n    テキスト</pre>');

    const inside = patch(PAGE, PAGE.replace('整形済み\n    テキスト', '整形済み\n    テキスト\n      追加'));
    expect(inside).toBe(PAGE.replace('整形済み\n    テキスト', '整形済み\n    テキスト\n      追加'));
  });

  it('html/head/bodyが無い断片でも、編集した箇所だけが変わる', () => {
    const source = '<h1>タイトル</h1>\n<p>本文</p>\n';
    expect(patch(source, edited('<h1>タイトル</h1>\n<p>本文を直しました</p>\n'))).toBe('<h1>タイトル</h1>\n<p>本文を直しました</p>\n');
  });

  it('</body></html>の前後の空白とまとめられた文字を編集しても、終了タグは壊れない', () => {
    const source = '<body><p>x</p>\n</body>\n</html>\n';
    const result = patch(source, edited('<p>x</p>\n\nあとから入力'));
    expect(result).toContain('</body>');
    expect(result).toContain('</html>');
    expect(result).toContain('あとから入力');
    expect(result.indexOf('あとから入力')).toBeLessThan(result.indexOf('</body>'));
  });
});

describe('構造の編集(段落の分割・太字・削除・追加)', () => {
  const doc = '<body>\n  <h1>題</h1>\n  <p>hello world</p>\n  <p>end</p>\n</body>';

  it('段落の分割(Enter): 分割した段落だけが書き換わる', () => {
    const result = patch(doc, edited('\n  <h1>題</h1>\n  <p>hello</p><p> world</p>\n  <p>end</p>\n'));
    expect(result).toBe('<body>\n  <h1>題</h1>\n  <p>hello</p><p> world</p>\n  <p>end</p>\n</body>');
  });

  it('太字にする: その段落の中だけが書き換わる', () => {
    const result = patch(doc, edited('\n  <h1>題</h1>\n  <p>hello <b>world</b></p>\n  <p>end</p>\n'));
    expect(result).toBe('<body>\n  <h1>題</h1>\n  <p>hello <b>world</b></p>\n  <p>end</p>\n</body>');
  });

  it('段落の削除', () => {
    const result = patch(doc, edited('\n  <h1>題</h1>\n  \n  <p>end</p>\n'));
    expect(result).toBe('<body>\n  <h1>題</h1>\n  \n  <p>end</p>\n</body>');
  });

  it('末尾への追加', () => {
    const result = patch(doc, edited('\n  <h1>題</h1>\n  <p>hello world</p>\n  <p>end</p>\n<p>追加</p>'));
    expect(result).toBe('<body>\n  <h1>題</h1>\n  <p>hello world</p>\n  <p>end</p>\n<p>追加</p></body>');
  });

  it('先頭への追加', () => {
    const result = patch(doc, edited('<p>先頭</p>\n  <h1>題</h1>\n  <p>hello world</p>\n  <p>end</p>\n'));
    expect(result).toBe('<body><p>先頭</p>\n  <h1>題</h1>\n  <p>hello world</p>\n  <p>end</p>\n</body>');
  });

  it('属性の変更: その要素だけが書き換わる', () => {
    const result = patch(doc, edited('\n  <h1>題</h1>\n  <p style="text-align: center;">hello world</p>\n  <p>end</p>\n'));
    expect(result).toBe('<body>\n  <h1>題</h1>\n  <p style="text-align: center;">hello world</p>\n  <p>end</p>\n</body>');
  });

  it('空の本文へ入力した場合は、<body>の中に入る', () => {
    expect(patch('<body></body>', edited('<p>入力</p>'))).toBe('<body><p>入力</p></body>');
  });

  it('何も無い文書へ入力した場合は、末尾に追加される', () => {
    expect(patch('<!DOCTYPE html>', edited('<p>入力</p>'))).toBe('<!DOCTYPE html><p>入力</p>');
  });

  it('本文をすべて削除できる', () => {
    expect(patch(doc, edited(''))).toBe('<body></body>');
  });

  it('複数の箇所を同時に編集しても、それぞれだけが変わる', () => {
    const result = patch(doc, edited('\n  <h1>新しい題</h1>\n  <p>hello world</p>\n  <p>終わり</p>\n'));
    expect(result).toBe('<body>\n  <h1>新しい題</h1>\n  <p>hello world</p>\n  <p>終わり</p>\n</body>');
  });
});

describe('スタイル・スクリプト', () => {
  it('<style>の中身がプレビュー用に書き換えられていても(画像の埋め込みなど)、差分とみなさない', () => {
    const source = '<body><style>p { background: url(a.png) }</style><p>x</p></body>';
    const preview = edited('<style>p { background: url("data:image/png;base64,AAAA") }</style><p>x</p>');
    expect(patch(source, preview)).toBe(source);
    // 他の部分の編集は反映される
    expect(patch(source, edited('<style>p { background: url("data:image/png;base64,AAAA") }</style><p>xy</p>'))).toBe(
      '<body><style>p { background: url(a.png) }</style><p>xy</p></body>',
    );
  });

  it('<style>の中身は、編集していない限り変わらない(エスケープされない)', () => {
    const source = '<body><style>a>b { margin: 0 }</style><p>x</p></body>';
    expect(patch(source, edited('<style>a>b { margin: 0 }</style><p>xy</p>'))).toBe(
      '<body><style>a>b { margin: 0 }</style><p>xy</p></body>',
    );
  });
});
