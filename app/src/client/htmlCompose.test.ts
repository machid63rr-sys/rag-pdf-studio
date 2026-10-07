import { describe, expect, it } from 'vitest';
import { AssetStore, type BundleFile } from './assets';
import type { Stylesheet } from './documents';
import { composeDocument, composeHtml, ORIGINAL_ATTRIBUTE_PREFIX } from './htmlCompose';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // base64: iVBORw==
const PNG_URI = 'data:image/png;base64,iVBORw==';
const file = (path: string, content: ArrayBuffer = PNG): BundleFile => ({ path, file: { name: path, arrayBuffer: () => Promise.resolve(content) } });
const css = (path: string, text: string, outputPath = path): Stylesheet => ({ path, outputPath, text });

const CSS = css('style.css', 'p { color: red; }');
const plain = { preview: false } as const;
const preview = { preview: true } as const;

// 参照している画像をすべて読み込んだ状態の文脈を作る(実際の画面でも、描画の前に読み込んでから合成する)
async function context(files: readonly string[], options: { structured?: boolean; baseDir?: string } = {}) {
  const assets = new AssetStore(files.map((path) => file(path)), options.structured ?? false);
  await assets.ensure(files);
  return { assets, baseDir: options.baseDir ?? '' };
}

describe('composeHtml: CSSの埋め込み', () => {
  it('<head>内の<link>は、その位置へCSSを埋め込む(他の部分は変わらない)', async () => {
    const source = '<!DOCTYPE html>\n<html>\n<head>\n  <title>t</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body><p>x</p></body>\n</html>';
    expect(composeHtml(source, [CSS], await context(['style.css']), plain)).toBe(
      '<!DOCTYPE html>\n<html>\n<head>\n  <title>t</title>\n  <style>p { color: red; }</style>\n</head>\n<body><p>x</p></body>\n</html>',
    );
  });

  it('relの大文字小文字・複数指定でも一致する。ファイルを個別に選んだ場合は、hrefのフォルダ名が違っても一致する', async () => {
    const source = '<head><link REL="Stylesheet preload" href="css/style.css?v=1"></head><body></body>';
    expect(composeHtml(source, [CSS], await context(['style.css']), plain)).toBe('<head><style>p { color: red; }</style></head><body></body>');
  });

  it('フォルダごと取り込んだ場合は、hrefのパスのとおりに一致する(別のフォルダの同名ファイルとは区別する)', async () => {
    const a = css('css/style.css', 'a { color: red }');
    const b = css('other/style.css', 'b { color: blue }');
    const ctx = await context(['css/style.css', 'other/style.css'], { structured: true });
    const result = composeHtml('<head><link rel="stylesheet" href="other/style.css"></head>', [a, b], ctx, plain);
    // <link>が指している other/style.css は、その位置に。参照されていない css/style.css は、末尾に追加される
    expect(result).toBe('<head><style>b { color: blue }</style><style>a { color: red }</style></head>');
  });

  it('HTMLがサブフォルダにある場合は、そのフォルダを基準にhrefを解決する', async () => {
    const sheet = css('css/style.css', 'p { color: red; }');
    const ctx = await context(['css/style.css'], { structured: true, baseDir: 'pages' });
    expect(composeHtml('<head><link rel="stylesheet" href="../css/style.css"></head>', [sheet], ctx, plain)).toBe('<head><style>p { color: red; }</style></head>');
  });

  it('参照されていないCSSは、</head>の直前へ追加する', async () => {
    const source = '<head><title>t</title></head><body><p>x</p></body>';
    expect(composeHtml(source, [CSS], await context(['style.css']), plain)).toBe('<head><title>t</title><style>p { color: red; }</style></head><body><p>x</p></body>');
  });

  it('<link>が<body>内にある場合も、CSSは<head>の末尾へ追加し、<link>は残す', async () => {
    const source = '<head></head><body><link rel="stylesheet" href="style.css"><p>x</p></body>';
    expect(composeHtml(source, [CSS], await context(['style.css']), plain)).toBe(
      '<head><style>p { color: red; }</style></head><body><link rel="stylesheet" href="style.css"><p>x</p></body>',
    );
  });

  it('</head>が省略されていても、本文の前へ追加する', async () => {
    expect(composeHtml('<title>t</title><p>x</p>', [CSS], await context(['style.css']), plain)).toBe('<title>t</title><style>p { color: red; }</style><p>x</p>');
  });

  it('html/head/bodyが無い断片でも、先頭に追加して適用される', async () => {
    expect(composeHtml('<p>x</p>', [CSS], await context(['style.css']), plain)).toBe('<style>p { color: red; }</style><p>x</p>');
  });

  it('同じCSSを参照する<link>が複数あっても、埋め込むのは1回', async () => {
    const source = '<head><link rel=stylesheet href=style.css><link rel=stylesheet href=style.css></head>';
    expect(composeHtml(source, [CSS], await context(['style.css']), plain).match(/<style>/g)).toHaveLength(1);
  });

  it('CSSの中の</style は無害化される', async () => {
    const result = composeHtml('<head></head>', [css('a.css', '/* </style><script>x</script> */')], await context(['a.css']), plain);
    expect(result).not.toContain('</style><script>');
  });

  it('CSSが無ければ、ソースは変わらない', async () => {
    const source = '<!DOCTYPE html><title>t</title><p>x</p>';
    expect(composeHtml(source, [], await context([]), plain)).toBe(source);
  });
});

