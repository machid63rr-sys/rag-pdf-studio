import { describe, expect, it } from 'vitest';
import { AssetStore, imageMimeOf, type BundleFile } from './assets';

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
const file = (path: string, content: ArrayBuffer = bytes(1, 2, 3)): BundleFile => ({
  path,
  file: { name: path.split('/').pop() ?? path, arrayBuffer: () => Promise.resolve(content) },
});

describe('imageMimeOf', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a/b.JPG', 'image/jpeg'],
    ['x.jpeg', 'image/jpeg'],
    ['x.gif', 'image/gif'],
    ['x.webp', 'image/webp'],
    ['x.SVG', 'image/svg+xml'],
    ['x.bmp', undefined],
    ['x.css', undefined],
    ['png', undefined],
  ])('%s -> %s', (path, expected) => {
    expect(imageMimeOf(path)).toBe(expected);
  });
});

describe('AssetStore.resolve(フォルダごと取り込んだ場合)', () => {
  const store = new AssetStore([file('index.html'), file('images/a.png'), file('css/style.css'), file('pages/p.html'), file('Photos/B.JPG')], true);

  it('参照を、書かれたファイルのフォルダを基準に解決する', () => {
    expect(store.resolve('images/a.png', '')).toBe('images/a.png');
    expect(store.resolve('../images/a.png', 'pages')).toBe('images/a.png');
    expect(store.resolve('/images/a.png', 'pages')).toBe('images/a.png');
    expect(store.resolve('./a.png?v=1', 'images')).toBe('images/a.png');
  });

  it('フォルダ構成が分かるときは、別の場所にある同名のファイルを使わない', () => {
    expect(store.resolve('other/a.png', '')).toBeUndefined();
    expect(store.resolve('a.png', '')).toBeUndefined();
  });

  it('大文字小文字の違いは、一意に決まる場合だけ許す', () => {
    expect(store.resolve('photos/b.jpg', '')).toBe('Photos/B.JPG');
    const ambiguous = new AssetStore([file('a.png'), file('A.PNG')], true);
    expect(ambiguous.resolve('a.png', '')).toBe('a.png'); // 完全一致が優先
    expect(ambiguous.resolve('a.Png', '')).toBeUndefined();
  });

  it('外部・data・ルートの外・存在しない参照は解決できない', () => {
    expect(store.resolve('https://example.com/a.png', '')).toBeUndefined();
    expect(store.resolve('data:image/png;base64,AAAA', '')).toBeUndefined();
    expect(store.resolve('../a.png', '')).toBeUndefined();
    expect(store.resolve('images/none.png', '')).toBeUndefined();
  });
});

describe('AssetStore.resolve(ファイルを個別に選んだ場合)', () => {
  const store = new AssetStore([file('index.html'), file('a.png'), file('style.css'), file('b.png'), file('B.png')], false);

  it('フォルダ構成が分からないため、同じファイル名が1つだけなら、フォルダ名が違っても使う', () => {
    expect(store.resolve('images/a.png', '')).toBe('a.png');
    expect(store.resolve('../css/STYLE.css', 'pages')).toBe('style.css');
  });

  it('同じファイル名が複数あって決められない場合は、解決しない', () => {
    expect(store.resolve('x/b.png', '')).toBeUndefined();
  });
});

describe('AssetStore.ensure / dataUri', () => {
  it('画像を data: URI として読み込む(読み込むまでは undefined)', async () => {
    const store = new AssetStore([file('a.png', bytes(0x89, 0x50, 0x4e, 0x47))], true);
    expect(store.dataUri('a.png')).toBeUndefined();
    await store.ensure(['a.png']);
    expect(store.dataUri('a.png')).toBe('data:image/png;base64,iVBORw==');
    expect(store.loadedCount).toBe(1);
  });

  it('プレビュー用には、blob URLを返す(同じ画像は同じURL。読み込むまでは undefined)', async () => {
    const store = new AssetStore([file('a.png')], true);
    expect(store.previewUrl('a.png')).toBeUndefined();
    await store.ensure(['a.png']);
    const url = store.previewUrl('a.png');
    expect(url).toMatch(/^blob:/);
    expect(store.previewUrl('a.png')).toBe(url);
  });

  it('同じファイルは1回しか読み込まない', async () => {
    let reads = 0;
    const store = new AssetStore([{ path: 'a.png', file: { name: 'a.png', arrayBuffer: () => (reads += 1, Promise.resolve(bytes(1))) } }], true);
    await Promise.all([store.ensure(['a.png']), store.ensure(['a.png', 'a.png'])]);
    await store.ensure(['a.png']);
    expect(reads).toBe(1);
  });

  it('画像でないファイル・存在しないパス・読み込みに失敗した画像は、何も読み込まず、例外にもしない', async () => {
    const failing: BundleFile = { path: 'bad.png', file: { name: 'bad.png', arrayBuffer: () => Promise.reject(new Error('読めない')) } };
    const store = new AssetStore([file('style.css'), failing], true);
    await expect(store.ensure(['style.css', 'none.png', 'bad.png'])).resolves.toBeUndefined();
    expect(store.loadedCount).toBe(0);
  });

  it('大きな画像(引数の上限を超えるサイズ)も data: URI にできる', async () => {
    const big = new Uint8Array(300_000).fill(7).buffer;
    const store = new AssetStore([file('big.png', big)], true);
    await store.ensure(['big.png']);
    const uri = store.dataUri('big.png') ?? '';
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(atob(uri.slice('data:image/png;base64,'.length)).length).toBe(300_000);
  });
});
