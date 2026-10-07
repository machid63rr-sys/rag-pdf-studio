import { describe, expect, it } from 'vitest';
import { candidateImageReferences, imageReferencesIn } from './markdownRefs';

describe('imageReferencesIn', () => {
  it.each([
    ['![図](images/a.png)', ['images/a.png']],
    ['![図](images/a.png "タイトル")', ['images/a.png']],
    ['![図](<my image/日本 図.png>)', ['my image/日本 図.png']],
    ['![a](x.png) と ![b](y.png)', ['x.png', 'y.png']],
    ['![](x.png)', ['x.png']],
    ['[リンク](x.png)', []],
    ['![図][id]', []],
    ['![図](  spaced.png  )', ['spaced.png']],
    // 画像の大きさを変えたとき、エディタが書き出す形
    ['<img src="images/a.png" width="300" height="166" />', ['images/a.png']],
    ['前 <img height="166" width="300" src="x.png" /> 後 ![b](y.png)', ['y.png', 'x.png']],
    ['<img alt="srcなし">', []],
    ['<br> と <b>太字</b>', []],
  ])('%s -> %j', (text, expected) => {
    expect(imageReferencesIn(text)).toEqual(expected);
  });
});

describe('candidateImageReferences', () => {
  it('大きさを指定した画像(<img>のタグ)の参照も拾う', () => {
    expect(candidateImageReferences('本文<img src="a.png" width="10" />\n\n<img src="dir/b.png">')).toEqual(['a.png', 'dir/b.png']);
  });

  it('画像の記法と、参照形式の定義を拾う(重複は1つにする)', () => {
    const markdown = ['![図1](a.png)', '', '![図2][b]', '', '![図3](a.png)', '', '[b]: images/b.png "題"', '[c]: <my dir/c.png>'].join('\n');
    expect(candidateImageReferences(markdown).sort()).toEqual(['a.png', 'images/b.png', 'my dir/c.png']);
  });

  it('コードフェンスの中・インラインコードの中の記法は拾わない', () => {
    const markdown = ['```', '![x](in-fence.png)', '[d]: in-fence2.png', '```', '', '`![x](inline.png)` と ![y](real.png)'].join('\n');
    expect(candidateImageReferences(markdown)).toEqual(['real.png']);
  });

  it('画像が無ければ空', () => {
    expect(candidateImageReferences('# 見出し\n\n本文')).toEqual([]);
  });
});
