import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DiagramOutcome } from '../shared/mermaid.js';
import { buildDocumentHtml, extractMermaidSources, renderMarkdown, type DiagramMap, type MarkdownAssets } from './markdownToHtml.js';

const body = (markdown: string): string => renderMarkdown(markdown).bodyHtml;

describe('renderMarkdown', () => {
  it('GFMの表をtable要素にする', () => {
    const html = body('| 項目 | 説明 |\n| --- | --- |\n| A | 最初 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>項目</th>');
    expect(html).toContain('<td>最初</td>');
  });

  it('見出し・強調・コードを変換する', () => {
    const html = body('# 見出し\n\n**太字** と `code`\n\n```python\nprint(1)\n```');
    expect(html).toContain('<h1>見出し</h1>');
    expect(html).toContain('<strong>太字</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<pre><code class="hljs language-python">');
  });

  it('山括弧で囲まれた日本語(エラー一覧表など)は文字として残る', () => {
    expect(body('画面に <エラー一覧表> と出ます')).toContain('&#x3C;エラー一覧表>');
  });

  it('段落内の改行は改行(br)になる', () => {
    expect(body('1行目\n2行目')).toContain('1行目<br>\n2行目');
  });

  describe('生HTML', () => {
    it('scriptやイベント属性は実行されず、文字として表示される', () => {
      const html = body('<script>alert(1)</script>\n\n文中の <img src=x onerror=alert(1)> です');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('onerror');
      expect(html).toContain('&#x3C;script>alert(1)&#x3C;/script>');
      // <img> のタグは画像として扱い、onerror などの属性は捨てる。表示できない画像(src=x)は、文字になる
      expect(html).toContain('[画像: ](x)');
    });

    it('表セル内の<br>も黙って消さず、文字として表示する', () => {
      expect(body('| a |\n| - |\n| 1<br>2 |')).toContain('1&#x3C;br>2');
    });

    it('複数行のHTMLブロックは改行を保つ', () => {
      const html = body('<div>\n本文\n</div>');
      expect(html).toContain('&#x3C;div>');
      expect(html).toContain('<br>');
      expect(html).toContain('&#x3C;/div>');
    });
  });

  describe('front matter', () => {
    it('YAMLコードブロックとして内容を残す', () => {
      const html = body('---\ntitle: T\ntags: [a, b]\n---\n\n本文');
      expect(html).toContain('<pre><code class="hljs language-yaml">');
      expect(html).toContain('<span class="hljs-attr">title:</span> <span class="hljs-string">T</span>');
      expect(html).toContain('<p>本文</p>');
    });
  });

  describe('リンク', () => {
    it('http/https/mailto/相対/フラグメントはリンクのまま', () => {
      const html = body('[a](https://example.com) [b](mailto:x@example.com) [c](./rel.md) [d](#sec)');
      expect(html).toContain('<a href="https://example.com">a</a>');
      expect(html).toContain('<a href="mailto:x@example.com">b</a>');
      expect(html).toContain('<a href="./rel.md">c</a>');
      expect(html).toContain('<a href="#sec">d</a>');
    });

    it('javascript:等はリンクにせず「文字 (URL)」にする', () => {
      const html = body('[クリック](javascript:alert(1))');
      expect(html).not.toContain('href');
      expect(html).toContain('クリック');
      expect(html).toContain('(javascript:alert(1))');
    });

    it('参照形式で定義された危険なURLも同様に無効化する', () => {
      const html = body('[x][ref]\n\n[ref]: javascript:alert(1)');
      expect(html).not.toContain('href');
      expect(html).toContain('(javascript:alert(1))');
    });
  });

  describe('画像', () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('data URI(png)は画像として表示する', () => {
      expect(body(`![点](${dataUri})`)).toContain(`<img src="${dataUri}" alt="点">`);
    });

    it('外部URLの画像は、読み込まず「[画像: 代替文](URL)」の文字にする', () => {
      const html = body('![外部](https://example.com/a.png)');
      expect(html).not.toContain('<img');
      expect(html).toContain('[画像: 外部](https://example.com/a.png)');
    });

    it('svgのdata URIも画像として表示する(<img>の中では、スクリプトの実行も外部の読み込みも行われない)', () => {
      const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
      expect(body(`![s](${svg})`)).toContain(`<img src="${svg}" alt="s">`);
    });

    it('画像として許可していない種類・形のdata URIは、文字にする', () => {
      for (const src of ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;utf8,AAA', 'data:application/pdf;base64,AAAA']) {
        const html = body(`![x](${src})`);
        expect(html).not.toContain('<img');
        expect(html).toContain('[画像: x](');
      }
    });

    describe('取り込んだ画像(assets)', () => {
      const assets: MarkdownAssets = { baseDir: 'docs', files: { 'docs/img/a.png': dataUri, 'shared/b.png': dataUri } };
      const render = (markdown: string, given: MarkdownAssets = assets): string => renderMarkdown(markdown, given).bodyHtml;

      it('Markdownのフォルダを基準にした相対パスの画像を、渡された画像で表示する(元のパスは変わらず、src だけが置き換わる)', () => {
        expect(render('![図](img/a.png)')).toContain(`<img src="${dataUri}" alt="図">`);
        expect(render('![図](./img/a.png?v=2)')).toContain(`<img src="${dataUri}"`);
        expect(render('![図](../shared/b.png)')).toContain(`<img src="${dataUri}"`);
        expect(render('![図](/shared/b.png)')).toContain(`<img src="${dataUri}"`);
      });

      it('参照形式・空白を含むパス・パーセントエンコードされたパスの画像も表示する', () => {
        const files = { 'docs/my img/日本.png': dataUri };
        expect(render('![図][a]\n\n[a]: img/a.png', assets)).toContain(`<img src="${dataUri}"`);
        expect(render('![図](<my img/日本.png>)', { baseDir: 'docs', files })).toContain(`<img src="${dataUri}"`);
        expect(render('![図](my%20img/%E6%97%A5%E6%9C%AC.png)', { baseDir: 'docs', files })).toContain(`<img src="${dataUri}"`);
      });

      it('渡されていない画像・外部URL・ルートの外を指す画像は、文字にする', () => {
        for (const markdown of ['![x](img/none.png)', '![x](https://example.com/a.png)', '![x](../../a.png)']) {
          const html = render(markdown);
          expect(html).not.toContain('<img');
          expect(html).toContain('[画像: x](');
        }
      });

      it('渡された値が画像のdata URIでなければ、信用せず、文字にする', () => {
        const html = render('![x](img/a.png)', { baseDir: 'docs', files: { 'docs/img/a.png': 'javascript:alert(1)' } });
        expect(html).not.toContain('<img');
        expect(html).toContain('[画像: x](img/a.png)');
      });

      it('画像が渡されていなければ、相対パスの画像は文字にする(従来どおり)', () => {
        const html = renderMarkdown('![x](img/a.png)').bodyHtml;
        expect(html).not.toContain('<img');
        expect(html).toContain('[画像: x](img/a.png)');
      });

      it('Object.prototypeのプロパティ名のパスを指しても、画像にならない', () => {
        expect(render('![x](constructor)', { baseDir: '', files: {} })).not.toContain('<img');
      });
    });
  });

  it('最初のH1をタイトルにする。無ければ「無題」', () => {
    expect(renderMarkdown('本文\n\n# 取扱説明書 *第2版*').title).toBe('取扱説明書 第2版');
    expect(renderMarkdown('## 小見出しだけ').title).toBe('無題');
  });
});