describe('composeHtml: 画像の埋め込み', () => {
  it('<img src>のファイル参照は、取り込んだ画像のdata: URIになる(他の属性・タグはそのまま)', async () => {
    const ctx = await context(['images/a.png'], { structured: true });
    const result = composeHtml('<p><img class="x" src="images/a.png" alt="図"></p>', [], ctx, plain);
    expect(result).toBe(`<p><img class="x" src="${PNG_URI}" alt="図"></p>`);
  });

  it('プレビュー用には、軽量なblob URLにし、元の値を残す印(data-mdp-orig-src)を付ける(data: URIは使わない)', async () => {
    const ctx = await context(['images/a.png'], { structured: true });
    const result = composeHtml('<img src="images/a.png">', [], ctx, preview);
    expect(result).toMatch(new RegExp(`<img src="blob:[^"]+" ${ORIGINAL_ATTRIBUTE_PREFIX}src="images/a.png">`));
    expect(result).not.toContain('data:image');
    // PDF用は、data: URI(印は付けない)
    expect(composeHtml('<img src="images/a.png">', [], ctx, plain)).toBe(`<img src="${PNG_URI}">`);
  });

  it('プレビュー用のCSSの url(…)・style属性も、blob URLにする', async () => {
    const ctx = await context(['a.png'], { structured: true });
    const result = composeHtml('<style>p{background:url(a.png)}</style><div style="background:url(a.png)"></div>', [], ctx, preview);
    expect(result).toMatch(/<style>p\{background:url\("blob:[^"]+"\)\}<\/style>/);
    expect(result).toMatch(new RegExp(`style="background:url\\(&quot;blob:[^"]*&quot;\\)" ${ORIGINAL_ATTRIBUTE_PREFIX}style="background:url\\(a.png\\)"`));
  });

  it('HTMLがサブフォルダにある場合は、そのフォルダを基準に画像を探す', async () => {
    const ctx = await context(['images/a.png'], { structured: true, baseDir: 'pages' });
    expect(composeHtml('<img src="../images/a.png">', [], ctx, plain)).toBe(`<img src="${PNG_URI}">`);
  });

  it('srcset・poster・style属性・<style>の url(…) も置き換える', async () => {
    const ctx = await context(['a.png', 'b.png'], { structured: true });
    const source = [
      '<img srcset="a.png 1x, b.png 2x, https://example.com/c.png 3x">',
      '<video poster="a.png"></video>',
      '<div style="background: url(a.png) no-repeat"></div>',
      "<style>p { background: url('b.png') }</style>",
    ].join('\n');
    const result = composeHtml(source, [], ctx, plain);
    expect(result).toContain(`srcset="${PNG_URI} 1x, ${PNG_URI} 2x, https://example.com/c.png 3x"`);
    expect(result).toContain(`<video poster="${PNG_URI}">`);
    expect(result).toContain(`style="background: url(&quot;${PNG_URI}&quot;) no-repeat"`);
    expect(result).toContain(`<style>p { background: url("${PNG_URI}") }</style>`);
  });

  it('取り込んだCSSの中の url(…) は、そのCSSのフォルダを基準に解決する', async () => {
    const sheet = css('css/style.css', 'body { background: url(../images/bg.png) }');
    const ctx = await context(['css/style.css', 'images/bg.png'], { structured: true });
    const result = composeHtml('<head><link rel="stylesheet" href="css/style.css"></head>', [sheet], ctx, plain);
    expect(result).toBe(`<head><style>body { background: url("${PNG_URI}") }</style></head>`);
  });

  it('外部の画像・見つからない画像・data:の画像・画像でないファイルは、そのまま', async () => {
    const ctx = await context(['a.png', 'style.css'], { structured: true });
    const source = '<img src="https://example.com/a.png"><img src="none.png"><img src="data:image/gif;base64,AAAA"><img src="style.css">';
    expect(composeHtml(source, [], ctx, plain)).toBe(source);
  });

  it('参照している画像のパスを返す(まだ読み込んでいなくても含む。外部・存在しないものは含まない)', () => {
    const assets = new AssetStore([file('a.png'), file('b.png')], true);
    const composed = composeDocument('<img src="a.png"><img src="https://x/y.png"><img src="none.png"><p style="background:url(b.png)">', [], { assets, baseDir: '' }, plain);
    expect([...composed.imagePaths].sort()).toEqual(['a.png', 'b.png']);
    // 読み込み前は、置き換えない
    expect(composed.html).toContain('src="a.png"');
  });
});

describe('composeHtml: プレビュー用の安全対策', () => {
  it('headの先頭に、外部通信を禁じるCSPを加える', async () => {
    const result = composeHtml('<!DOCTYPE html><html><head><title>t</title></head><body></body></html>', [], await context([]), preview);
    expect(result).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*"><title>t<\/title>/);
    expect(result.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('CSPは、CSSの<style>より前に置かれる', async () => {
    const result = composeHtml('<head></head>', [CSS], await context(['style.css']), preview);
    expect(result.indexOf('Content-Security-Policy')).toBeLessThan(result.indexOf('<style>'));
  });

  it.each([
    ['<p>x</p>', '<meta'],
    ['<html><p>x</p></html>', '<html><meta'],
    ['<!DOCTYPE html><p>x</p>', '<!DOCTYPE html><meta'],
  ])('headが省略された文書(%s)でも、doctypeの前には入らず、本文の前に入る', async (source, prefix) => {
    const result = composeHtml(source, [], await context([]), preview);
    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toContain('<p>x</p>');
  });

  it('headの中のメタリフレッシュは除く', async () => {
    const result = composeHtml('<head><meta http-equiv="refresh" content="0;url=https://example.com"><title>t</title></head>', [], await context([]), preview);
    expect(result).not.toContain('refresh');
    expect(result).toContain('<title>t</title>');
  });

  it('プレビュー用でなければ、CSPもメタリフレッシュの除去も行わない', async () => {
    const source = '<head><meta http-equiv="refresh" content="5"></head>';
    expect(composeHtml(source, [], await context([]), plain)).toBe(source);
  });
});
