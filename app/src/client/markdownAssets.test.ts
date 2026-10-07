import { describe, expect, it } from 'vitest';
import { AssetStore, type BundleFile } from './assets';
import { collectMarkdownAssets } from './markdownAssets';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // base64: iVBORw==
const file = (path: string): BundleFile => ({ path, file: { name: path, arrayBuffer: () => Promise.resolve(PNG) } });
const URI = 'data:image/png;base64,iVBORw==';

describe('collectMarkdownAssets', () => {
  it('Markdownが参照している画像だけを読み込み、書かれたパス(Markdownのフォルダ基準)をキーにして返す', async () => {
    const store = new AssetStore([file('docs/img/a.png'), file('docs/img/unused.png'), file('docs/guide.md')], true);
    const result = await collectMarkdownAssets('![図](img/a.png)\n\n![外部](https://example.com/x.png)\n![無い](img/none.png)', 'docs', store);
    expect(result).toEqual({ 'docs/img/a.png': URI });
    expect(store.dataUri('docs/img/unused.png')).toBeUndefined();
  });

  it('大きさを指定した画像(<img>のタグ)が指す、取り込んだ画像も読み込む', async () => {
    const store = new AssetStore([file('docs/img/a.png')], true);
    const result = await collectMarkdownAssets('本文<img src="img/a.png" width="300" height="166" />', 'docs', store);
    expect(result).toEqual({ 'docs/img/a.png': URI });
  });

  it('参照形式の定義・相対の書き方(../ や ./)も、解決したパスをキーにする', async () => {
    const store = new AssetStore([file('shared/b.png')], true);
    const result = await collectMarkdownAssets('![図][b]\n\n[b]: ../shared/b.png', 'docs', store);
    expect(result).toEqual({ 'shared/b.png': URI });
  });

  it('ファイルを個別に選んだ場合は、フォルダ名が違っても、ファイル名で見つけた画像を、書かれたパスのキーで返す', async () => {
    const store = new AssetStore([file('a.png')], false);
    expect(await collectMarkdownAssets('![図](images/a.png)', '', store)).toEqual({ 'images/a.png': URI });
  });

  it('画像でないファイルを指している参照は、含めない', async () => {
    const store = new AssetStore([file('notes.txt')], true);
    expect(await collectMarkdownAssets('![x](notes.txt)', '', store)).toEqual({});
  });

  it('画像が無ければ空', async () => {
    expect(await collectMarkdownAssets('# 本文だけ', '', new AssetStore([], true))).toEqual({});
  });
});
