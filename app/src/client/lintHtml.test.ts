import { describe, expect, it } from 'vitest';
import { AssetStore, type BundleFile } from './assets';
import type { Stylesheet } from './documents';
import type { ComposeContext } from './htmlCompose';
import { lintHtml } from './lintHtml';

const file = (path: string): BundleFile => ({ path, file: { name: path, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) } });
const css = (path: string, text = 'p { color: red; }'): Stylesheet => ({ path, outputPath: path, text });
const context = (paths: string[] = [], options: { structured?: boolean; baseDir?: string } = {}): ComposeContext => ({
  assets: new AssetStore(paths.map(file), options.structured ?? true),
  baseDir: options.baseDir ?? '',
});

const CSS = css('style.css');
const codes = (html: string, sheets: Stylesheet[] = [CSS], ctx = context(['style.css'])): string[] => lintHtml(html, sheets, ctx).map((warning) => warning.code);
const lines = (html: string, code: string, sheets: Stylesheet[] = [CSS], ctx = context(['style.css'])): readonly number[] | undefined =>
  lintHtml(html, sheets, ctx).find((warning) => warning.code === code)?.lines;

describe('lintHtml', () => {
  it('問題が無ければ警告なし', () => {
    const html = '<head><link rel="stylesheet" href="style.css"></head><body><p>x</p><img src="data:image/png;base64,AAAA"></body>';
    expect(lintHtml(html, [CSS], context(['style.css']))).toEqual([]);
  });

  it('スクリプトとイベント属性は、実行されない旨を行番号つきで警告する', () => {
    expect(lines('<p>a</p>\n<script>alert(1)</script>\n<button onclick="x()">b</button>', 'script', [], context())).toEqual([2, 3]);
  });

  it('<noscript>の内容は表示される旨を警告する', () => {
    expect(codes('<noscript>JavaScriptを有効にしてください</noscript>', [], context())).toContain('noscript');
  });

  it('取り込んでいないCSSを参照する<link>を警告する(取り込んだCSSの<link>は警告しない)', () => {
    const html = '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="https://cdn.example.com/x.css">\n<link rel="stylesheet" href="other.css">';
    expect(lines(html, 'stylesheet-missing')).toEqual([2, 3]);
  });

  describe('画像', () => {
    const ctx = context(['images/a.png', 'fonts/f.woff2', 'style.css'], { structured: true });

    it('取り込んだ画像・data URI・#だけの参照は警告しない', () => {
      const html = '<img src="images/a.png">\n<img src="data:image/png;base64,AAAA">\n<img srcset="images/a.png 1x">\n<video poster="images/a.png"></video>';
      expect(lintHtml(html, [], ctx)).toEqual([]);
    });

    it('外部のURLは「外部」、取り込んだ中に無いものは「見つからない」として、区別して警告する', () => {
      const html = ['<img src="https://example.com/a.png">', '<img src="images/none.png">', '<img srcset="images/a.png 1x, //cdn.example.com/b.png 2x">', '<video poster="images/none.png"></video>'].join('\n');
      expect(lines(html, 'external-resource', [], ctx)).toEqual([1, 3]);
      expect(lines(html, 'missing-resource', [], ctx)).toEqual([2, 4]);
    });

    it('取り込んだ中にあっても、画像でないもの(画像のsrcがCSS・音声・別のHTML)は「表示されない」と警告する', () => {
      const html = '<img src="style.css">\n<audio src="images/a.png"></audio>\n<iframe src="images/a.png"></iframe>';
      expect(lines(html, 'unsupported-resource', [], ctx)).toEqual([1, 2, 3]);
    });

    it('HTMLがサブフォルダにある場合は、そのフォルダを基準に判定する', () => {
      const sub = context(['images/a.png'], { structured: true, baseDir: 'pages' });
      expect(lintHtml('<img src="../images/a.png"><img src="images/a.png">', [], sub).map((w) => [w.code, w.lines])).toEqual([['missing-resource', [1]]]);
    });
  });

  it('<style>・style属性・CSSファイル内の url(…) と @import を、種類ごとに警告する', () => {
    const ctx = context(['a.png', 'fonts/f.woff2'], { structured: true });
    const html = '<style>\nbody { background: url(a.png); }\nh1 { background: url(none.png) }\n</style>\n<p style="background:url(\'https://x/y.png\')">a</p>';
    expect(lines(html, 'missing-resource', [], ctx)).toEqual([3]);
    expect(lines(html, 'external-resource', [], ctx)).toEqual([5]);

    const sheet = css('style.css', '@import "base.css";\n.a { background: url(a.png) }\n.b { font-src: url(fonts/f.woff2) }\n.c { background: url(https://x/c.png) }');
    const result = lintHtml('<link rel="stylesheet" href="style.css">', [sheet], ctx);
    expect(result.find((w) => w.code === 'css-import')).toBeUndefined(); // CSSファイル内の@importは、CSS側の警告として出る
    expect(result.find((w) => w.code === 'import:style.css')?.lines).toEqual([1]);
    expect(result.find((w) => w.code === 'unsupported:style.css')?.lines).toEqual([3]);
    expect(result.find((w) => w.code === 'external:style.css')?.lines).toEqual([4]);
    expect(result.find((w) => w.code === 'external:style.css')?.message).toContain('style.css');
  });

  it('CSSファイルの中の url(…) は、そのCSSのフォルダを基準に判定する', () => {
    const ctx = context(['css/style.css', 'images/bg.png'], { structured: true });
    const sheet = css('css/style.css', 'body { background: url(../images/bg.png) } p { background: url(images/bg.png) }');
    const warnings = lintHtml('<link rel="stylesheet" href="css/style.css">', [sheet], ctx);
    expect(warnings.map((w) => [w.code, w.lines])).toEqual([['missing:css/style.css', [1]]]);
  });

  it('どの<link>にも参照されていないCSSは、追加して適用する旨を知らせる', () => {
    const result = lintHtml('<p>x</p>', [CSS], context(['style.css']));
    expect(result.map((warning) => warning.code)).toEqual(['unreferenced-stylesheet:style.css']);
    expect(result[0]?.message).toContain('<head>の末尾に追加して適用');
  });
});
