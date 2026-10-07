import { describe, expect, it } from 'vitest';
import { withImagePlaceholders, type ImageSizer } from './layoutPayload';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = `data:image/jpeg;base64,${'/9j/4AAQ'.repeat(1000)}`;
const sizes: Record<string, { width: number; height: number }> = { [PNG]: { width: 320, height: 160 }, [JPEG]: { width: 4000, height: 3000 } };
const sizer: ImageSizer = (uri) => Promise.resolve(sizes[uri] ?? null);
const decode = (uri: string): string => atob(uri.replace(/^data:image\/svg\+xml;base64,/, ''));

describe('withImagePlaceholders', () => {
  it('Markdownの中の画像(data: URI)を、同じ大きさの空のSVGに置き換え、サイズを小さくする', async () => {
    const result = await withImagePlaceholders(`# 題\n\n![図](${JPEG})\n\n本文`, {}, sizer);
    expect(result.markdown).not.toContain('/9j/');
    expect(result.markdown.length).toBeLessThan(500);
    const uri = /\((data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)\)/.exec(result.markdown)?.[1] ?? '';
    expect(decode(uri)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"/>');
    expect(result.markdown.startsWith('# 題\n\n![図](')).toBe(true);
    expect(result.markdown.endsWith(')\n\n本文')).toBe(true);
  });

  it('<img>のタグの中の画像も置き換える。同じ画像が複数あれば、すべて', async () => {
    const result = await withImagePlaceholders(`<img src="${PNG}" width="100"> と ![](${PNG})`, {}, sizer);
    expect(result.markdown).not.toContain('iVBOR');
    expect(result.markdown.match(/data:image\/svg\+xml;base64,/g)).toHaveLength(2);
    expect(result.markdown).toContain('width="100"');
  });

  it('取り込んだ画像(assets)の値も、置き換える', async () => {
    const result = await withImagePlaceholders('![](img/a.png)', { 'docs/img/a.png': PNG, 'docs/b.txt': 'テキスト' }, sizer);
    expect(decode(result.assets['docs/img/a.png'] ?? '')).toContain('width="320" height="160"');
    expect(result.assets['docs/b.txt']).toBe('テキスト');
    expect(result.markdown).toBe('![](img/a.png)');
  });

  it('大きさを読めない画像・画像でないdata: URIは、そのまま', async () => {
    const unknown = 'data:image/png;base64,AAAA';
    const result = await withImagePlaceholders(`![](${unknown}) data:text/plain;base64,AAAA`, { 'x.png': unknown }, sizer);
    expect(result.markdown).toBe(`![](${unknown}) data:text/plain;base64,AAAA`);
    expect(result.assets['x.png']).toBe(unknown);
  });

  it('画像が無ければ、何も変えない(大きさも調べない)', async () => {
    let called = false;
    const result = await withImagePlaceholders('# 本文だけ\n\n![外部](https://example.com/a.png)', {}, () => ((called = true), Promise.resolve(null)));
    expect(result.markdown).toBe('# 本文だけ\n\n![外部](https://example.com/a.png)');
    expect(called).toBe(false);
  });

  it('同じ画像の大きさは、1回だけ調べる', async () => {
    let calls = 0;
    await withImagePlaceholders(`![](${PNG}) ![](${PNG})`, { a: PNG }, (uri) => ((calls += 1), sizer(uri)));
    expect(calls).toBe(1);
  });
});
