import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareHtmlForPdf } from '../src/server/htmlDocument.js';
import { buildDocumentHtml, extractMermaidSources, type DiagramMap } from '../src/server/markdownToHtml.js';
import { createPdfRenderer, type PdfRenderer } from '../src/server/pdf.js';
import { PAGE_BREAK_MARKUP } from '../src/shared/pageBreak.js';
import { DEFAULT_PAGE_SETTINGS, MARGIN_PRESETS, ORIENTATIONS, PAPER_SIZES, paperMm, type PageSettings } from '../src/shared/pageSettings.js';
import { selfCheck } from '../src/server/selfCheck.js';

/*
 * 実Chromiumでの統合テスト。Chromium(CHROMIUM_PATH)と poppler-utils(pdffonts/pdfinfo/pdftotext)が必要。
 * Dockerのtestステージで実行する。無い環境では黙ってスキップせず、失敗させる。
 */
const css = readFileSync(new URL('../src/shared/document.css', import.meta.url), 'utf8');
const renderer: PdfRenderer = createPdfRenderer({
  chromiumPath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
  timeoutMs: 60_000,
  mermaidScript: readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8'),
});

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-pdf-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writePdf = (name: string, pdf: Buffer): string => {
  const path = join(workDir, name);
  writeFileSync(path, pdf);
  return path;
};
const poppler = (tool: string, ...args: string[]): string => execFileSync(tool, args, { encoding: 'utf8' });

const wideTable = (): string => {
  const header = `| ${Array.from({ length: 10 }, (_, i) => `列${i + 1}`).join(' | ')} |`;
  const delimiter = `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`;
  const row = (r: number) => `| ${Array.from({ length: 10 }, (_, c) => `行${r}-${c + 1} の説明文`).join(' | ')} |`;
  return [header, delimiter, ...Array.from({ length: 4 }, (_, r) => row(r + 1))].join('\n');
};

describe('PDF生成(実Chromium)', () => {
  it('日本語・絵文字・罫線・10列の表を含むMarkdownがPDFになる', async () => {
    const markdown = [
      '# 日本語の見出し ✓ → 🔧',
      '',
      '本文です。禁則処理（句読点、括弧）を確認します。',
      '',
      '```',
      'project/',
      '├─ src/',
      '│  └─ main.ts',
      '└─ README.md',
      '```',
      '',
      wideTable(),
    ].join('\n');

    const pdf = await renderer.render(buildDocumentHtml(markdown, css));
    const path = writePdf('basic.pdf', pdf);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(poppler('pdfinfo', path)).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    expect(poppler('pdffonts', path)).toContain('NotoSansCJKjp');
    const text = poppler('pdftotext', path, '-');
    expect(text).toContain('日本語の見出し');
    expect(text).toContain('禁則処理');
    expect(text).toContain('列10');
    expect(text).toContain('行4-10');
    // フッターのページ番号
    expect(text).toMatch(/1\s*\/\s*1/);
  });

  it('Markdownの相対パスの画像(assets)は、PDFに画像として入る。渡されていない画像は文字になる', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const markdown = '# 画像\n\n![図](img/a.png)\n\n![無い図](img/none.png)';
    const path = writePdf('md-assets.pdf', await renderer.render(buildDocumentHtml(markdown, css, { baseDir: 'docs', files: { 'docs/img/a.png': png } })));

    expect(poppler('pdfimages', '-list', path).split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line))).toHaveLength(1);
    expect(poppler('pdftotext', path, '-')).toContain('[画像: 無い図](img/none.png)');
  });

  it('長い文書は複数ページになり、表の見出し行が各ページで繰り返される', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| ${i + 1} | データ${i + 1} |`).join('\n');
    const markdown = `# 長い表\n\n| 番号 | 内容 |\n| --- | --- |\n${rows}`;

    const path = writePdf('long.pdf', await renderer.render(buildDocumentHtml(markdown, css)));

    const pages = Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]);
    expect(pages).toBeGreaterThan(1);
    const secondPage = poppler('pdftotext', '-f', '2', '-l', '2', path, '-');
    expect(secondPage).toContain('番号');
    expect(secondPage).toContain('内容');
  });

  it('外部リソースへは通信しない(画像の参照先がローカルのサーバでも、アクセスが発生しない)', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      // buildDocumentHtmlは外部画像を文字に置き換えるため、ここではレンダラ自身の遮断を見るよう生のHTMLを渡す
      const html = `<!doctype html><html><body><img src="http://127.0.0.1:${port}/img.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"><p>本文</p></body></html>`;
      const pdf = await renderer.render(html);

      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(requested).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('スクリプトは実行されない', async () => {
    const html = '<!doctype html><html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script></body></html>';
    const text = poppler('pdftotext', writePdf('script.pdf', await renderer.render(html)), '-');
    expect(text).toContain('前');
    expect(text).not.toContain('実行された');
  });

  it('存在しないChromiumを指定すると、PDFの生成に失敗として例外になる', async () => {
    const broken = createPdfRenderer({ chromiumPath: '/nonexistent/chromium', timeoutMs: 5_000, mermaidScript: '' });
    await expect(broken.render('<p>x</p>')).rejects.toThrowError('PDFの生成に失敗しました');
    await expect(broken.chromiumVersion()).rejects.toThrowError('Chromiumを起動できません');
  });
});

// 1ページ目を画像にして、条件に合う色の点がいくつあるかを数える(pdftoppmが出力するP6形式のPPMを読む)
function countPixels(pdfPath: string, matches: (red: number, green: number, blue: number) => boolean): number {
  const root = `${pdfPath}.page`;
  execFileSync('pdftoppm', ['-r', '80', '-f', '1', '-l', '1', '-singlefile', pdfPath, root]);
  const ppm = readFileSync(`${root}.ppm`);
  // ヘッダ: "P6\n<幅> <高さ>\n255\n"。その後ろが画素(R,G,Bの順)
  const header = /^P6\s+\d+\s+\d+\s+255\s/.exec(ppm.subarray(0, 64).toString('latin1'));
  if (header === null) {
    throw new Error('PPMを読めません');
  }
  let count = 0;
  for (let offset = header[0].length; offset + 2 < ppm.length; offset += 3) {
    if (matches(ppm[offset] ?? 0, ppm[offset + 1] ?? 0, ppm[offset + 2] ?? 0)) {
      count += 1;
    }
  }
  return count;
}

// 図の箱の塗り(薄い紫 #ececff)。コードブロックの背景(薄い灰色 #f3f4f6)とは、青みの差で見分ける
const isDiagramFill = (r: number, g: number, b: number): boolean => b > 240 && b - r > 12 && b - g > 12;

