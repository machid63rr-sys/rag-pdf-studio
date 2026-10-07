import { describe, expect, it } from 'vitest';
import {
  MAX_EMBED_BYTES,
  altTextOf,
  cssImage,
  embedProblemOf,
  embeddableMime,
  htmlImage,
  insertSnippet,
  markdownImage,
  readImages,
  snippetOf,
  summarize,
  type EmbedFile,
  type EmbeddedImage,
} from './embedImage';

const file = (name: string, type: string, bytes: number[] | number = [1, 2, 3]): EmbedFile => {
  const data = typeof bytes === 'number' ? new Uint8Array(0) : new Uint8Array(bytes);
  return {
    name,
    type,
    size: typeof bytes === 'number' ? bytes : data.length,
    arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer),
  };
};

const image = (alt: string, uri = 'data:image/png;base64,AAAA'): EmbeddedImage => ({ name: `${alt}.png`, alt, uri });

describe('embeddableMime', () => {
  it('PNG・JPEG・GIF・WebP・SVGの種類を、そのまま返す', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
      expect(embeddableMime({ name: 'a', type })).toBe(type);
    }
  });

  it('種類が不明(空)なら、拡張子で判断する', () => {
    expect(embeddableMime({ name: 'a.PNG', type: '' })).toBe('image/png');
    expect(embeddableMime({ name: 'a.jpg', type: '' })).toBe('image/jpeg');
    expect(embeddableMime({ name: 'a.txt', type: '' })).toBeUndefined();
  });

  it('対応していない種類は、拡張子が画像でも、使わない', () => {
    expect(embeddableMime({ name: 'a.png', type: 'text/plain' })).toBeUndefined();
    expect(embeddableMime({ name: 'a.bmp', type: 'image/bmp' })).toBeUndefined();
    expect(embeddableMime({ name: 'a.pdf', type: 'application/pdf' })).toBeUndefined();
  });
});

describe('embedProblemOf', () => {
  it('埋め込めるファイルは undefined', () => {
    expect(embedProblemOf({ name: 'a.png', type: 'image/png', size: 100 })).toBeUndefined();
    expect(embedProblemOf({ name: 'a.png', type: 'image/png', size: MAX_EMBED_BYTES })).toBeUndefined();
  });

  it('画像でないファイルは、対応する形式を添えて理由にする', () => {
    expect(embedProblemOf({ name: 'memo.pdf', type: 'application/pdf', size: 1 })).toBe(
      '「memo.pdf」は画像として埋め込めません(対応: PNG・JPEG・GIF・WebP・SVG)',
    );
  });

  it('大きすぎるファイルは、大きさと上限を理由にする', () => {
    expect(embedProblemOf({ name: 'big.png', type: 'image/png', size: MAX_EMBED_BYTES + 1 })).toBe(
      '「big.png」は大きすぎるため埋め込めません(10.0MB。上限 10.0MB)',
    );
    expect(embedProblemOf({ name: 'big.png', type: 'image/png', size: 25 * 1024 * 1024 })).toContain('25.0MB');
  });
});

describe('altTextOf', () => {
  it('拡張子を除く。Markdownの記号になる文字・改行は、空白にする', () => {
    expect(altTextOf('図1.png')).toBe('図1');
    expect(altTextOf('a.b.PNG')).toBe('a.b');
    expect(altTextOf('x[1].png')).toBe('x 1');
    expect(altTextOf('a\\b.png')).toBe('a b');
    expect(altTextOf('image.png')).toBe('image');
    expect(altTextOf('.png')).toBe('');
  });
});

describe('readImages', () => {
  it('画像を data: URI(base64)にする', async () => {
    const result = await readImages([file('a.png', 'image/png', [137, 80, 78, 71])]);
    expect(result.problems).toEqual([]);
    expect(result.images).toEqual([{ name: 'a.png', alt: 'a', uri: 'data:image/png;base64,iVBORw==' }]);
  });

  it('SVG・種類が空のファイルも読める', async () => {
    const result = await readImages([file('s.svg', 'image/svg+xml', [60, 115, 118, 103, 62]), file('p.jpg', '', [255, 216])]);
    expect(result.images.map((entry) => entry.uri)).toEqual(['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,/9g=']);
  });

  it('埋め込めないファイルは、理由を返し、ほかのファイルは読み込む(元の順序のまま)', async () => {
    const result = await readImages([file('a.png', 'image/png'), file('b.txt', 'text/plain'), file('big.png', 'image/png', MAX_EMBED_BYTES + 1), file('c.gif', 'image/gif')]);
    expect(result.images.map((entry) => entry.name)).toEqual(['a.png', 'c.gif']);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain('「b.txt」');
    expect(result.problems[1]).toContain('「big.png」');
  });

  it('大きすぎるファイルは、中身を読み込まない', async () => {
    let read = false;
    const big: EmbedFile = { name: 'big.png', type: 'image/png', size: MAX_EMBED_BYTES + 1, arrayBuffer: () => ((read = true), Promise.resolve(new ArrayBuffer(0))) };
    await readImages([big]);
    expect(read).toBe(false);
  });

  it('読み込みに失敗したファイルは、理由を返す', async () => {
    const broken: EmbedFile = { name: 'a.png', type: 'image/png', size: 1, arrayBuffer: () => Promise.reject(new Error('x')) };
    expect((await readImages([broken])).problems).toEqual(['「a.png」を読み込めませんでした']);
  });

  it('大きなファイル(数MB)も、桁あふれせずに変換できる', async () => {
    const size = 3 * 1024 * 1024;
    const result = await readImages([file('big.png', 'image/png', Array.from({ length: size }, (_, index) => index % 256))]);
    const uri = result.images[0]?.uri ?? '';
    expect(uri.startsWith('data:image/png;base64,AAECAwQ')).toBe(true);
    expect(uri.length).toBe('data:image/png;base64,'.length + Math.ceil(size / 3) * 4);
  });
});