describe('空行(「&nbsp;」だけの段落)', () => {
  it('「&nbsp;」だけの段落は、空白の段落(1行分の空き)として出力される', () => {
    const html = renderMarkdown('A\n\n&nbsp;\n\nB').bodyHtml;
    expect(html).toBe('<p>A</p>\n<p>\u00a0</p>\n<p>B</p>');
  });

  it('「&nbsp;」の段落の数だけ、空白の段落が並ぶ(重なった空行は、1つの区切りにまとまる)', () => {
    expect(renderMarkdown('A\n\n&nbsp;\n\n&nbsp;\n\nB').bodyHtml.match(/<p>\u00a0<\/p>/g)).toHaveLength(2);
    expect(renderMarkdown('A\n\n\n\n\n\nB').bodyHtml).toBe('<p>A</p>\n<p>B</p>');
  });

  it('文書の先頭・末尾の「&nbsp;」の段落も、空白の段落になる', () => {
    expect(renderMarkdown('&nbsp;\n\nA\n\n&nbsp;').bodyHtml).toBe('<p>\u00a0</p>\n<p>A</p>\n<p>\u00a0</p>');
  });

  it('ブロック番号(測定用)も、空白の段落に付く', () => {
    const html = renderMarkdown('A\n\n&nbsp;\n\nB', undefined, undefined, { tagBlocks: true }).bodyHtml;
    expect(html).toContain('<p data-block="1">\u00a0</p>');
    expect(html).toContain('<p data-block="2">B</p>');
  });
});

