import { describe, expect, it } from 'vitest';
import type { BundleFile } from './assets';
import type { HtmlDocument, MarkdownDocument } from './documents';
import { importBundle, type ImportOutcome } from './importFiles';

const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const file = (path: string, text = '内容'): BundleFile => ({ path, file: { name: path.split('/').pop() ?? path, arrayBuffer: () => Promise.resolve(encode(text)) } });
const badFile = (path: string): BundleFile => ({
  path,
  file: { name: path, arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xfe, 0x82, 0xa0]).buffer) },
});

const flat = (...files: BundleFile[]): Promise<ImportOutcome> => importBundle(files, { structured: false });
const folder = (files: BundleFile[], chosen?: string): Promise<ImportOutcome> =>
  importBundle(files, chosen === undefined ? { structured: true } : { structured: true, chosen });

async function html(outcome: Promise<ImportOutcome>): Promise<HtmlDocument> {
  const result = await outcome;
  if (result.kind !== 'document' || result.document.kind !== 'html') {
    throw new Error(`HTMLとして取り込めませんでした: ${JSON.stringify(result)}`);
  }
  return result.document;
}
async function markdown(outcome: Promise<ImportOutcome>): Promise<MarkdownDocument> {
  const result = await outcome;
  if (result.kind !== 'document' || result.document.kind !== 'markdown') {
    throw new Error(`Markdownとして取り込めませんでした: ${JSON.stringify(result)}`);
  }
  return result.document;
}
const errorOf = async (outcome: Promise<ImportOutcome>): Promise<string> => {
  const result = await outcome;
  return result.kind === 'error' ? result.message : `(エラーではない: ${result.kind})`;
};