// 単色のPNG(幅・高さ・色を指定)。画像を、どの大きさで表示したかを、PDFの画素で測るために使う
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc32 = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) {
      c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8bit・RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

describe('Markdownの中の<img>タグ(エディタで大きさを変えた画像)(実Chromium)', () => {
  const red = solidPng(200, 100, [220, 20, 20]);
  const isRed = (r: number, g: number, b: number): boolean => r > 180 && g < 80 && b < 80;
  // 80dpiで1ページ目を画像にしたときの、1CSSピクセルあたりの画素数: 80 / 96
  const pixelsPerCssPx = 80 / 96;

  const redPixelsOf = async (name: string, markdown: string): Promise<{ path: string; red: number }> => {
    const path = writePdf(name, await renderer.render(buildDocumentHtml(markdown, css)));
    return { path, red: countPixels(path, isRed) };
  };

  it('大きさ(width・height)を指定した<img>は、PDFで、画像として、その大きさで表示される(タグの文字は出ない)', async () => {
    const { path, red: area } = await redPixelsOf('img-tag.pdf', `# 画像\n\n<img src="${red}" width="300" height="150" />\n\n本文`);

    expect(poppler('pdfimages', '-list', path).split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line))).toHaveLength(1);
    const text = poppler('pdftotext', path, '-');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('base64');
    expect(text).toContain('本文');
    // 300x150(CSSピクセル)の面積(±8%)
    const expected = 300 * 150 * pixelsPerCssPx ** 2;
    expect(area).toBeGreaterThan(expected * 0.92);
    expect(area).toBeLessThan(expected * 1.08);
  });

  it('大きさを指定しない<img>は、画像そのものの大きさ(200x100)で表示される', async () => {
    const { red: area } = await redPixelsOf('img-tag-natural.pdf', `<img src="${red}">`);
    const expected = 200 * 100 * pixelsPerCssPx ** 2;
    expect(area).toBeGreaterThan(expected * 0.92);
    expect(area).toBeLessThan(expected * 1.08);
  });

  it('ページの幅を超える大きさを指定しても、はみ出さず、縦横比(2:1)を保って縮められる', async () => {
    const { red: area } = await redPixelsOf('img-tag-wide.pdf', `<img src="${red}" width="2000" height="1000" />`);
    // 本文の幅(170mm = 約642CSSピクセル)に収まり、高さは、画像の縦横比から決まる(約321)。引き伸ばされた比率(2:1ではない)にはならない
    const width = 170 / 25.4 * 96;
    const expected = width * (width / 2) * pixelsPerCssPx ** 2;
    expect(area).toBeGreaterThan(expected * 0.92);
    expect(area).toBeLessThan(expected * 1.08);
  });

  it('画像の記法 ![]() と同じ大きさ・同じ見た目になる(<img>は、大きさの指定を加えただけ)', async () => {
    const markdownImage = await redPixelsOf('img-md.pdf', `![](${red})`);
    const tag = await redPixelsOf('img-tag-same.pdf', `<img src="${red}">`);
    expect(tag.red).toBe(markdownImage.red);
  });
});