describe('ブロックの番号(ページの区切りの測定用)', () => {
  const tagged = (markdown: string, diagrams?: DiagramMap): string => renderMarkdown(markdown, undefined, diagrams, { tagBlocks: true }).bodyHtml;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><g></g></svg>';
  const flow = 'graph TD\n  A --> B';

  it('付けなければ(PDFの文書)、属性は付かない', () => {
    expect(renderMarkdown('# 見出し\n\n本文').bodyHtml).not.toContain('data-block');
    expect(renderMarkdown('# 見出し\n\n本文', undefined, undefined, { tagBlocks: false }).bodyHtml).not.toContain('data-block');
  });

  it('最上位のブロック(見出し・段落・リスト・引用・表・コード・水平線)に、Markdownでの番号を付ける', () => {
    const html = tagged(['# 見出し', '', '段落', '', '- 項目', '', '> 引用', '', '| a |', '| - |', '| 1 |', '', '```', 'code', '```', '', '---'].join('\n'));
    for (const [tag, index] of [['h1', 0], ['p', 1], ['ul', 2], ['blockquote', 3], ['table', 4], ['pre', 5], ['hr', 6]] as const) {
      expect(html, tag).toContain(`<${tag} data-block="${index}">`);
    }
  });

  it('入れ子の要素(リストの項目・表のセル)には、付かない', () => {
    const html = tagged('- a\n- b\n\n| x |\n| - |\n| y |');
    expect(html.match(/data-block/g)).toHaveLength(2);
    expect(html).toContain('<li>a</li>');
  });

  it('front matter・生HTMLのブロックも、1つのブロックとして数える', () => {
    const html = tagged('---\ntitle: T\n---\n\n<div>生HTML</div>\n\n本文');
    expect(html).toContain('<pre data-block="0">');
    expect(html).toContain('<p data-block="1">');
    expect(html).toContain('<p data-block="2">本文</p>');
  });

  it('画像だけの行(<img>のタグを含む)も、1つのブロック', () => {
    const html = tagged('<img src="data:image/png;base64,iVBORw==" width="10">\n\n本文');
    expect(html).toMatch(/<p data-block="0"><img /);
    expect(html).toContain('<p data-block="1">本文</p>');
  });

  it('Mermaidの図: 1つのブロックが複数の要素になっても、同じ番号が付き、後ろのブロックの番号はずれない', () => {
    const block = (meta: string): string => '```mermaid' + meta + '\n' + flow + '\n```';
    const diagrams: DiagramMap = new Map([[flow, { ok: true, svg }]]);
    // 図のみ: figure 1つ
    expect(tagged(`前\n\n${block('')}\n\n後`, diagrams)).toMatch(/<p data-block="0">前<\/p>\n<figure[^>]* data-block="1"[^>]*>.*<p data-block="2">後<\/p>/s);
    // コードと図: pre と figure の両方が、同じ番号
    const both = tagged(`前\n\n${block(' show=both')}\n\n後`, diagrams);
    expect(both).toContain('<pre data-block="1">');
    expect(both).toMatch(/<figure[^>]* data-block="1"/);
    expect(both).toContain('<p data-block="2">後</p>');
    // 描けなかった図: 理由の段落とコードが、同じ番号
    const failed = tagged(`前\n\n${block('')}\n\n後`, new Map([[flow, { ok: false, message: '誤り' }]]));
    expect(failed).toMatch(/<p[^>]* data-block="1"[^>]*>Mermaid/);
    expect(failed).toContain('<pre data-block="1">');
    expect(failed).toContain('<p data-block="2">後</p>');
  });

  it('番号を付けても、見た目に関わるもの(タグ・クラス・中身)は変わらない', () => {
    const markdown = '# 見出し\n\n```python\nprint(1)\n```\n\n| a |\n| - |\n| 1 |';
    expect(tagged(markdown).replace(/ data-block="\d+"/g, '')).toBe(renderMarkdown(markdown).bodyHtml);
  });
});