describe('ファイルを個別に選んだ場合', () => {
  it.each(['manual.md', 'a.markdown', 'memo.txt', 'README'])('%s はMarkdownとして取り込む', async (name) => {
    const document = await markdown(flat(file(name, '# 見出し')));
    expect(document).toMatchObject({ kind: 'markdown', markdown: '# 見出し', sourceName: name, baseDir: '' });
  });

  it.each(['index.html', 'index.HTM', 'a.xhtml'])('%s はHTMLとして取り込む', async (name) => {
    const document = await html(flat(file(name, '<p>x</p>')));
    expect(document).toMatchObject({ kind: 'html', html: '<p>x</p>', stylesheets: [], sourceName: name, baseDir: '' });
  });

  it('HTMLと一緒に選んだCSSは、順序によらずHTMLに付く(<link>の参照が無くても付く)', async () => {
    const document = await html(flat(file('style.css', 'p{}'), file('index.html', '<p>x</p>'), file('print.CSS', 'a{}')));
    expect(document.stylesheets).toEqual([
      { path: 'style.css', outputPath: 'style.css', text: 'p{}' },
      { path: 'print.CSS', outputPath: 'print.CSS', text: 'a{}' },
    ]);
  });

  it('<link>が別のフォルダ名で参照していても、同じ名前のCSSが付き、保存する位置は<link>の指す位置になる', async () => {
    const document = await html(flat(file('style.css', 'p{}'), file('index.html', '<link rel="stylesheet" href="css/style.css">')));
    expect(document.stylesheets).toEqual([{ path: 'style.css', outputPath: 'css/style.css', text: 'p{}' }]);
    expect(document.assets.resolve('css/style.css', '')).toBe('style.css');
  });

  it('画像も一緒に選べる(画像は文書とみなさない)。画像は後から読み込める', async () => {
    const document = await markdown(flat(file('a.md', '![図](images/a.png)'), file('a.png', 'PNG')));
    expect(document.assets.resolve('images/a.png', '')).toBe('a.png');
    await document.assets.ensure(['a.png']);
    expect(document.assets.dataUri('a.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('空のCSSは取り込める(空のHTML・Markdownは取り込めない)', async () => {
    expect((await html(flat(file('a.html', '<p>x</p>'), file('empty.css', '')))).stylesheets).toHaveLength(1);
    expect(await errorOf(flat(file('a.html', ' \n')))).toBe('「a.html」は空のファイルです。');
    expect(await errorOf(flat(file('a.md', '')))).toContain('空のファイル');
  });

  it.each([
    ['CSSだけ', [file('style.css')], 'CSSファイルだけは取り込めません'],
    ['画像だけ', [file('a.png')], '画像だけは取り込めません'],
    ['Markdownと一緒のCSS', [file('a.md'), file('style.css')], 'HTMLファイルと一緒にのみ'],
    ['HTMLが2つ', [file('a.html'), file('b.html')], '1つずつ取り込んでください'],
    ['MarkdownとHTML', [file('a.md'), file('b.html')], '1つずつ取り込んでください'],
    ['同名のCSS(大文字小文字違い)', [file('a.html'), file('S.css'), file('s.CSS')], '同じ名前のCSS'],
    ['何も無い', [], 'ファイルがありません'],
    ['UTF-8でない文書', [badFile('a.html')], '「a.html」を読み込めませんでした。UTF-8'],
    ['UTF-8でないCSS', [file('a.html'), badFile('s.css')], '「s.css」を読み込めませんでした'],
  ])('%sは取り込まず、理由を示す', async (_label, files, message) => {
    expect(await errorOf(flat(...files))).toContain(message);
  });
});

describe('フォルダごと取り込んだ場合', () => {
  const site = [
    file('index.html', '<link rel="stylesheet" href="css/style.css"><img src="images/a.png">'),
    file('css/style.css', 'p{}'),
    file('css/unused.css', 'u{}'),
    file('images/a.png', 'PNG'),
    file('notes.pdf', 'x'),
    file('readme.txt', 'x'),
  ];

  it('文書が1つなら、そのまま開く。HTMLが参照しているCSSだけを取り込み、保存位置は参照どおり', async () => {
    const document = await html(folder(site));
    expect(document.sourceName).toBe('index.html');
    expect(document.baseDir).toBe('');
    expect(document.stylesheets).toEqual([{ path: 'css/style.css', outputPath: 'css/style.css', text: 'p{}' }]);
    // フォルダ構成が分かるため、画像はパスのとおりに解決される
    expect(document.assets.resolve('images/a.png', '')).toBe('images/a.png');
    expect(document.assets.resolve('a.png', '')).toBeUndefined();
  });

  it('フォルダの中にMarkdownが1つなら、Markdownとして開き、画像はそのフォルダを基準に解決する', async () => {
    const document = await markdown(folder([file('docs/guide.md', '![図](img/a.png)'), file('docs/img/a.png'), file('docs/style.css')]));
    expect(document).toMatchObject({ kind: 'markdown', sourceName: 'guide.md', baseDir: 'docs' });
    expect(document.assets.resolve('img/a.png', 'docs')).toBe('docs/img/a.png');
  });

  it('HTMLがサブフォルダにあるとき、CSSの保存位置はHTMLからの相対パス。HTMLのフォルダの外にあるCSSは、ファイル名だけ', async () => {
    const document = await html(
      folder([
        file('pages/index.html', '<link rel="stylesheet" href="local.css"><link rel="stylesheet" href="../shared/common.css">'),
        file('pages/local.css', 'a{}'),
        file('shared/common.css', 'b{}'),
      ]),
    );
    expect(document.baseDir).toBe('pages');
    expect(document.stylesheets.map((sheet) => [sheet.path, sheet.outputPath])).toEqual([
      ['pages/local.css', 'local.css'],
      ['shared/common.css', 'common.css'],
    ]);
  });

  it('文書が複数あるときは、候補を浅い階層から順に示し、選ばれた文書を開く', async () => {
    const files = [file('b.html', '<p>b</p>'), file('sub/a.md', '# a'), file('a.html', '<p>a</p>'), file('sub/deep/c.html', '<p>c</p>')];
    expect(await folder(files)).toEqual({ kind: 'choose', candidates: ['a.html', 'b.html', 'sub/a.md', 'sub/deep/c.html'] });
    expect((await html(folder(files, 'b.html'))).html).toBe('<p>b</p>');
    expect((await markdown(folder(files, 'sub/a.md'))).baseDir).toBe('sub');
  });

  it('文書が無い・選ばれた文書が無い場合は、理由を示す', async () => {
    expect(await errorOf(folder([file('a.png'), file('b.css')]))).toContain('見つかりません');
    expect(await errorOf(folder([file('a.html')], 'none.html'))).toContain('「none.html」は、取り込んだファイルの中にありません');
  });

  it('参照されているCSSが見つからなければ、取り込まない(HTMLは開く)', async () => {
    const document = await html(folder([file('index.html', '<link rel="stylesheet" href="missing.css">')]));
    expect(document.stylesheets).toEqual([]);
  });
});