describe('ページの区切りの測定(実Chromium)', () => {
  const para = (label: string, repeat = 8): string => `これは${label}です。` + 'PDFのページの区切りを確かめるための、少し長めの文章を繰り返します。'.repeat(repeat);

  const longDocument = (): string => {
    const parts: string[] = ['# 長い文書', ''];
    for (let chapter = 1; chapter <= 7; chapter += 1) {
      parts.push(`## 第${chapter}章 見出し`, '');
      parts.push(para(`第${chapter}章の段落A`), '', para(`第${chapter}章の段落B`, 5), '');
      parts.push(...Array.from({ length: 5 }, (_, index) => `- 第${chapter}章の項目${index + 1} ${'説明の文章'.repeat(6)}`), '');
      parts.push(`> 第${chapter}章の引用です。${'引用の文章'.repeat(10)}`, '');
      if (chapter === 3) {
        parts.push('| 番号 | 名前 | 説明 |', '| --- | --- | --- |', ...Array.from({ length: 45 }, (_, index) => `| ${index + 1} | 行${index + 1}の名前 | 行${index + 1}の説明文です |`), '');
      }
      if (chapter === 5) {
        parts.push('```', ...Array.from({ length: 45 }, (_, index) => `code line ${index + 1}`), '```', '');
      }
    }
    return parts.join('\n');
  };

  const pagesOf = (path: string): number => Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]);
  // ページの本文(フッターのページ番号を除く)。空白は除く
  const textOfPage = (path: string, page: number): string =>
    poppler('pdftotext', '-raw', '-f', String(page), '-l', String(page), path, '-').replace(/\s+/g, '');

  it('測ったページ数と、各ページの最初の文字が、実際のPDFと一致する(段落・リスト・引用・表・コードを含む長い文書)', async () => {
    const layout = await renderer.measurePages(buildDocumentHtml(longDocument(), css, undefined, undefined, { tagBlocks: true }));
    const path = writePdf('layout-long.pdf', await renderer.render(buildDocumentHtml(longDocument(), css)));

    expect(layout.pages).toBeGreaterThan(5);
    expect(layout.pages).toBe(pagesOf(path));
    expect(layout.starts.map((start) => start.page)).toEqual(Array.from({ length: layout.pages - 1 }, (_, index) => index + 2));
    for (const start of layout.starts) {
      const text = textOfPage(path, start.page);
      // そのページの最初に、新しいページの最初の文字がある(表は、見出しの行が繰り返される分だけ、後ろにずれる)
      const at = text.indexOf(start.snippet.slice(0, 10));
      expect(at, `ページ${start.page} 「${start.snippet}」 実際: ${text.slice(0, 40)}`).toBeGreaterThanOrEqual(0);
      expect(at, `ページ${start.page}`).toBeLessThanOrEqual(start.kind === 'row' ? 20 : 3);
    }
  });

  it('位置の種類: 段落の途中(text)・表の行(row)・コードの行(line)・ブロックの先頭(start)が、それぞれ現れる', async () => {
    const markdown = longDocument();
    const layout = await renderer.measurePages(buildDocumentHtml(markdown, css, undefined, undefined, { tagBlocks: true }));
    const kinds = new Set(layout.starts.map((start) => start.kind));
    for (const kind of ['text', 'start', 'row', 'line']) {
      expect(kinds.has(kind as 'text'), kind).toBe(true);
    }
    // ブロックの番号は、Markdownの最上位のブロックの並び(空行で区切られた、見出し・段落・リスト・表・コードなど)の番号
    const blockCount = markdown.split(/\n{2,}/).length - 1; // コードブロックの中に空行は無い
    for (const start of layout.starts) {
      expect(start.block).toBeGreaterThanOrEqual(0);
      expect(start.block).toBeLessThanOrEqual(blockCount);
      if (start.kind === 'row') {
        expect(start.tag).toBe('table');
        expect(start.index).toBeGreaterThan(0);
      }
      if (start.kind === 'line') {
        expect(start.tag).toBe('pre');
        expect(start.index).toBeGreaterThan(0);
      }
    }
    // 番号は、後ろのページほど大きい(ページは、文書の順に並ぶ)
    const blocks = layout.starts.map((start) => start.block);
    expect(blocks).toEqual([...blocks].sort((a, b) => a - b));
  });

  it('見出しは、ページの最後に1つだけ残らず、次のブロックと一緒に、次のページに移る(PDFと同じ)', async () => {
    // 見出しの直前までを、ちょうどページの最後に近づける: 段落の数を変えて、複数の文書で、PDFとの一致を確かめる
    for (const paragraphs of [9, 10, 11, 12, 13, 14, 15, 16]) {
      const markdown = [`# 見出し0`, ...Array.from({ length: paragraphs }, (_, index) => para(`段落${index}`, 4)), '## 次の見出し', para('見出しの後の段落', 4)].join('\n\n');
      const html = buildDocumentHtml(markdown, css);
      const layout = await renderer.measurePages(html);
      const path = writePdf(`layout-heading-${paragraphs}.pdf`, await renderer.render(html));
      expect(layout.pages, `段落${paragraphs}`).toBe(pagesOf(path));
      for (const start of layout.starts) {
        expect(textOfPage(path, start.page).indexOf(start.snippet.slice(0, 10)), `段落${paragraphs} ページ${start.page}`).toBe(0);
      }
    }
  });

  it('1ページに収まる文書は、1ページで、区切りは無い。空に近い文書も扱える', async () => {
    const short = await renderer.measurePages(buildDocumentHtml('# 短い文書\n\n本文です。', css));
    expect(short).toEqual({ pages: 1, starts: [] });
    const empty = await renderer.measurePages(buildDocumentHtml('', css));
    expect(empty.pages).toBe(1);
    expect(empty.starts).toEqual([]);
  });

  it('画像・水平線が、ページの先頭になる場合も、PDFと一致する', async () => {
    const red = solidPng(400, 300, [200, 30, 30]);
    const filler = (count: number): string => Array.from({ length: count }, (_, index) => para(`詰め物${index}`, 3)).join('\n\n');
    for (const count of [6, 7, 8, 9, 10, 11]) {
      const markdown = [filler(count), `![](${red})`, '---', 'この水平線のあとの文です。'].join('\n\n');
      const html = buildDocumentHtml(markdown, css);
      const layout = await renderer.measurePages(html);
      const path = writePdf(`layout-image-${count}.pdf`, await renderer.render(html));
      expect(layout.pages, `詰め物${count}`).toBe(pagesOf(path));
      for (const start of layout.starts.filter((entry) => entry.snippet !== '')) {
        expect(textOfPage(path, start.page).indexOf(start.snippet.slice(0, 10)), `詰め物${count} ページ${start.page}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // 乱数(再現できるよう、種を決める)で作った、ブロックの種類・長さの違う文書で、PDFとの一致を確かめる
  it('いろいろな文書(段落・見出し・リスト・表・コード・引用・水平線・画像を、さまざまな長さで組み合わせたもの)でも、PDFのページ数と各ページの最初が一致する', async () => {
    let seed = 20261006;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
    const image = solidPng(300, 120, [30, 90, 200]);
    const block = (index: number): string => {
      switch (between(0, 8)) {
        case 0:
          return `${'#'.repeat(between(1, 3))} 見出し${index}`;
        case 1:
        case 2:
          return para(`段落${index}`, between(1, 9));
        case 3:
          return Array.from({ length: between(2, 9) }, (_, item) => `- 項目${index}-${item} ${'説明の文章'.repeat(between(1, 8))}`).join('\n');
        case 4:
          return ['| 番号 | 内容 |', '| --- | --- |', ...Array.from({ length: between(2, 25) }, (_, row) => `| ${row} | 行${index}-${row}の説明文 |`)].join('\n');
        case 5:
          return ['```', ...Array.from({ length: between(2, 30) }, (_, line) => `code ${index} line ${line}`), '```'].join('\n');
        case 6:
          return `> 引用${index}です。${'引用の文章'.repeat(between(2, 25))}`;
        case 7:
          return random() < 0.5 ? '---' : `![](${image})`;
        default:
          return `1. 番号付き${index}-a ${'説明'.repeat(between(1, 20))}\n2. 番号付き${index}-b ${'説明'.repeat(between(1, 20))}`;
      }
    };
    for (let documentIndex = 0; documentIndex < 12; documentIndex += 1) {
      const markdown = Array.from({ length: between(8, 28) }, (_, index) => block(index)).join('\n\n');
      const layout = await renderer.measurePages(buildDocumentHtml(markdown, css, undefined, undefined, { tagBlocks: true }));
      const path = writePdf(`layout-fuzz-${documentIndex}.pdf`, await renderer.render(buildDocumentHtml(markdown, css)));
      expect(layout.pages, `文書${documentIndex}のページ数`).toBe(pagesOf(path));
      for (const start of layout.starts.filter((entry) => entry.snippet !== '')) {
        const text = textOfPage(path, start.page);
        // 先頭の数文字だけ比べる(リストの番号「1.」など、PDFの文字には含まれるが、文書の文字には無い記号が、途中に入るため)
        const at = text.indexOf(start.snippet.slice(0, 4));
        expect(at, `文書${documentIndex} ページ${start.page} 「${start.snippet}」 実際: ${text.slice(0, 30)}`).toBeGreaterThanOrEqual(0);
        expect(at, `文書${documentIndex} ページ${start.page}`).toBeLessThanOrEqual(start.kind === 'row' ? 20 : 3);
      }
    }
  });

  it('測定のために、文書のスクリプトは実行されず、外部へも通信しない', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      // buildDocumentHtmlは、生HTMLを文字にするため、レンダラ自身の遮断を見るよう、生のHTMLを渡す
      const html = `<!doctype html><html><body class="document"><p id="t">本文</p><img src="http://127.0.0.1:${port}/x.png"><script>document.getElementById('t').textContent='実行された';fetch('http://127.0.0.1:${port}/s')</script></body></html>`;
      const layout = await renderer.measurePages(html);
      expect(layout.pages).toBe(1);
      expect(requested).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe('手動の改ページ(実Chromium)', () => {
  const para = (label: string, repeat = 8): string => `これは${label}です。` + 'PDFのページの区切りを確かめるための、少し長めの文章を繰り返します。'.repeat(repeat);
  const pagesOf = (path: string): number => Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]);
  const textOfPage = (path: string, page: number): string =>
    poppler('pdftotext', '-raw', '-f', String(page), '-l', String(page), path, '-').replace(/\s+/g, '');
  // 測定(/api/layout と同じ、ブロック番号つき)と、実際のPDFの両方を作る
  const measureAndRender = async (name: string, markdown: string) => {
    const layout = await renderer.measurePages(buildDocumentHtml(markdown, css, undefined, undefined, { tagBlocks: true }));
    const path = writePdf(`${name}.pdf`, await renderer.render(buildDocumentHtml(markdown, css)));
    return { layout, path };
  };

  it('改ページの印の位置で、新しいページになる。印の前の内容は前のページに、後ろの内容は次のページに入る', async () => {
    const markdown = ['PAGEONE-TOKEN 最初のページ', PAGE_BREAK_MARKUP, 'PAGETWO-TOKEN 2ページ目', PAGE_BREAK_MARKUP, 'PAGETHREE-TOKEN 3ページ目'].join('\n\n');
    const { layout, path } = await measureAndRender('manual-break-basic', markdown);
    expect(pagesOf(path)).toBe(3);
    expect(textOfPage(path, 1)).toContain('PAGEONE-TOKEN');
    expect(textOfPage(path, 1)).not.toContain('PAGETWO-TOKEN');
    expect(textOfPage(path, 2)).toContain('PAGETWO-TOKEN');
    expect(textOfPage(path, 2)).not.toContain('PAGETHREE-TOKEN');
    expect(textOfPage(path, 3)).toContain('PAGETHREE-TOKEN');
    // 印の「文字」は、PDFに出ない
    expect(poppler('pdftotext', '-raw', path, '-')).not.toContain('page-break-after');
    // 測定も、同じ。各ページの最初の文字(印の直後のブロックの先頭)が、区切りになる
    expect(layout.pages).toBe(3);
    expect(layout.starts.map((start) => [start.page, start.kind, start.block, start.snippet.slice(0, 12)])).toEqual([
      [2, 'start', 2, 'PAGETWO-TOKEN'.slice(0, 12)],
      [3, 'start', 4, 'PAGETHREE-TOK'.slice(0, 12)],
    ]);
  });

  it('印のあとの内容が、ページの途中から始まる場合も、測ったページ数と各ページの最初が、PDFと一致する(ページの境目に近い位置の印)', async () => {
    for (const count of [3, 4, 5, 6, 7, 8, 9]) {
      const filler = Array.from({ length: count }, (_, index) => para(`詰め物${index}`, 3)).join('\n\n');
      const markdown = [filler, PAGE_BREAK_MARKUP, `AFTERBREAK-TOKEN ${para('印の後の段落', 6)}`, para('さらに続く段落', 12)].join('\n\n');
      const { layout, path } = await measureAndRender(`manual-break-${count}`, markdown);
      expect(layout.pages, `詰め物${count}`).toBe(pagesOf(path));
      for (const start of layout.starts) {
        expect(textOfPage(path, start.page).indexOf(start.snippet.slice(0, 10)), `詰め物${count} ページ${start.page}`).toBe(0);
      }
      // 印の後ろの内容は、必ず、新しいページの先頭
      const after = layout.starts.find((start) => start.snippet.startsWith('AFTERBREAK'));
      expect(after, `詰め物${count}`).toBeDefined();
      expect(textOfPage(path, after?.page ?? 0).startsWith('AFTERBREAK-TOKEN'), `詰め物${count}`).toBe(true);
    }
  });

  it('文書の最後の印は、空のページを作らない(測定も、PDFと同じ)', async () => {
    const { layout, path } = await measureAndRender('manual-break-last', ['LASTPAGE-TOKEN 本文', PAGE_BREAK_MARKUP].join('\n\n'));
    expect(pagesOf(path)).toBe(1);
    expect(layout).toEqual({ pages: 1, starts: [] });
  });

  it('文書の先頭の印と、連続する印は、空のページになる(測定も、PDFと同じページ数で、後ろのページの番号がずれない)', async () => {
    const leading = await measureAndRender('manual-break-leading', [PAGE_BREAK_MARKUP, 'FIRSTTEXT-TOKEN 本文'].join('\n\n'));
    expect(leading.layout.pages).toBe(pagesOf(leading.path));
    expect(textOfPage(leading.path, pagesOf(leading.path))).toContain('FIRSTTEXT-TOKEN');

    const twice = await measureAndRender('manual-break-twice', ['BEFORE-TOKEN 前', PAGE_BREAK_MARKUP, PAGE_BREAK_MARKUP, 'AFTER-TOKEN 後'].join('\n\n'));
    expect(twice.layout.pages).toBe(pagesOf(twice.path));
    expect(pagesOf(twice.path)).toBe(3);
    // 空のページには、フッターのページ番号(「2 / 3」)だけが残る
    expect(textOfPage(twice.path, 2)).toBe('2/3');
    expect(twice.layout.starts.map((start) => start.page)).toEqual([3]);
    expect(textOfPage(twice.path, 3)).toContain('AFTER-TOKEN');
  });

  it('改ページの印でないHTML(クラスだけのdivなど)は、改ページにならず、文字として表示される', async () => {
    const markdown = ['SAMEPAGE-ONE 前', '<div class="page-break"></div>', 'SAMEPAGE-TWO 後'].join('\n\n');
    const { layout, path } = await measureAndRender('manual-break-not-a-break', markdown);
    expect(pagesOf(path)).toBe(1);
    expect(layout.pages).toBe(1);
    expect(textOfPage(path, 1)).toContain('<divclass="page-break"></div>');
  });

  it('表・コード・リストの前後に印があっても、測ったページ数と各ページの最初が、PDFと一致する', async () => {
    const table = ['| 番号 | 名前 |', '| --- | --- |', ...Array.from({ length: 12 }, (_, index) => `| ${index + 1} | 行${index + 1} |`)].join('\n');
    const code = ['```', ...Array.from({ length: 10 }, (_, index) => `code line ${index + 1}`), '```'].join('\n');
    const list = Array.from({ length: 6 }, (_, index) => `- 項目${index + 1} ${'説明の文章'.repeat(5)}`).join('\n');
    const markdown = ['# TITLEBLOCK-TOKEN', para('導入', 3), PAGE_BREAK_MARKUP, table, PAGE_BREAK_MARKUP, code, PAGE_BREAK_MARKUP, list, '---', 'LASTBLOCK-TOKEN 終わり'].join('\n\n');
    const { layout, path } = await measureAndRender('manual-break-mixed', markdown);
    expect(layout.pages).toBe(pagesOf(path));
    expect(layout.pages).toBe(4);
    for (const start of layout.starts) {
      expect(textOfPage(path, start.page).indexOf(start.snippet.slice(0, 10)), `ページ${start.page}`).toBeLessThanOrEqual(start.kind === 'row' ? 20 : 3);
    }
  });
});

describe('ページ設定: 用紙・向き・余白・ページ番号(実Chromium)', () => {
  const para = (label: string, repeat = 8): string => `これは${label}です。` + 'PDFのページの区切りを確かめるための、少し長めの文章を繰り返します。'.repeat(repeat);
  const pagesOf = (path: string): number => Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]);
  const textOfPage = (path: string, page: number): string =>
    poppler('pdftotext', '-raw', '-f', String(page), '-l', String(page), path, '-').replace(/\s+/g, '');
  const sizeOf = (path: string): { width: number; height: number } => {
    const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(poppler('pdfinfo', path));
    return { width: Number(match?.[1]), height: Number(match?.[2]) };
  };
  const label = (settings: PageSettings): string => `${settings.paper}・${settings.orientation === 'portrait' ? '縦' : '横'}・余白${settings.margin}`;

  // 見出し・段落・リスト・引用・表・コードを含む、どの用紙でも複数ページになる文書
  const longDocument = (): string => {
    const parts: string[] = ['# 長い文書', ''];
    for (let chapter = 1; chapter <= 9; chapter += 1) {
      parts.push(`## 第${chapter}章 見出し`, '', para(`第${chapter}章の段落A`), '', para(`第${chapter}章の段落B`, 5), '');
      parts.push(...Array.from({ length: 5 }, (_, index) => `- 第${chapter}章の項目${index + 1} ${'説明の文章'.repeat(6)}`), '');
      parts.push(`> 第${chapter}章の引用です。${'引用の文章'.repeat(10)}`, '');
      if (chapter === 3) {
        parts.push('| 番号 | 名前 | 説明 |', '| --- | --- | --- |', ...Array.from({ length: 45 }, (_, index) => `| ${index + 1} | 行${index + 1}の名前 | 行${index + 1}の説明文です |`), '');
      }
      if (chapter === 6) {
        parts.push('```', ...Array.from({ length: 45 }, (_, index) => `code line ${index + 1}`), '```', '');
      }
    }
    return parts.join('\n');
  };

  const everySetting = (): PageSettings[] =>
    PAPER_SIZES.flatMap((paper) => ORIENTATIONS.flatMap((orientation) => MARGIN_PRESETS.map((margin) => ({ paper, orientation, margin, pageNumbers: true }))));

  it.each(everySetting().map((settings) => [label(settings), settings] as const))(
    '測ったページ数と、各ページの最初の文字が、実際のPDFと一致する(%s)',
    async (_name, settings) => {
      const markdown = longDocument();
      const layout = await renderer.measurePages(buildDocumentHtml(markdown, css, undefined, undefined, { tagBlocks: true, pageSettings: settings }), settings);
      const path = writePdf(`settings-${label(settings)}.pdf`, await renderer.render(buildDocumentHtml(markdown, css, undefined, undefined, { pageSettings: settings }), { pageSettings: settings }));

      expect(layout.pages).toBeGreaterThanOrEqual(3);
      expect(layout.pages).toBe(pagesOf(path));
      expect(layout.starts.map((start) => start.page)).toEqual(Array.from({ length: layout.pages - 1 }, (_, index) => index + 2));
      for (const start of layout.starts) {
        const text = textOfPage(path, start.page);
        const at = text.indexOf(start.snippet.slice(0, 10));
        expect(at, `ページ${start.page} 「${start.snippet}」 実際: ${text.slice(0, 40)}`).toBeGreaterThanOrEqual(0);
        expect(at, `ページ${start.page}`).toBeLessThanOrEqual(start.kind === 'row' ? 20 : 3);
      }
    },
  );

  it('PDFの用紙の大きさと向きが、設定どおりになる(全用紙・縦横)', async () => {
    for (const paper of PAPER_SIZES) {
      for (const orientation of ORIENTATIONS) {
        const settings: PageSettings = { ...DEFAULT_PAGE_SETTINGS, paper, orientation };
        const path = writePdf(`size-${label(settings)}.pdf`, await renderer.render(buildDocumentHtml('# 題\n\n本文', css, undefined, undefined, { pageSettings: settings }), { pageSettings: settings }));
        const expected = paperMm(settings);
        const size = sizeOf(path);
        // Chromiumが、用紙の大きさを、整数のポイントへ丸める分(1pt強)の違いは許す
        expect(Math.abs(size.width - (expected.width * 72) / 25.4), label(settings)).toBeLessThan(1.6);
        expect(Math.abs(size.height - (expected.height * 72) / 25.4), label(settings)).toBeLessThan(1.6);
      }
    }
  });

  it('余白の設定で、本文が入る位置が変わる(余白が広いほど、本文の先頭が下・右にずれる)', async () => {
    const firstWord = async (margin: PageSettings['margin']): Promise<{ x: number; y: number }> => {
      const settings: PageSettings = { ...DEFAULT_PAGE_SETTINGS, margin };
      const path = writePdf(`margin-${margin}.pdf`, await renderer.render(buildDocumentHtml('FIRSTWORD 本文', css, undefined, undefined, { pageSettings: settings }), { pageSettings: settings }));
      const xml = poppler('pdftotext', '-bbox', path, '-');
      const match = /<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>FIRSTWORD<\/word>/.exec(xml);
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    };
    const narrow = await firstWord('narrow');
    const standard = await firstWord('standard');
    const wide = await firstWord('wide');
    expect(narrow.x).toBeLessThan(standard.x);
    expect(standard.x).toBeLessThan(wide.x);
    expect(narrow.y).toBeLessThan(standard.y);
    expect(standard.y).toBeLessThan(wide.y);
    // 左の余白は、10mm・20mm・25mm(28.3pt・56.7pt・70.9ptに、文字の左の隙間が加わる)
    expect(standard.x - narrow.x).toBeGreaterThan(26);
    expect(standard.x - narrow.x).toBeLessThan(30);
    expect(wide.x - standard.x).toBeGreaterThan(12);
    expect(wide.x - standard.x).toBeLessThan(16);
  });

  it('ページ番号: ありは、フッターに「1 / 2」が出て、なしは、出ない。余白は、変わらない', async () => {
    const markdown = [para('最初のページ', 10), PAGE_BREAK_MARKUP, 'SECONDPAGE-TOKEN'].join('\n\n');
    const render = async (pageNumbers: boolean): Promise<string> => {
      const settings: PageSettings = { ...DEFAULT_PAGE_SETTINGS, pageNumbers };
      return writePdf(`numbers-${pageNumbers}.pdf`, await renderer.render(buildDocumentHtml(markdown, css, undefined, undefined, { pageSettings: settings }), { pageSettings: settings }));
    };
    const withNumbers = await render(true);
    const without = await render(false);
    expect(textOfPage(withNumbers, 1).endsWith('1/2')).toBe(true);
    expect(textOfPage(withNumbers, 2).endsWith('2/2')).toBe(true);
    expect(textOfPage(without, 1)).not.toMatch(/\d+\/\d+$/);
    expect(textOfPage(without, 2)).toBe('SECONDPAGE-TOKEN');
    expect(pagesOf(without)).toBe(2);
  });

  it('HTML: 用紙・余白は、文書のCSS(@page)が決め、ページ番号の有無だけが、設定に従う', async () => {
    const html = (extraCss: string): string => `<!doctype html><html><head><meta charset="utf-8"><style>${extraCss}</style></head><body><p>HTMLの本文 HTMLTOKEN</p></body></html>`;
    const custom: PageSettings = { paper: 'B4', orientation: 'landscape', margin: 'wide', pageNumbers: false };
    // 設定の用紙(B4横)は、使われない。CSSの指定が無ければ、既定のA4縦
    const plain = writePdf('html-settings-plain.pdf', await renderer.render(prepareHtmlForPdf(html('')), { preferCssPageSize: true, pageSettings: custom }));
    expect(Math.round(sizeOf(plain).width)).toBeLessThanOrEqual(596);
    expect(sizeOf(plain).width).toBeLessThan(sizeOf(plain).height);
    // ページ番号は、設定に従って、出ない。ありなら、出る
    expect(textOfPage(plain, 1)).toBe('HTMLの本文HTMLTOKEN');
    const numbered = writePdf('html-settings-numbered.pdf', await renderer.render(prepareHtmlForPdf(html('')), { preferCssPageSize: true, pageSettings: { ...custom, pageNumbers: true } }));
    expect(textOfPage(numbered, 1)).toBe('HTMLの本文HTMLTOKEN1/1');
    // CSSの @page の用紙の指定は、設定より優先される
    const a5 = writePdf('html-settings-a5.pdf', await renderer.render(prepareHtmlForPdf(html('@page { size: A5 landscape; }')), { preferCssPageSize: true, pageSettings: custom }));
    expect(sizeOf(a5).width).toBeGreaterThan(sizeOf(a5).height);
    expect(Math.abs(sizeOf(a5).width - (210 * 72) / 25.4)).toBeLessThan(2);
  });
});

describe('空行(「&nbsp;」だけの段落)のPDF(実Chromium)', () => {
  // PDFの中の単語の、上端の位置(pt)
  const yOf = (path: string, word: string): number => {
    const xml = poppler('pdftotext', '-bbox', path, '-');
    const match = new RegExp(`yMin="([\\d.]+)"[^>]*>${word}</word>`).exec(xml);
    if (match === null) {
      throw new Error(`PDFに「${word}」がありません`);
    }
    return Number(match[1]);
  };

  const gapOf = async (markdown: string, name: string): Promise<number> => {
    const path = writePdf(`${name}.pdf`, await renderer.render(buildDocumentHtml(markdown, css)));
    return yOf(path, '次の段落') - yOf(path, '最初の段落');
  };

  it('「&nbsp;」だけの段落の数だけ、段落の間が空く。空行が重なっただけでは、空かない(Markdownの規則)', async () => {
    const plain = await gapOf('最初の段落\n\n次の段落', 'blank-0');
    const one = await gapOf('最初の段落\n\n&nbsp;\n\n次の段落', 'blank-1');
    const two = await gapOf('最初の段落\n\n&nbsp;\n\n&nbsp;\n\n次の段落', 'blank-2');
    const collapsed = await gapOf('最初の段落\n\n\n\n\n\n次の段落', 'blank-collapsed');

    // 1つにつき、1行分(行の高さ 11pt×1.7 = 18.7pt)と、段落の間隔(0.6em = 6.6pt)の、約25pt
    expect(one - plain).toBeGreaterThan(22);
    expect(one - plain).toBeLessThan(28);
    expect(two - one).toBeGreaterThan(22);
    expect(two - one).toBeLessThan(28);
    // 空行が重なっただけでは、空かない
    expect(collapsed).toBeCloseTo(plain, 0);
  });

  it('文書の先頭の「&nbsp;」の段落は、先頭に空きになる', async () => {
    const withBlank = writePdf('blank-top.pdf', await renderer.render(buildDocumentHtml('&nbsp;\n\n最初の段落', css)));
    const without = writePdf('blank-top-none.pdf', await renderer.render(buildDocumentHtml('最初の段落', css)));
    expect(yOf(withBlank, '最初の段落') - yOf(without, '最初の段落')).toBeGreaterThan(22);
  });

  describe('ページの区切りの測定: 空行の途中でページが替わる場合', () => {
    const MARKER = '境目のあとの段落';
    // 空行1つ分の高さ(行 11pt×1.7 = 18.7pt + 段落の間隔 6.6pt)
    const BLANK_PITCH_PT = 25.3;
    const pagesOf = (path: string): number => Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]);
    const filler = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `詰め物${index}の段落です。` + 'ページの区切りを確かめるための文章です。'.repeat(8));

    // 各ページの、最初の単語と、MARKER(1行だけの段落)が現れるページ・上端(pt)
    const wordsOf = (path: string, page: number): string => poppler('pdftotext', '-bbox', '-f', String(page), '-l', String(page), path, '-');
    const topOfPage = (path: string, page: number): number => Number(/yMin="([\d.]+)"/.exec(wordsOf(path, page))?.[1]);
    const positionOf = (path: string, pages: number): { page: number; y: number } => {
      for (let page = 1; page <= pages; page += 1) {
        const match = new RegExp(`yMin="([\\d.]+)"[^>]*>${MARKER}</word>`).exec(wordsOf(path, page));
        if (match !== null) {
          return { page, y: Number(match[1]) };
        }
      }
      throw new Error(`PDFに「${MARKER}」がありません`);
    };

    it('ページの上端に残る空行がある場合、区切りは、その空行の前になる(次の文字の前ではない。空行の数は、PDFと一致する)', async () => {
      // 文字だけのページの先頭の高さ(基準)と、空行1つ分の高さ
      const plainPath = writePdf('blank-span-plain.pdf', await renderer.render(buildDocumentHtml(filler(14).join('\n\n'), css)));
      const base = topOfPage(plainPath, 2);

      let spanning = 0;
      for (const fillerCount of [7, 8]) {
        for (const blanks of [0, 1, 2, 3, 4, 6, 8, 12]) {
          const markdown = [...filler(fillerCount), ...Array.from({ length: blanks }, () => '&nbsp;'), MARKER].join('\n\n');
          const label = `詰め物${fillerCount}・空行${blanks}`;
          const layout = await renderer.measurePages(buildDocumentHtml(markdown, css, undefined, undefined, { tagBlocks: true }));
          const path = writePdf(`blank-span-${fillerCount}-${blanks}.pdf`, await renderer.render(buildDocumentHtml(markdown, css)));
          expect(layout.pages, label).toBe(pagesOf(path));

          const found = positionOf(path, layout.pages);
          if (found.page < 2) {
            continue;
          }
          const start = layout.starts.find((entry) => entry.page === found.page);
          expect(start, `${label}: ${found.page}ページ目の区切り`).toBeDefined();
          const markerBlock = fillerCount + blanks;
          if ((start?.block ?? 0) < fillerCount) {
            continue; // 詰め物の文章の途中で、ページが替わる場合(空行とは関係が無い)
          }
          // そのページの上端に、いくつの空行が残っているか(PDFでの、MARKERの位置から)
          const onPage = Math.round((found.y - base) / BLANK_PITCH_PT);
          expect(markerBlock - (start?.block ?? 0), `${label}: ページ${found.page}の上端の空行の数(PDF ${onPage})`).toBe(onPage);
          if (onPage > 0) {
            // 空行から始まるページの区切りは、文字を持たない段落(snippetは空)の前になる
            expect(start?.kind, label).toBe('start');
            expect(start?.tag, label).toBe('p');
            expect(start?.snippet, label).toBe('');
            spanning += 1;
          }
        }
      }
      // 空行の途中でページが替わる場合が、実際に含まれている
      expect(spanning).toBeGreaterThanOrEqual(6);
    });

    it('空行だけで、ページが埋まる場合も、ページ数と、各ページの先頭の位置が、PDFと一致する', async () => {
      const markdown = [...filler(2), ...Array.from({ length: 70 }, () => '&nbsp;'), MARKER].join('\n\n');
      const layout = await renderer.measurePages(buildDocumentHtml(markdown, css, undefined, undefined, { tagBlocks: true }));
      const path = writePdf('blank-span-pages.pdf', await renderer.render(buildDocumentHtml(markdown, css)));
      expect(layout.pages).toBeGreaterThanOrEqual(3);
      expect(layout.pages).toBe(pagesOf(path));
      expect(layout.starts.map((start) => start.page)).toEqual(Array.from({ length: layout.pages - 1 }, (_, index) => index + 2));
    });
  });
});

