import { describe, expect, it } from 'vitest';
import { imageTagsIn, parseImageTags } from './imageTag.js';

describe('parseImageTags', () => {
  it('エディタが書き出す形(大きさを変えた画像)を読む', () => {
    expect(parseImageTags('<img height="166" width="300" src="data:image/png;base64,AAAA" />')).toEqual([
      { src: 'data:image/png;base64,AAAA', alt: '', title: undefined, width: '300', height: '166' },
    ]);
  });

  it('src・alt・title・width・height を読む。引用符なし・シングルクォート・大文字のタグも読める', () => {
    expect(parseImageTags(`<IMG SRC='images/a.png' alt="図 1" title=説明 width=50%>`)).toEqual([
      { src: 'images/a.png', alt: '図 1', title: '説明', width: '50%', height: undefined },
    ]);
  });

  it('属性値の実体参照は文字に戻す', () => {
    expect(parseImageTags('<img src="a.png?x=1&amp;y=2" alt="A &amp; B">')?.[0]).toMatchObject({ src: 'a.png?x=1&y=2', alt: 'A & B' });
  });

  it('タグの間の空白・改行は許し、複数のタグを順に返す', () => {
    const tags = parseImageTags('<img src="a.png">\n  <img src="b.png" />\n');
    expect(tags?.map((tag) => tag.src)).toEqual(['a.png', 'b.png']);
  });

  it('大きさは、数字か「数字%」だけ使う。それ以外は無視する', () => {
    expect(parseImageTags('<img src="a.png" width="10.5" height="20%">')?.[0]).toMatchObject({ width: '10.5', height: '20%' });
    for (const bad of ['auto', '-5', '10px', '1e3', '', '100000', 'calc(1+1)']) {
      expect(parseImageTags(`<img src="a.png" width="${bad}">`)?.[0]?.width, bad).toBeUndefined();
    }
  });

  it('使わない属性(style・class・onerror・srcsetなど)は、無視する', () => {
    const tag = parseImageTags('<img src="a.png" style="width:1px" class="x" onerror="alert(1)" srcset="b.png 2x" loading="lazy">')?.[0];
    expect(tag).toEqual({ src: 'a.png', alt: '', title: undefined, width: undefined, height: undefined });
  });

  it('画像として読めないものは null(srcが無い・空、画像以外のタグ・文字・コメントが混ざる)', () => {
    for (const html of [
      '<img alt="x">',
      '<img src="">',
      '<img src="  ">',
      '<br>',
      '<p><img src="a.png"></p>',
      '<img src="a.png"> 文字',
      '文字',
      '<img src="a.png"><!-- メモ -->',
      '<img src="a.png"><script>alert(1)</script>',
      '<div>',
      '',
      '   ',
    ]) {
      expect(parseImageTags(html), html).toBeNull();
    }
  });

  it('巨大な属性値(数MBのdata URI)も読める', () => {
    const uri = `data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}`;
    expect(parseImageTags(`<img src="${uri}" width="10">`)?.[0]?.src).toHaveLength(uri.length);
  });
});

describe('imageTagsIn', () => {
  it('1行の中の、画像として読める<img>だけを、元の文字と一緒に返す', () => {
    const line = '前 <img src="a.png" width="10"> 中 <br> <img alt="srcなし"> 後 <img src="b.png">';
    const found = imageTagsIn(line);
    expect(found.map((entry) => entry.text)).toEqual(['<img src="a.png" width="10">', '<img src="b.png">']);
    expect(found.map((entry) => entry.tag.src)).toEqual(['a.png', 'b.png']);
  });

  it('<img>が無い行は空。<image> や <imgx> などは、対象外', () => {
    expect(imageTagsIn('文字だけ <b>太字</b>')).toEqual([]);
    expect(imageTagsIn('<image src="a.png">')).toEqual([]);
    expect(imageTagsIn('<imgx src="a.png">')).toEqual([]);
  });
});