describe('summarize', () => {
  it('何も無ければ null', () => {
    expect(summarize({ images: [], problems: [] })).toBeNull();
  });

  it('成功は、ファイル名と、文書に加わるデータの大きさを伝える', () => {
    const notice = summarize({ images: [image('a', `data:image/png;base64,${'A'.repeat(2048)}`)], problems: [] });
    expect(notice?.kind).toBe('info');
    expect(notice?.text).toContain('画像「a.png」を埋め込みました');
    expect(notice?.text).toContain('約2KB');
  });

  it('MB単位の大きさも伝える。複数のファイル名を並べる', () => {
    const notice = summarize({ images: [image('a', `data:x;base64,${'A'.repeat(600_000)}`), image('b', `data:x;base64,${'A'.repeat(600_000)}`)], problems: [] });
    expect(notice?.text).toContain('「a.png」「b.png」');
    expect(notice?.text).toContain('約1.1MB');
  });

  it('埋め込めなかったファイルがあれば、警告にして、理由を伝える(成功したものも伝える)', () => {
    const failed = summarize({ images: [], problems: ['「b.txt」は画像として埋め込めません(対応: PNG)'] });
    expect(failed).toEqual({ kind: 'error', text: '「b.txt」は画像として埋め込めません(対応: PNG)。' });
    const partial = summarize({ images: [image('a')], problems: ['「b.txt」は画像として埋め込めません'] });
    expect(partial?.kind).toBe('error');
    expect(partial?.text).toContain('「a.png」を埋め込みました');
    expect(partial?.text).toContain('「b.txt」は画像として埋め込めません。');
  });
});

describe('挿入する文字', () => {
  const sample = image('図1', 'data:image/png;base64,AAAA');

  it('Markdown・HTML・CSSの書き方にする', () => {
    expect(markdownImage(sample)).toBe('![図1](data:image/png;base64,AAAA)');
    expect(htmlImage(sample)).toBe('<img src="data:image/png;base64,AAAA" alt="図1">');
    expect(cssImage(sample)).toBe('url("data:image/png;base64,AAAA")');
  });

  it('HTMLのaltは、属性を壊す文字を、エスケープする', () => {
    expect(htmlImage({ ...sample, alt: 'a"b<c>&d' })).toContain('alt="a&quot;b&lt;c&gt;&amp;d"');
  });

  it('複数の画像: Markdownは空行で区切り、HTMLは改行、CSSはカンマで区切る', () => {
    const two = [image('a'), image('b')];
    expect(snippetOf('markdown', two)).toBe('![a](data:image/png;base64,AAAA)\n\n![b](data:image/png;base64,AAAA)');
    expect(snippetOf('html', two)).toBe('<img src="data:image/png;base64,AAAA" alt="a">\n<img src="data:image/png;base64,AAAA" alt="b">');
    expect(snippetOf('css', two)).toBe('url("data:image/png;base64,AAAA"), url("data:image/png;base64,AAAA")');
  });
});

describe('insertSnippet', () => {
  it('カーソル位置に挿入し、挿入した文字の直後にカーソルを置く', () => {
    expect(insertSnippet('abcd', 2, 2, 'XY', false)).toEqual({ value: 'abXYcd', caret: 4 });
    expect(insertSnippet('', 0, 0, 'XY', false)).toEqual({ value: 'XY', caret: 2 });
  });

  it('範囲を選択していれば、その範囲を置き換える', () => {
    expect(insertSnippet('abcd', 1, 3, 'X', false)).toEqual({ value: 'aXd', caret: 2 });
  });

  describe('段落として挿入する(Markdown)。前後を空行で区切り、行の途中でも段落を壊さない', () => {
    const block = (value: string, start: number, end = start) => insertSnippet(value, start, end, 'S', true);

    it('空の文書では、そのまま挿入する', () => {
      expect(block('', 0)).toEqual({ value: 'S', caret: 1 });
    });

    it('空行の直後(行頭)では、前に空行を足さない。後ろに文字があれば、空行を足す', () => {
      expect(block('a\n\nb', 3)).toEqual({ value: 'a\n\nS\n\nb', caret: 4 });
    });

    it('文書の末尾では、前に空行を足し、後ろには何も足さない', () => {
      expect(block('abc', 3)).toEqual({ value: 'abc\n\nS', caret: 6 });
    });

    it('改行の直後では、空行になるよう、改行を1つだけ足す', () => {
      expect(block('ab\ncd', 3)).toEqual({ value: 'ab\n\nS\n\ncd', caret: 5 });
    });

    it('行の途中では、前後を空行で区切る', () => {
      expect(block('hello world', 5)).toEqual({ value: 'hello\n\nS\n\n world', caret: 8 });
    });

    it('選択範囲を置き換える場合も、前後を空行で区切る', () => {
      expect(block('abc XXX def', 4, 7)).toEqual({ value: 'abc \n\nS\n\n def', caret: 7 });
    });
  });
});