describe('コードの色分け(実Chromium)', () => {
  // キーワードの色(#c22b3d)に近い、赤い点。見出し・本文・背景(灰色)・コードの文字色(黒に近い)には現れない色
  const isKeywordRed = (r: number, g: number, b: number): boolean => r > 150 && g < 100 && b < 110;

  it('言語名のあるコードブロックは、PDFで色が付く。言語名の無いコードブロックは、色が付かない', async () => {
    const code = 'def greet(name):\n    return "こんにちは"\n';
    const colored = writePdf('code-colored.pdf', await renderer.render(buildDocumentHtml('```python\n' + code + '```', css)));
    const plain = writePdf('code-plain.pdf', await renderer.render(buildDocumentHtml('```\n' + code + '```', css)));

    expect(countPixels(colored, isKeywordRed)).toBeGreaterThan(20);
    expect(countPixels(plain, isKeywordRed)).toBe(0);
    // 色分けしても、コードの文字は、抽出できる(フォントごとに分かれて、順序は入れ替わりうる)
    const text = poppler('pdftotext', colored, '-');
    expect(text).toContain('def greet(name):');
    expect(text).toContain('こんにちは');
  });

  it.each(['javascript', 'bash', 'sql', 'java', 'go', 'rust', 'ruby', 'php', 'kotlin', 'html', 'css', 'yaml'])(
    '%s のコードブロックも、PDFで色が付く',
    async (language) => {
      const code: Record<string, string> = {
        javascript: 'const x = 1;\nfunction f() { return x; }',
        bash: 'if [ -f a ]; then echo "hi"; fi',
        sql: 'SELECT id FROM users WHERE id = 1;',
        java: 'public class A { private int x = 1; }',
        go: 'func main() { var x int = 1 }',
        rust: 'fn main() { let x: i32 = 1; }',
        ruby: 'def hello\n  puts "hi"\nend',
        php: '<?php function f() { return 1; }',
        kotlin: 'fun main() { val x = 1 }',
        html: '<div class="a">x</div>',
        css: '@media print { .a { color: red; } }',
        yaml: 'key: value\nlist:\n  - 1',
      };
      const path = writePdf(`code-${language}.pdf`, await renderer.render(buildDocumentHtml('```' + language + '\n' + code[language] + '\n```', css)));
      // 色が付いた点があること(キーワード・文字列・数値などの、赤・青・紫・緑・橙のいずれか)
      const colored = countPixels(path, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 90);
      expect(colored).toBeGreaterThan(20);
    },
  );
});

