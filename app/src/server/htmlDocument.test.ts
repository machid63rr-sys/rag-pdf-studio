import { describe, expect, it } from 'vitest';
import { prepareHtmlForPdf } from './htmlDocument.js';

const CSP_META = /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">/;

describe('prepareHtmlForPdf', () => {
  it('headの先頭に、外部読み込みを禁じるCSPを加え、利用者のHTMLはそのまま保つ', () => {
    const source = '<!DOCTYPE html><html lang="ja"><head><title>手順書</title><style>p { color: red; }</style></head><body><p class="a">本文 &amp; 説明</p></body></html>';
    const result = prepareHtmlForPdf(source);
    expect(result).toMatch(CSP_META);
    expect(result.indexOf('Content-Security-Policy')).toBeLessThan(result.indexOf('<title>'));
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<html lang="ja">');
    expect(result).toContain('<style>p { color: red; }</style>');
    expect(result).toContain('<p class="a">本文 &amp; 説明</p>');
  });

  it('html/head/bodyが省略された断片にも、CSPを加える(本文の内容は保つ)', () => {
    const result = prepareHtmlForPdf('<h1>タイトル</h1><p>本文</p>');
    expect(result).toMatch(CSP_META);
    expect(result).toContain('<body><h1>タイトル</h1><p>本文</p></body>');
  });

  it('メタリフレッシュ(別ページへの自動移動)は、headにあってもbodyにあっても除く', () => {
    const result = prepareHtmlForPdf(
      '<head><meta http-equiv="Refresh" content="0;url=https://example.com"><title>t</title></head><body><meta http-equiv="refresh" content="5"><p>x</p></body>',
    );
    expect(result).not.toMatch(/refresh/i);
    expect(result).toContain('<title>t</title>');
    expect(result).toContain('<p>x</p>');
  });

  it('利用者がCSPを指定していても、こちらのCSPが先に置かれる', () => {
    const result = prepareHtmlForPdf('<head><meta http-equiv="Content-Security-Policy" content="default-src *"></head>');
    expect(result.indexOf("default-src 'none'")).toBeLessThan(result.indexOf('default-src *'));
  });

  it('スクリプトは削除しない(実行はChromium側で無効にしている)', () => {
    expect(prepareHtmlForPdf('<body><script>1</script></body>')).toContain('<script>1</script>');
  });
});