describe('Markdownの中の<img>タグ(エディタで大きさを変えた画像)', () => {
  const dataUri = 'data:image/png;base64,iVBORw==';
  const assets: MarkdownAssets = { baseDir: 'docs', files: { 'docs/img/a.png': dataUri } };

  it('画像として表示する。大きさ(width・height)も引き継ぐ', () => {
    const html = body(`本文<img height="166" width="300" src="${dataUri}" />`);
    expect(html).toContain('<img');
    expect(html).toMatch(/<img [^>]*src="data:image\/png;base64,iVBORw=="/);
    expect(html).toMatch(/width="300"/);
    expect(html).toMatch(/height="166"/);
    // タグが、文字として表示されることはない
    expect(html).not.toContain('&#x3C;img');
    expect(html).not.toContain('&#x3C;');
  });

  it('alt・titleも引き継ぎ、実体参照は正しく扱う', () => {
    const html = body(`<img src="${dataUri}" alt="A &amp; B" title="説明" width="50%">`);
    expect(html).toContain('alt="A &#x26; B"');
    expect(html).toContain('title="説明"');
    expect(html).toContain('width="50%"');
  });

  it('文章の途中でも、単独の行でも、箇条書き・引用・表の中でも、画像になる', () => {
    const tag = `<img src="${dataUri}" width="10">`;
    for (const markdown of [`前${tag}後`, tag, `- ${tag}`, `> ${tag}`, `| a |\n| - |\n| ${tag} |`]) {
      const html = body(markdown);
      expect(html, markdown).toContain('<img');
      expect(html, markdown).not.toContain('&#x3C;');
    }
  });

  it('単独の行は、段落になる。同じ行に複数あれば、複数の画像になる', () => {
    expect(body(`<img src="${dataUri}">`)).toMatch(/^<p><img /);
    expect(body(`<img src="${dataUri}"> <img src="${dataUri}">`).match(/<img /g)).toHaveLength(2);
  });

  it('取り込んだ画像(assets)を指していれば、表示する', () => {
    const html = renderMarkdown('<img src="img/a.png" width="120">', assets).bodyHtml;
    expect(html).toContain(`src="${dataUri}"`);
    expect(html).toContain('width="120"');
  });

  it('![]() の画像と同じ扱い: 表示できない画像(外部URL・渡されていないファイル・javascript:)は、文字にする(大きさは付けない)', () => {
    for (const src of ['https://example.com/a.png', 'img/none.png', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
      const html = renderMarkdown(`<img src="${src}" width="10">`, assets).bodyHtml;
      expect(html, src).not.toContain('<img');
      expect(html, src).toContain('[画像: ](');
    }
  });

  it('使わない属性(style・onerror・class・srcset)は、出力されない', () => {
    const html = body(`<img src="${dataUri}" onerror="alert(1)" style="width:1px" class="x" srcset="b.png 2x" onload="alert(2)">`);
    expect(html).toContain('<img');
    for (const name of ['onerror', 'style=', 'class=', 'srcset', 'onload', 'alert']) {
      expect(html, name).not.toContain(name);
    }
  });

  it('大きさが数字・「数字%」でなければ、付けない', () => {
    const html = body(`<img src="${dataUri}" width="expression(alert(1))" height="10px">`);
    expect(html).toContain('<img');
    expect(html).not.toContain('width=');
    expect(html).not.toContain('height=');
  });

  it('<img>以外のHTML・<img>が他のタグや文字と混ざるHTML・srcの無い<img>は、これまでどおり、文字として表示する', () => {
    for (const markdown of ['<br>', '<p><img src="' + dataUri + '"></p>', '<img src="' + dataUri + '"><script>alert(1)</script>', '<img alt="x">']) {
      const html = body(markdown);
      expect(html, markdown).toContain('&#x3C;');
      expect(html, markdown).not.toContain('<script');
    }
  });

  it('コードブロック・インラインコードの中の<img>は、文字のまま', () => {
    expect(body('`<img src="a.png">`')).toContain('<code>&#x3C;img src="a.png"></code>');
    expect(body('```html\n<img src="a.png">\n```')).not.toMatch(/<img /);
  });
});

describe('コードブロックの色分け', () => {
  it('言語名に応じて、構文ごとにクラスが付く(Python)', () => {
    const html = body('```python\ndef greet(name):\n    # 挨拶\n    return "こんにちは"\n```');
    expect(html).toContain('<span class="hljs-keyword">def</span>');
    expect(html).toContain('<span class="hljs-title function_">greet</span>');
    expect(html).toContain('<span class="hljs-comment"># 挨拶</span>');
    expect(html).toContain('<span class="hljs-string">"こんにちは"</span>');
  });

  // 登録されている言語は、一部ではなく、ほぼすべて(エディタで選べる言語に加え、一般的な言語を含む)
  it.each([
    ['javascript', 'const x = 1;'],
    ['typescript', 'const x: number = 1;'],
    ['bash', 'echo "hi" && ls -la'],
    ['sql', 'SELECT id FROM users WHERE id = 1;'],
    ['json', '{"a": 1, "b": true}'],
    ['yaml', 'key: value\nlist:\n  - 1'],
    ['html', '<div class="a">x</div>'],
    ['css', '.a { color: red; }'],
    ['java', 'public class A { int x = 1; }'],
    ['csharp', 'public class A { int x = 1; }'],
    ['cpp', '#include <stdio.h>\nint main() { return 0; }'],
    ['go', 'func main() { println("hi") }'],
    ['rust', 'fn main() { let x = 1; }'],
    ['ruby', 'def hello\n  puts "hi"\nend'],
    ['php', '<?php echo "hi"; ?>'],
    ['kotlin', 'fun main() { println("hi") }'],
    ['swift', 'let x: Int = 1'],
    ['powershell', 'Get-ChildItem -Path . | Where-Object { $_.Length -gt 1 }'],
    ['dockerfile', 'FROM node:24\nRUN npm ci'],
    ['ini', '[server]\nport = 8080'],
    ['diff', '--- a\n+++ b\n-old\n+new'],
    ['markdown', '# 見出し\n\n**太字**'],
    ['perl', 'my $x = 1; print $x;'],
    ['lua', 'local x = 1\nprint(x)'],
  ])('%s のコードに、色分けのクラスが付く', (language, code) => {
    expect(body('```' + language + '\n' + code + '\n```')).toMatch(/<span class="hljs-/);
  });

  it('言語名の別名(py・js・sh・c#など)も色分けする', () => {
    for (const alias of ['py', 'js', 'ts', 'sh', 'yml', 'cs', 'c++', 'golang', 'rs']) {
      expect(body('```' + alias + '\nx = 1\n```'), alias).toContain(`language-${alias}`);
    }
    expect(body('```py\ndef f(): pass\n```')).toContain('hljs-keyword');
    expect(body('```sh\necho hi\n```')).toContain('hljs-built_in');
  });

  it('言語名の無いコード・テキスト・未知の言語は、色分けせず、エラーにもならない', () => {
    for (const fence of ['```\nplain text\n```', '```text\nplain text\n```', '```txt\nplain text\n```', '```no-such-language\nplain text\n```']) {
      const html = body(fence);
      expect(html).toContain('plain text');
      expect(html).not.toContain('hljs-');
    }
  });

  it('コードの中のHTMLは、実行も解釈もされず、文字として表示される', () => {
    const html = body('```html\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&#x3C;');
  });

  it('色分けしても、コードの文字は1文字も変わらない', () => {
    const code = 'def f(x):\n    return x < 2 and "a&b" or \'c\'\n';
    const html = body('```python\n' + code + '```');
    const text = html
      .replace(/<[^>]+>/g, '')
      .replace(/&#x3C;/g, '<')
      .replace(/&#x26;/g, '&')
      .replace(/&#x22;/g, '"')
      .replace(/&#x27;/g, "'");
    expect(text).toContain(code);
  });

  it('長すぎるコードは、色分けせずにそのまま表示する', () => {
    const html = body('```python\n' + 'x = 1\n'.repeat(20_000) + '```');
    expect(html).not.toContain('hljs-');
    expect(html).toContain('x = 1');
  });

  it('インラインコードは、色分けしない', () => {
    expect(body('`def f()`')).toBe('<p><code>def f()</code></p>');
  });

  it('PDFのHTMLには、色分けのクラスに対応するCSSが含まれる', () => {
    const css = readFileSync(new URL('../shared/document.css', import.meta.url), 'utf8');
    for (const name of ['hljs-keyword', 'hljs-string', 'hljs-comment', 'hljs-number', 'hljs-title']) {
      expect(css, name).toContain(`.${name}`);
    }
  });
});

describe('Mermaidの図', () => {
  const svg = '<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><g></g></svg>';
  const flow = 'graph TD\n  A --> B';
  const diagrams = (entries: [string, DiagramOutcome][]): DiagramMap => new Map(entries);

  describe('extractMermaidSources', () => {
    it('mermaidのコードブロックだけを、文書の上から順に取り出す', () => {
      const markdown = ['```python', 'x = 1', '```', '', '```mermaid', 'graph TD\n  A --> B', '```', '', '```Mermaid', 'pie\n  "a": 1', '```'].join('\n');
      expect(extractMermaidSources(markdown)).toEqual(['graph TD\n  A --> B', 'pie\n  "a": 1']);
    });

    it('同じ内容の図は1つにまとめる', () => {
      const block = '```mermaid\n' + flow + '\n```';
      expect(extractMermaidSources(`${block}\n\n本文\n\n${block}`)).toEqual([flow]);
    });

    it('引用・箇条書きの中の図も取り出す。mermaid以外・言語なしは対象外', () => {
      const markdown = ['> ```mermaid', '> graph LR', '> ```', '', '- ```mermaid', '  pie', '  ```', '', '```', 'graph TD', '```', '', '    mermaid風のインデントコード'].join('\n');
      expect(extractMermaidSources(markdown)).toEqual(['graph LR', 'pie']);
    });

    it('図が無ければ空', () => {
      expect(extractMermaidSources('# 見出し\n\n```python\nx\n```')).toEqual([]);
    });
  });

  describe('描画済みの図を渡した場合', () => {
    it('コードブロックの代わりに、図(figure/img)を表示する', () => {
      const html = renderMarkdown('```mermaid\n' + flow + '\n```', undefined, diagrams([[flow, { ok: true, svg }]])).bodyHtml;
      expect(html).toContain('<figure class="mermaid-diagram">');
      expect(html).toMatch(/<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" width="120" height="80" alt="Mermaidの図">/);
      expect(html).not.toContain('<pre>');
      expect(html).not.toContain('graph TD');
    });

    it('埋め込んだSVGは、幅・高さが明示され、元の内容が保たれる', () => {
      const html = renderMarkdown('```mermaid\n' + flow + '\n```', undefined, diagrams([[flow, { ok: true, svg }]])).bodyHtml;
      const encoded = /base64,([A-Za-z0-9+/=]+)"/.exec(html)?.[1] ?? '';
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      expect(decoded).toContain('<svg width="120" height="80" id="m"');
      expect(decoded).toContain('<g></g></svg>');
    });

    it('同じ図が複数あっても、それぞれ図になる', () => {
      const block = '```mermaid\n' + flow + '\n```';
      const html = renderMarkdown(`${block}\n\n間\n\n${block}`, undefined, diagrams([[flow, { ok: true, svg }]])).bodyHtml;
      expect(html.match(/<figure/g)).toHaveLength(2);
    });

    it('描けなかった図は、理由を添えて、コードのまま表示する(PDFの生成は続ける)', () => {
      const html = renderMarkdown('```mermaid\n' + flow + '\n```', undefined, diagrams([[flow, { ok: false, message: 'Parse error on line 2:' }]])).bodyHtml;
      expect(html).toContain('<p class="diagram-error">Mermaidの図を描画できなかったため、コードのまま表示します(Parse error on line 2:)</p>');
      expect(html).toContain('<pre><code class="language-mermaid">graph TD');
      expect(html).not.toContain('<figure');
    });

    it('図の大きさを読み取れないSVGは、描けなかった図として扱う', () => {
      const html = renderMarkdown('```mermaid\n' + flow + '\n```', undefined, diagrams([[flow, { ok: true, svg: '<svg></svg>' }]])).bodyHtml;
      expect(html).toContain('diagram-error');
      expect(html).toContain('<pre>');
    });

    it('描けなかった図の理由に含まれるHTMLは、文字として表示される', () => {
      const html = renderMarkdown('```mermaid\n' + flow + '\n```', undefined, diagrams([[flow, { ok: false, message: '<img src=x onerror=alert(1)>' }]])).bodyHtml;
      expect(html).not.toContain('<img');
      expect(html).toContain('&#x3C;img src=x onerror=alert(1)>');
    });

    it('結果の無い図(渡されたものに含まれない図)と、mermaid以外のコードは、そのまま', () => {
      const html = renderMarkdown('```mermaid\npie\n```\n\n```python\nx = 1\n```', undefined, diagrams([[flow, { ok: true, svg }]])).bodyHtml;
      expect(html).not.toContain('<figure');
      expect(html).toContain('language-mermaid');
      expect(html).toContain('language-python');
    });
  });

  describe('表示の選択(show=)', () => {
    const block = (meta: string): string => '```mermaid' + meta + '\n' + flow + '\n```';
    const render = (meta: string): string => renderMarkdown(block(meta), undefined, diagrams([[flow, { ok: true, svg }]])).bodyHtml;

    it('書かなければ「図のみ」(show=diagram も同じ)', () => {
      for (const html of [render(''), render(' show=diagram')]) {
        expect(html).toContain('<figure');
        expect(html).not.toContain('<pre>');
      }
    });

    it('show=code は、図にせず、コードだけを表示する', () => {
      const html = render(' show=code');
      expect(html).not.toContain('<figure');
      expect(html).not.toContain('<img');
      expect(html).toContain('<pre><code class="language-mermaid">graph TD');
    });

    it('show=both は、コードの下に図を表示する', () => {
      const html = render(' show=both');
      expect(html).toContain('<pre><code class="language-mermaid">graph TD');
      expect(html).toContain('<figure class="mermaid-diagram">');
      expect(html.indexOf('<pre>')).toBeLessThan(html.indexOf('<figure'));
    });

    it('読めない選択は、既定(図のみ)になる', () => {
      const html = render(' show=everything');
      expect(html).toContain('<figure');
      expect(html).not.toContain('<pre>');
    });

    it('ほかのメタ情報があっても、選択は効く', () => {
      expect(render(' title="a" show=both')).toContain('<pre>');
    });

    it('描けなかった図は、選択に関わらず、理由とコードを表示する(コードのみを除く)', () => {
      for (const meta of ['', ' show=both']) {
        const html = renderMarkdown(block(meta), undefined, diagrams([[flow, { ok: false, message: '誤り' }]])).bodyHtml;
        expect(html).toContain('diagram-error');
        expect(html).toContain('<pre>');
        expect(html).not.toContain('<figure');
      }
      const codeOnly = renderMarkdown(block(' show=code'), undefined, diagrams([[flow, { ok: false, message: '誤り' }]])).bodyHtml;
      expect(codeOnly).not.toContain('diagram-error');
      expect(codeOnly).toContain('<pre>');
    });

    it('同じ図でも、ブロックごとの選択に従う', () => {
      const html = renderMarkdown([block(''), block(' show=code'), block(' show=both')].join('\n\n'), undefined, diagrams([[flow, { ok: true, svg }]])).bodyHtml;
      expect(html.match(/<figure/g)).toHaveLength(2);
      expect(html.match(/<pre>/g)).toHaveLength(2);
    });

    it('extractMermaidSources: コードのみのブロックは、描画の対象に含めない', () => {
      expect(extractMermaidSources(block(' show=code'))).toEqual([]);
      expect(extractMermaidSources(block(' show=both'))).toEqual([flow]);
      // 同じ図が、コードのみと図のみの両方にあれば、図のために1つ描く
      expect(extractMermaidSources([block(' show=code'), block('')].join('\n\n'))).toEqual([flow]);
    });
  });

  it('図を渡さなければ、mermaidのコードは、色分けされず、そのままコードとして表示される', () => {
    const html = body('```mermaid\n' + flow + '\n```');
    expect(html).toContain('<pre><code class="language-mermaid">graph TD');
    expect(html).not.toContain('hljs-');
  });
});

describe('手動の改ページ', () => {
  const marker = '<div style="page-break-after: always"></div>';
  const tagged = (markdown: string): string => renderMarkdown(markdown, undefined, undefined, { tagBlocks: true }).bodyHtml;

  it('文書の直下にある改ページの印は、文字ではなく、中身の無い改ページの要素になる', () => {
    const html = body(`前\n\n${marker}\n\n後`);
    expect(html).toContain('<div class="manual-page-break"></div>');
    expect(html).toContain('<p>前</p>');
    expect(html).toContain('<p>後</p>');
    expect(html).not.toContain('page-break-after');
    expect(html).not.toContain('&#x3C;div');
  });

  it('書き方が違っても(break-after: page・引用符・大文字小文字)、改ページになる', () => {
    for (const variant of ['<div style="break-after: page"></div>', "<div style='PAGE-BREAK-AFTER:always;'></div>"]) {
      expect(body(`前\n\n${variant}\n\n後`), variant).toContain('<div class="manual-page-break"></div>');
    }
  });

  it('改ページ以外のHTMLは、これまでどおり、文字として表示される', () => {
    for (const other of ['<div class="x"></div>', '<div style="page-break-after: always">本文</div>', '<div style="color: red"></div>', '<div></div>']) {
      const html = body(`前\n\n${other}\n\n後`);
      expect(html, other).not.toContain('manual-page-break');
      expect(html, other).toContain('&#x3C;div');
    }
  });

  it('リスト・引用の中や、段落の途中に書いた印は、改ページにならない(文書の直下だけ)', () => {
    expect(body(`- ${marker}`)).not.toContain('manual-page-break');
    expect(body(`> ${marker}`)).not.toContain('manual-page-break');
    expect(body(`文章 ${marker} 続き`)).not.toContain('manual-page-break');
  });

  it('コードブロックの中に書いた印は、コードのまま', () => {
    const html = body('```html\n' + marker + '\n```');
    expect(html).not.toContain('manual-page-break');
    expect(html).toContain('page-break-after');
  });

  it('1つのブロックとして数え、後ろのブロックの番号はずれない', () => {
    const html = tagged(`前\n\n${marker}\n\n後`);
    expect(html).toContain('<p data-block="0">前</p>');
    expect(html).toContain('<div class="manual-page-break" data-block="1"></div>');
    expect(html).toContain('<p data-block="2">後</p>');
  });

  it('連続する印は、それぞれ改ページになる', () => {
    expect(body(`前\n\n${marker}\n\n${marker}\n\n後`).match(/manual-page-break/g)).toHaveLength(2);
  });
});

describe('buildDocumentHtml', () => {
  it('lang=jaの完全なHTMLで、CSSとbody.documentを含む。タイトルはエスケープされる', () => {
    const html = buildDocumentHtml('# A & <B>', '.x{color:red}');
    expect(html).toMatch(/^<!doctype html><html lang="ja">/);
    expect(html).toContain('<style>.x{color:red}</style>');
    expect(html).toContain('<body class="document">');
    expect(html).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(html).toContain("default-src 'none'");
  });
});