describe('Mermaidの図(実Chromium)', () => {
  const flow = 'graph TD\n  A[開始] --> B{判定}\n  B -->|はい| C[処理]\n  B -->|いいえ| D[終了]';

  const diagramsOf = async (markdown: string): Promise<DiagramMap> => {
    const sources = extractMermaidSources(markdown);
    const drawn = await renderer.drawDiagrams(sources);
    return new Map(sources.map((source, index) => [source, drawn[index] as NonNullable<(typeof drawn)[number]>]));
  };

  it('図のコードをSVGにする。結果は、渡した順に返る', async () => {
    const [flowchart, sequence, pie] = await renderer.drawDiagrams([flow, 'sequenceDiagram\n  Alice->>Bob: こんにちは', 'pie title ペット\n  "犬" : 3\n  "猫" : 5']);
    for (const outcome of [flowchart, sequence, pie]) {
      expect(outcome?.ok).toBe(true);
    }
    expect(flowchart?.ok === true && flowchart.svg).toContain('開始');
    expect(sequence?.ok === true && sequence.svg).toContain('Alice');
    expect(pie?.ok === true && pie.svg).toContain('犬');
  });

  it('描けない図(構文の誤り・図の種類が不明)は、理由つきの失敗になり、ほかの図は描かれる', async () => {
    const results = await renderer.drawDiagrams([flow, 'graph TD\n  A[ --> B', 'これは図ではありません', 'pie\n  "a" : 1']);
    expect(results.map((result) => result.ok)).toEqual([true, false, false, true]);
    const failures = results.flatMap((result) => (result.ok ? [] : [result.message]));
    expect(failures).toHaveLength(2);
    expect(failures.every((message) => message.length > 0 && !message.includes('\n'))).toBe(true);
  });

  it('図が無ければ、何も起動せず空の結果を返す', async () => {
    expect(await renderer.drawDiagrams([])).toEqual([]);
  });

  it('図の文字に含まれるHTML・スクリプト・リンクは、実行される形では出力されない', async () => {
    const [outcome] = await renderer.drawDiagrams([
      'graph TD\n  A["<img src=x onerror=alert(1)>文字<script>alert(2)</script>"] --> B\n  click A href "javascript:alert(3)"\n  click B call alert(4)',
    ]);
    expect(outcome?.ok).toBe(true);
    const svg = outcome?.ok === true ? outcome.svg : '';
    // <img>の文字は、無害な形(onerror等の属性なし)で残ることがある。実行される属性・スクリプト・リンクが無いことを確かめる
    expect(svg).not.toMatch(/<script|onerror=|javascript:|onclick=|onload=/i);
  });

  it('図の中から、安全設定を緩めることはできない(initディレクティブでsecurityLevelを変えても、スクリプトは出力されない)', async () => {
    const [outcome] = await renderer.drawDiagrams([
      '%%{init: {"securityLevel": "loose"}}%%\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n  click A href "javascript:alert(3)"',
    ]);
    const svg = outcome?.ok === true ? outcome.svg : '';
    expect(svg).not.toMatch(/onerror=|javascript:/i);
  });

  it('図の描画では、外部へ通信しない', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      await renderer.drawDiagrams([`graph TD\n  A["<img src='http://127.0.0.1:${port}/x.png'>"] --> B\n  A --> C["<a href='http://127.0.0.1:${port}/y'>y</a>"]`]);
      expect(requested).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('Markdownの図は、PDFに入る(日本語の文字も、図の中に抽出できる)。コードはPDFに出ない', async () => {
    const markdown = `# 図のある文書\n\n本文です。\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\n続きの文です。`;
    const path = writePdf('diagram.pdf', await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));

    const text = poppler('pdftotext', path, '-');
    for (const label of ['開始', '判定', '処理', '終了', 'はい', 'いいえ', '続きの文です']) {
      expect(text, label).toContain(label);
    }
    expect(text).not.toContain('graph TD');
    expect(poppler('pdffonts', path)).toContain('NotoSansCJKjp');
    // 図の中の色(薄い紫の箱)が、実際に描かれている
    expect(countPixels(path, isDiagramFill)).toBeGreaterThan(500);
  });

  it('表示の選択: 図のみはコードがPDFに出ず、コードのみは図が出ず、両方は両方が出る', async () => {
    const pdfOf = async (meta: string): Promise<string> => {
      const markdown = `\`\`\`mermaid${meta}\n${flow}\n\`\`\``;
      return writePdf(`diagram-view${meta.replace(/\W/g, '')}.pdf`, await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));
    };
    const diagramPixels = (path: string): number => countPixels(path, isDiagramFill);

    const diagramOnly = await pdfOf('');
    expect(poppler('pdftotext', diagramOnly, '-')).not.toContain('graph TD');
    expect(diagramPixels(diagramOnly)).toBeGreaterThan(500);

    const codeOnly = await pdfOf(' show=code');
    expect(poppler('pdftotext', codeOnly, '-')).toContain('graph TD');
    expect(diagramPixels(codeOnly)).toBe(0);

    const both = await pdfOf(' show=both');
    expect(poppler('pdftotext', both, '-')).toContain('graph TD');
    expect(diagramPixels(both)).toBeGreaterThan(500);
  });

  it('描けなかった図は、コードと理由がPDFに入り、PDFの生成は成功する', async () => {
    const markdown = '# 誤った図\n\n```mermaid\ngraph TD\n  A[ --> B\n```';
    const path = writePdf('diagram-broken.pdf', await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));

    const text = poppler('pdftotext', path, '-');
    expect(text).toContain('Mermaidの図を描画できなかったため、コードのまま表示します');
    expect(text).toContain('graph TD');
  });

  it('縦長の図は、1ページに収まる大きさに縮めて表示される', async () => {
    const steps = Array.from({ length: 40 }, (_, index) => `  S${index}[Step${index}] --> S${index + 1}[Step${index + 1}]`).join('\n');
    const markdown = `# 長い図\n\n\`\`\`mermaid\ngraph TD\n${steps}\n\`\`\``;
    const path = writePdf('diagram-tall.pdf', await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));

    // 縮めて描かれた小さな文字は、1つの語として抽出されない場合があるため、図が入っていることだけを確かめる
    expect(poppler('pdftotext', path, '-')).toContain('Step');
    expect(Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1])).toBe(1);
  });

  it('縦長の図は、用紙の向きや余白が違っても(A4横・A4横で余白が広い・B5縦)、1ページに収まる大きさに縮めて表示される', async () => {
    const steps = Array.from({ length: 40 }, (_, index) => `  S${index}[Step${index}] --> S${index + 1}[Step${index + 1}]`).join('\n');
    const markdown = `# 長い図\n\n\`\`\`mermaid\ngraph TD\n${steps}\n\`\`\``;
    const diagrams = await diagramsOf(markdown);
    for (const settings of [
      { ...DEFAULT_PAGE_SETTINGS, orientation: 'landscape' },
      { ...DEFAULT_PAGE_SETTINGS, orientation: 'landscape', margin: 'wide' },
      { ...DEFAULT_PAGE_SETTINGS, paper: 'B5' },
    ] as const) {
      const path = writePdf(`diagram-tall-${settings.paper}-${settings.orientation}-${settings.margin}.pdf`, await renderer.render(buildDocumentHtml(markdown, css, undefined, diagrams, { pageSettings: settings }), { pageSettings: settings }));
      expect(poppler('pdftotext', path, '-'), JSON.stringify(settings)).toContain('Step');
      expect(Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]), JSON.stringify(settings)).toBe(1);
    }
  });

  it('JS無効のままPDFが作られる(図を作るためにJSを有効にするのは、図の描画用のページだけ)', async () => {
    const html = '<!doctype html><html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script></body></html>';
    await renderer.drawDiagrams([flow]);
    const text = poppler('pdftotext', writePdf('script-after-diagram.pdf', await renderer.render(html)), '-');
    expect(text).toContain('前');
    expect(text).not.toContain('実行された');
  });
});

