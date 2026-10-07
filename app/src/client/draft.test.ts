import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SETTINGS, type PageSettings } from '../shared/pageSettings';
import { documentFromDraft, draftName, parseDraft, type Draft } from './draft';

const settings: PageSettings = { paper: 'B5', orientation: 'landscape', margin: 'wide', pageNumbers: false };

const markdownDraft: Draft = { version: 1, savedAt: 1_700_000_000_000, kind: 'markdown', sourceName: '説明書.md', baseDir: 'docs', markdown: '# 題\n\n本文', pageSettings: settings };
const htmlDraft: Draft = {
  version: 1,
  savedAt: 1_700_000_000_000,
  kind: 'html',
  sourceName: 'index.html',
  baseDir: '',
  html: '<link rel="stylesheet" href="css/style.css"><h1>題</h1>',
  stylesheets: [{ path: 'css/style.css', outputPath: 'css/style.css', text: 'h1 { color: red }' }],
  pageSettings: settings,
};

describe('parseDraft(保存先から読んだ値を、下書きにする)', () => {
  it('保存した形のMarkdown・HTMLの下書きは、そのまま読める', () => {
    expect(parseDraft(markdownDraft)).toEqual(markdownDraft);
    expect(parseDraft(htmlDraft)).toEqual(htmlDraft);
  });

  it('貼り付けた文書(ファイル名なし)も読める', () => {
    expect(parseDraft({ ...markdownDraft, sourceName: null })).toEqual({ ...markdownDraft, sourceName: null });
  });

  it('ページ設定が壊れている・無いときだけ、既定のページ設定にする(文書の内容は、そのまま読む)', () => {
    expect(parseDraft({ ...markdownDraft, pageSettings: { paper: 'A9' } })).toEqual({ ...markdownDraft, pageSettings: DEFAULT_PAGE_SETTINGS });
    const { pageSettings: _omitted, ...withoutSettings } = markdownDraft;
    expect(parseDraft(withoutSettings)?.pageSettings).toEqual(DEFAULT_PAGE_SETTINGS);
  });

  it('余計な項目は、捨てる', () => {
    expect(parseDraft({ ...markdownDraft, extra: 'x' })).toEqual(markdownDraft);
  });

  it.each([
    ['null', null],
    ['文字列', 'draft'],
    ['空', {}],
    ['読めない版', { ...markdownDraft, version: 2 }],
    ['版が無い', { ...markdownDraft, version: undefined }],
    ['種類が不明', { ...markdownDraft, kind: 'text' }],
    ['Markdownが文字列でない', { ...markdownDraft, markdown: 1 }],
    ['HTMLが文字列でない', { ...htmlDraft, html: null }],
    ['CSSの一覧が無い', { ...htmlDraft, stylesheets: undefined }],
    ['CSSの項目が足りない', { ...htmlDraft, stylesheets: [{ path: 'a.css', text: '' }] }],
    ['ファイル名が文字列でもnullでもない', { ...markdownDraft, sourceName: 1 }],
    ['baseDirが無い', { ...markdownDraft, baseDir: undefined }],
    ['保存日時が数でない', { ...markdownDraft, savedAt: '昨日' }],
  ])('読めない下書き(%s)は null', (_label, value) => {
    expect(parseDraft(value)).toBeNull();
  });
});

describe('documentFromDraft(下書きから、編集できる文書を作る)', () => {
  it('Markdown: 内容・ファイル名・フォルダ・ページ設定が戻り、「復元した文書」になる。画像のファイルは無い', () => {
    const document = documentFromDraft(markdownDraft);
    expect(document).toMatchObject({ kind: 'markdown', markdown: '# 題\n\n本文', sourceName: '説明書.md', baseDir: 'docs', restored: true, pageSettings: settings });
    expect(document.assets.files).toEqual([]);
  });

  it('HTML: HTML・CSS・ページ設定が戻る。<link> が指すCSSを、取り込んだときと同じように見つけられる', () => {
    const document = documentFromDraft(htmlDraft);
    expect(document).toMatchObject({ kind: 'html', html: htmlDraft.kind === 'html' ? htmlDraft.html : '', restored: true, pageSettings: settings });
    if (document.kind !== 'html') {
      throw new Error('HTMLの文書になるはず');
    }
    expect(document.stylesheets).toEqual([{ path: 'css/style.css', outputPath: 'css/style.css', text: 'h1 { color: red }' }]);
    // <link href="css/style.css"> が、取り込んだ(復元した)CSSのパスに解決される
    expect(document.assets.resolve('css/style.css', '')).toBe('css/style.css');
  });

  it('HTML: フォルダ構成が分からない取り込み(CSSのパスがファイル名だけ)でも、ファイル名で<link>と対応づく', () => {
    const draft: Draft = { ...htmlDraft, stylesheets: [{ path: 'style.css', outputPath: 'css/style.css', text: 'p {}' }] } as Draft;
    const document = documentFromDraft(draft);
    expect(document.assets.resolve('css/style.css', '')).toBe('style.css');
  });

  it('復元したCSSのファイルを読むと、編集中の内容(文字列)が得られる', async () => {
    const document = documentFromDraft(htmlDraft);
    await document.assets.ensure(['css/style.css']);
    // CSSは画像ではないため、画像として読み込まれない(取り込んだときと同じ)。ファイルの中身は、文字列として入っている
    const file = document.assets.files.find((entry) => entry.path === 'css/style.css');
    expect(new TextDecoder().decode(await file?.file.arrayBuffer())).toBe('h1 { color: red }');
  });
});

describe('draftName', () => {
  it('ファイル名があれば、ファイル名。貼り付けた文書は、種類', () => {
    expect(draftName(markdownDraft)).toBe('説明書.md');
    expect(draftName({ ...markdownDraft, sourceName: null })).toBe('貼り付けたMarkdown');
    expect(draftName({ ...htmlDraft, sourceName: null } as Draft)).toBe('貼り付けたHTML');
  });
});