describe('HTMLのPDF生成(実Chromium)', () => {
  // サーバと同じく、安全対策を加えたHTMLを、用紙サイズの指定を尊重して描画する
  const renderHtml = (html: string, name: string): Promise<string> =>
    renderer.render(prepareHtmlForPdf(html), { preferCssPageSize: true }).then((pdf) => writePdf(name, pdf));

  it('利用者のHTMLとCSS(日本語・色・表)が、そのままPDFになる(既定はA4)', async () => {
    const html =
      '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>案内</title><style>h1{color:#c00}td{border:1px solid #000}</style></head>' +
      '<body><h1>お知らせ</h1><p>本日は<b>休業</b>です。</p><table><tr><td>項目</td><td>内容</td></tr></table></body></html>';
    const path = await renderHtml(html, 'html-basic.pdf');

    expect(readFileSync(path).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(poppler('pdfinfo', path)).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    expect(poppler('pdffonts', path)).toContain('NotoSansCJKjp');
    const text = poppler('pdftotext', path, '-');
    expect(text).toContain('お知らせ');
    expect(text).toContain('休業');
    expect(text).toContain('項目');
    // Markdown用の共有CSS(.document)は、利用者のHTMLには適用されない
    expect(text).toMatch(/1\s*\/\s*1/);
  });

  it('CSSの @page で用紙サイズを指定すると、その大きさのPDFになる', async () => {
    const html = '<!DOCTYPE html><html><head><style>@page { size: A5 landscape; }</style></head><body><p>横向きのA5</p></body></html>';
    const info = poppler('pdfinfo', await renderHtml(html, 'html-a5.pdf'));
    // A5の横向き(210mm x 148mm)
    expect(info).toMatch(/Page size:\s+59\d(\.\d+)? x 4[12]\d(\.\d+)? pts \(A5\)/);
  });

  it('data URIの画像はPDFに表示される', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const path = await renderHtml(`<!DOCTYPE html><body><p>画像</p><img src="data:image/png;base64,${png}" width="80" height="80"></body>`, 'html-img.pdf');
    expect(poppler('pdfimages', '-list', path)).toMatch(/\bimage\b/);
  });

  it('外部リソースへは通信しない(画像・CSS・フォント・メタリフレッシュの参照先がローカルのサーバでも、アクセスが発生しない)', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    try {
      const html =
        `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${origin}/refresh"><link rel="stylesheet" href="${origin}/a.css">` +
        `<style>@import url(${origin}/b.css); @font-face{font-family:x;src:url(${origin}/f.woff)} p{background:url(${origin}/bg.png);font-family:x}</style></head>` +
        `<body><img src="${origin}/img.png"><iframe src="${origin}/frame"></iframe><p>本文は残る</p></body></html>`;
      const path = await renderHtml(html, 'html-external.pdf');

      expect(requested).toEqual([]);
      // 遮断された移動先のエラーページではなく、利用者の文書がPDFになる
      expect(poppler('pdftotext', path, '-')).toContain('本文は残る');
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('スクリプトは実行されない(イベント属性も含む)', async () => {
    const html =
      '<!DOCTYPE html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script>' +
      '<img src="x" onerror="document.getElementById(\'t\').textContent=\'実行された\'"></body>';
    const text = poppler('pdftotext', await renderHtml(html, 'html-script.pdf'), '-');
    expect(text).toContain('前');
    expect(text).not.toContain('実行された');
  });
});

describe('起動時セルフチェック', () => {
  it('Chromiumの版を返す', async () => {
    const { chromium } = await selfCheck(renderer, css);
    expect(chromium).toMatch(/Chrom(e|ium)\/\d+/);
  });

  it('レンダラがPDFを返さなければ例外にする', async () => {
    const broken: PdfRenderer = {
      chromiumVersion: () => Promise.resolve('x'),
      render: () => Promise.resolve(Buffer.from('not a pdf')),
      drawDiagrams: () => Promise.resolve([]),
      measurePages: () => Promise.resolve({ pages: 1, blocks: [], starts: [] }),
    };
    await expect(selfCheck(broken, css)).rejects.toThrowError('生成物がPDFではありません');
  });

  it('Mermaidの図を描画できなければ例外にする', async () => {
    const broken: PdfRenderer = {
      chromiumVersion: () => Promise.resolve('x'),
      render: () => Promise.resolve(Buffer.from('%PDF-1.7')),
      drawDiagrams: () => Promise.resolve([{ ok: false, message: 'Mermaidが読み込めません' }]),
      measurePages: () => Promise.resolve({ pages: 1, blocks: [], starts: [] }),
    };
    await expect(selfCheck(broken, css)).rejects.toThrowError('Mermaidの図を描画できません (Mermaidが読み込めません)');
  });
});
