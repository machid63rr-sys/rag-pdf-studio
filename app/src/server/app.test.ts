import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiagramOutcome } from '../shared/mermaid.js';
import type { PageLayout } from '../shared/pageLayout.js';
import { DEFAULT_PAGE_SETTINGS, type PageSettings } from '../shared/pageSettings.js';
import { createApp } from './app.js';
import { PdfRenderError, type PdfRenderer, type RenderOptions } from './pdf.js';

// PDF生成そのものはtests/pdf.integration.test.tsで実Chromiumを使って検証する。
// ここではHTTP層(検証・エラー応答・配信)だけを確認するため、呼び出し内容を記録する代役を使う
class RecordingRenderer implements PdfRenderer {
  readonly htmls: string[] = [];
  readonly options: (RenderOptions | undefined)[] = [];
  // 図の描画を頼まれた、Mermaidのコード(呼び出しごと)
  readonly drawn: (readonly string[])[] = [];
  // ページの区切りの測定を頼まれた、HTML(呼び出しごと)と、そのときのページ設定
  readonly measured: string[] = [];
  readonly measuredSettings: (PageSettings | undefined)[] = [];
  failWith: Error | undefined;

  render(html: string, options?: RenderOptions): Promise<Buffer> {
    this.htmls.push(html);
    this.options.push(options);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(Buffer.from('%PDF-1.7 dummy'));
  }

  // 「ok」を含むコードは描け、それ以外は構文エラーになる代役
  drawDiagrams(sources: readonly string[]): Promise<DiagramOutcome[]> {
    this.drawn.push(sources);
    return Promise.resolve(
      sources.map((source): DiagramOutcome => (source.includes('ok') ? { ok: true, svg: '<svg viewBox="0 0 10 20"></svg>' } : { ok: false, message: 'Parse error' })),
    );
  }

  measurePages(html: string, settings?: PageSettings): Promise<PageLayout> {
    this.measured.push(html);
    this.measuredSettings.push(settings);
    return this.failWith
      ? Promise.reject(this.failWith)
      : Promise.resolve({ pages: 2, starts: [{ kind: 'start', page: 2, block: 1, tag: 'p', snippet: '本文' }] });
  }

  chromiumVersion(): Promise<string> {
    return Promise.resolve('Chromium/test');
  }
}

const MAX_BYTES = 200;
const renderer = new RecordingRenderer();
let clientDir: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  clientDir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>t</title>');
  const app = createApp({ maxMarkdownBytes: MAX_BYTES, renderer, css: '.document{}', clientDir, chromiumVersion: 'Chromium/test' });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(clientDir, { recursive: true, force: true });
});

const postPdf = (body: string, contentType = 'application/json'): Promise<Response> =>
  fetch(`${baseUrl}/api/pdf`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
const postLayout = (markdown: string): Promise<Response> =>
  fetch(`${baseUrl}/api/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }) });

describe('GET /healthz', () => {
  it('okとChromiumの版を返す', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', chromium: 'Chromium/test' });
  });
});

describe('POST /api/pdf', () => {
  it('Markdownを渡すとPDFを返し、共有CSSを含むHTMLがレンダラへ渡る', async () => {
    renderer.htmls.length = 0;
    const res = await postPdf(JSON.stringify({ markdown: '# 見出し\n\n本文' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(renderer.htmls).toHaveLength(1);
    expect(renderer.htmls[0]).toContain('<h1>見出し</h1>');
    expect(renderer.htmls[0]).not.toContain('data-block');
    expect(renderer.htmls[0]).toContain('.document{}');
  });

  it('HTMLを渡すとPDFを返し、安全対策を加えたHTMLがレンダラへ渡る(Markdown用の共有CSSは加えない)', async () => {
    renderer.htmls.length = 0;
    renderer.options.length = 0;
    const res = await postPdf(JSON.stringify({ html: '<!DOCTYPE html><html><head><title>t</title></head><body><h1 class="x">見出し</h1></body></html>' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(renderer.htmls).toHaveLength(1);
    expect(renderer.htmls[0]).toContain('<h1 class="x">見出し</h1>');
    expect(renderer.htmls[0]).toContain('Content-Security-Policy');
    expect(renderer.htmls[0]).not.toContain('.document{}');
    // 利用者のHTMLが指定する用紙サイズ(@page)を尊重する(ページ設定は、省略すれば既定)
    expect(renderer.options[0]).toEqual({ preferCssPageSize: true, pageSettings: DEFAULT_PAGE_SETTINGS });
  });

  describe('POST /api/layout(ページの区切りの測定)', () => {
    it('Markdownを渡すと、測った結果をJSONで返し、PDFと同じ文書(共有CSSつき)が測定に渡る', async () => {
      renderer.measured.length = 0;
      const res = await postLayout('# 見出し\n\n本文');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ pages: 2, starts: [{ kind: 'start', page: 2, block: 1, tag: 'p', snippet: '本文' }] });
      expect(renderer.measured).toHaveLength(1);
      // 測る文書の最上位のブロックには、Markdownでの番号が付く(PDFの文書には付かない)
      expect(renderer.measured[0]).toContain('<h1 data-block="0">見出し</h1>');
      expect(renderer.measured[0]).toContain('<p data-block="1">本文</p>');
      expect(renderer.measured[0]).toContain('.document{}');
    });

    it('画像(baseDir・assets)つきのMarkdownも、PDFと同じように、画像を含む文書で測る', async () => {
      renderer.measured.length = 0;
      const dataUri = 'data:image/png;base64,iVBORw==';
      await fetch(`${baseUrl}/api/layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '![図](img/a.png)', baseDir: 'docs', assets: { 'docs/img/a.png': dataUri } }),
      });
      expect(renderer.measured[0]).toContain(`<img src="${dataUri}" alt="図">`);
    });

    it('HTMLは測れず、400', async () => {
      const res = await fetch(`${baseUrl}/api/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '<p>a</p>' }) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    });

    it.each([
      ['空のMarkdown', { markdown: '  ' }, 400],
      ['markdownもhtmlも無い', {}, 400],
      ['大きすぎる', { markdown: 'あ'.repeat(MAX_BYTES) }, 413],
    ])('不正なリクエスト(%s)は、PDFと同じ検証で断る', async (_label, body, status) => {
      renderer.measured.length = 0;
      const res = await fetch(`${baseUrl}/api/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(status);
      expect(renderer.measured).toEqual([]);
    });

    it('測定に失敗したら、500とメッセージを返す', async () => {
      renderer.failWith = new PdfRenderError('ページの区切りを測れませんでした: x');
      try {
        const res = await postLayout('# a');
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: 'pdf_failed', message: 'ページの区切りを測れませんでした: x' });
      } finally {
        renderer.failWith = undefined;
      }
    });
  });

  describe('Mermaidの図', () => {
    const post = (markdown: string): Promise<Response> => postPdf(JSON.stringify({ markdown }));

    it('図があれば、描画を依頼し、描けた図がPDFのHTMLに入る', async () => {
      renderer.htmls.length = 0;
      renderer.drawn.length = 0;
      const res = await post('```mermaid\ngraph ok 1\n```');
      expect(res.status).toBe(200);
      expect(renderer.drawn).toEqual([['graph ok 1']]);
      expect(renderer.htmls[0]).toContain('<figure class="mermaid-diagram">');
    });

    it('描けなかった図があっても、PDFは返し、コードのまま理由を添える', async () => {
      renderer.htmls.length = 0;
      const res = await post('```mermaid\nbad diagram\n```');
      expect(res.status).toBe(200);
      expect(renderer.htmls[0]).toContain('diagram-error');
      expect(renderer.htmls[0]).toContain('language-mermaid');
    });

    it('同じ図は1回だけ描画を依頼する', async () => {
      renderer.drawn.length = 0;
      await post('```mermaid\ngraph ok 2\n```\n\n```mermaid\ngraph ok 2\n```');
      expect(renderer.drawn).toEqual([['graph ok 2']]);
    });

    it('描いた図は覚えておき、同じ図は、PDFの生成やページの区切りの測定を重ねても、描き直さない(描けなかった図も)', async () => {
      renderer.drawn.length = 0;
      renderer.htmls.length = 0;
      const markdown = '```mermaid\ngraph ok 5\n```\n\n```mermaid\nbad diagram 5\n```';
      await post(markdown);
      await postLayout(markdown);
      await post(markdown);
      expect(renderer.drawn).toEqual([['graph ok 5', 'bad diagram 5']]);
      // 新しい図が加われば、その図だけを描く
      await post(`${markdown}\n\n\`\`\`mermaid\ngraph ok 6\n\`\`\``);
      expect(renderer.drawn).toEqual([['graph ok 5', 'bad diagram 5'], ['graph ok 6']]);
      expect(renderer.htmls.at(-1)?.match(/<figure/g)).toHaveLength(2);
    });

    it('図が無ければ、描画を依頼しない(ブラウザを余計に起動しない)', async () => {
      renderer.drawn.length = 0;
      await post('# 見出し\n\n```python\nx = 1\n```');
      expect(renderer.drawn).toEqual([]);
    });

    it('コードのみ(show=code)の図は、描画を依頼しない。両方(show=both)は描いて、コードと図が入る', async () => {
      renderer.htmls.length = 0;
      renderer.drawn.length = 0;
      await post('```mermaid show=code\ngraph ok 3\n```');
      expect(renderer.drawn).toEqual([]);
      expect(renderer.htmls[0]).toContain('<pre><code class="language-mermaid">graph ok 3');
      expect(renderer.htmls[0]).not.toContain('<figure');

      await post('```mermaid show=both\ngraph ok 4\n```');
      expect(renderer.drawn).toEqual([['graph ok 4']]);
      expect(renderer.htmls[1]).toContain('<pre>');
      expect(renderer.htmls[1]).toContain('<figure');
    });

    it('HTMLの場合は、図の描画を依頼しない', async () => {
      renderer.drawn.length = 0;
      await postPdf(JSON.stringify({ html: '<pre><code class="language-mermaid">graph ok</code></pre>' }));
      expect(renderer.drawn).toEqual([]);
    });

    it('図が多すぎる場合は、上限までを描き、残りはコードのまま表示する', async () => {
      const roomy = createApp({ maxMarkdownBytes: 1_000_000, renderer, css: '', clientDir, chromiumVersion: 'Chromium/test' });
      const roomyServer = await new Promise<Server>((resolve) => {
        const started = roomy.listen(0, '127.0.0.1', () => resolve(started));
      });
      try {
        renderer.htmls.length = 0;
        renderer.drawn.length = 0;
        const { port } = roomyServer.address() as AddressInfo;
        const markdown = Array.from({ length: 31 }, (_, index) => '```mermaid\ngraph ok ' + index + '\n```').join('\n\n');
        const res = await fetch(`http://127.0.0.1:${port}/api/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown }),
        });
        expect(res.status).toBe(200);
        expect(renderer.drawn[0]).toHaveLength(30);
        expect(renderer.htmls[0]?.match(/<figure/g)).toHaveLength(30);
        expect(renderer.htmls[0]).toContain('図が多すぎるため描画しません(上限 30 個)');
      } finally {
        await new Promise<void>((resolve, reject) => roomyServer.close((error) => (error ? reject(error) : resolve())));
      }
    });
  });

  it('Markdownに添えた画像(baseDir・assets)が、相対パスの画像として表示される', async () => {
    renderer.htmls.length = 0;
    const dataUri = 'data:image/png;base64,iVBORw==';
    const res = await postPdf(JSON.stringify({ markdown: '![図](img/a.png)', baseDir: 'docs', assets: { 'docs/img/a.png': dataUri } }));
    expect(res.status).toBe(200);
    expect(renderer.htmls[0]).toContain(`<img src="${dataUri}" alt="図">`);
  });

  it.each([
    ['baseDirだけ(assetsなし)', { markdown: '# a', baseDir: '' }],
    ['assetsだけ(baseDirなし)', { markdown: '# a', assets: {} }],
    ['assetsが配列', { markdown: '# a', baseDir: '', assets: [] }],
    ['assetsの値が文字列でない', { markdown: '# a', baseDir: '', assets: { 'a.png': 1 } }],
    ['baseDirが文字列でない', { markdown: '# a', baseDir: 1, assets: {} }],
    ['HTMLにassets', { html: '<p>a</p>', baseDir: '', assets: {} }],
  ])('画像の指定が不正(%s)なら400', async (_label, body) => {
    const res = await postPdf(JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('画像(assets)が多すぎる場合は400(本文の上限に収まる大きさでも、個数で制限する)', async () => {
    const roomy = createApp({ maxMarkdownBytes: 1_000_000, renderer, css: '', clientDir, chromiumVersion: 'Chromium/test' });
    const roomyServer = await new Promise<Server>((resolve) => {
      const started = roomy.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const { port } = roomyServer.address() as AddressInfo;
      const assets = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`${index}.png`, 'x']));
      const res = await fetch(`http://127.0.0.1:${port}/api/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: '# a', baseDir: '', assets }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    } finally {
      await new Promise<void>((resolve, reject) => roomyServer.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('Markdownの場合は、用紙サイズの指定(@page)を尊重しない(ページ設定は、省略すれば既定のA4縦)', async () => {
    renderer.options.length = 0;
    await postPdf(JSON.stringify({ markdown: '# a' }));
    expect(renderer.options[0]).toEqual({ pageSettings: DEFAULT_PAGE_SETTINGS });
  });

  describe('ページ設定(pageSettings)', () => {
    const custom: PageSettings = { paper: 'B5', orientation: 'landscape', margin: 'narrow', pageNumbers: false };
    const bodyOf = (markdown: string, pageSettings?: unknown): string => JSON.stringify({ markdown, ...(pageSettings === undefined ? {} : { pageSettings }) });

    it('Markdown: PDFを作るレンダラへ、そのまま渡る', async () => {
      renderer.options.length = 0;
      expect((await postPdf(bodyOf('# a', custom))).status).toBe(200);
      expect(renderer.options[0]).toEqual({ pageSettings: custom });
    });

    it('HTML: 用紙・余白は、文書のCSSが優先するが、設定(ページ番号の有無)は、レンダラへ渡る', async () => {
      renderer.options.length = 0;
      expect((await postPdf(JSON.stringify({ html: '<p>a</p>', pageSettings: custom }))).status).toBe(200);
      expect(renderer.options[0]).toEqual({ preferCssPageSize: true, pageSettings: custom });
    });

    it('ページの区切りの測定にも、同じ設定が渡る(省略すれば既定)', async () => {
      renderer.measuredSettings.length = 0;
      await fetch(`${baseUrl}/api/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyOf('# a', custom) });
      await postLayout('# a');
      expect(renderer.measuredSettings).toEqual([custom, DEFAULT_PAGE_SETTINGS]);
    });

    it('文書のHTMLに、用紙の本文の高さ(縦長の図を1ページに収めるための --page-body-height)が入る', async () => {
      renderer.htmls.length = 0;
      await postPdf(bodyOf('# a'));
      await postPdf(bodyOf('# a', { paper: 'A4', orientation: 'landscape', margin: 'standard', pageNumbers: true }));
      await postPdf(bodyOf('# a', { paper: 'A3', orientation: 'portrait', margin: 'wide', pageNumbers: true }));
      expect(renderer.htmls[0]).toContain('--page-body-height:252mm');
      expect(renderer.htmls[1]).toContain('--page-body-height:165mm');
      expect(renderer.htmls[2]).toContain('--page-body-height:365mm');
    });

    it.each([
      ['用紙が一覧に無い', { paper: 'A5', orientation: 'portrait', margin: 'standard', pageNumbers: true }],
      ['向きが一覧に無い', { paper: 'A4', orientation: 'diagonal', margin: 'standard', pageNumbers: true }],
      ['余白が一覧に無い', { paper: 'A4', orientation: 'portrait', margin: '10mm', pageNumbers: true }],
      ['ページ番号が真偽値でない', { paper: 'A4', orientation: 'portrait', margin: 'standard', pageNumbers: 'yes' }],
      ['項目が足りない', { paper: 'A4', orientation: 'portrait', margin: 'standard' }],
      ['オブジェクトでない(文字列)', 'A4'],
      ['オブジェクトでない(配列)', ['A4']],
      ['null', null],
    ])('不正な設定(%s)は、400で断り、PDFを作らない', async (_label, pageSettings) => {
      renderer.htmls.length = 0;
      const res = await postPdf(JSON.stringify({ markdown: '# a', pageSettings }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
      expect(renderer.htmls).toEqual([]);
    });
  });

  it.each([
    ['htmlが文字列でない', JSON.stringify({ html: 1 }), 400, 'invalid_request'],
    ['htmlが空白だけ', JSON.stringify({ html: ' \n ' }), 400, 'empty_html'],
    ['markdownとhtmlの両方を指定', JSON.stringify({ markdown: '# a', html: '<p>a</p>' }), 400, 'invalid_request'],
    ['htmlが上限を超える', JSON.stringify({ html: `<p>${'あ'.repeat(MAX_BYTES / 3 + 1)}</p>` }), 413, 'html_too_large'],
  ])('%sなら%i', async (_label, body, status, code) => {
    const res = await postPdf(body);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it.each([
    ['markdownが無い', JSON.stringify({}), 'invalid_request'],
    ['markdownが文字列でない', JSON.stringify({ markdown: 1 }), 'invalid_request'],
    ['markdownが空白だけ', JSON.stringify({ markdown: '  \n ' }), 'empty_markdown'],
  ])('%sなら400', async (_label, body, code) => {
    const res = await postPdf(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it('JSONとして壊れていれば400', async () => {
    const res = await postPdf('{broken');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_json');
  });

  it('JSON以外のContent-Typeは、本文を解釈せず400', async () => {
    const res = await postPdf('# 見出し', 'text/plain');
    expect(res.status).toBe(400);
  });

  it('上限(バイト数)を超えると413。日本語は文字数ではなくバイト数で数える', async () => {
    const res = await postPdf(JSON.stringify({ markdown: 'あ'.repeat(MAX_BYTES / 3 + 1) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('markdown_too_large');
  });

  it('パース上限そのものを超える巨大なリクエストも413', async () => {
    const res = await postPdf(JSON.stringify({ markdown: 'a'.repeat(MAX_BYTES * 3) }));
    expect(res.status).toBe(413);
  });

  it('PDF生成に失敗したら500でメッセージを返し、原因をログに残す(空のPDFを返さない)', async () => {
    renderer.failWith = new PdfRenderError('PDFの生成に失敗しました: テスト');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await postPdf(JSON.stringify({ markdown: '# a' }));
      expect(res.status).toBe(500);
      const error = ((await res.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe('pdf_failed');
      expect(error.message).toContain('テスト');
      expect(errorLog).toHaveBeenCalledWith(renderer.failWith);
    } finally {
      errorLog.mockRestore();
      renderer.failWith = undefined;
    }
  });

  it('想定外の例外は内部エラーとして500にし、詳細は応答に含めずログにだけ残す', async () => {
    renderer.failWith = new Error('秘密のパス /etc/shadow');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await postPdf(JSON.stringify({ markdown: '# a' }));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain('internal_error');
      expect(text).not.toContain('/etc/shadow');
      expect(errorLog).toHaveBeenCalledWith(renderer.failWith);
    } finally {
      errorLog.mockRestore();
      renderer.failWith = undefined;
    }
  });
});

describe('配信', () => {
  it('/ でクライアントを配信し、セキュリティヘッダが付く', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self' data: blob:");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('未定義の /api/* は404のJSON', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('/api/rag (OCR・RAGサービスへの中継)', () => {
  it('OCR_RAG_URLが設定されていない場合は、404ではなく「設定されていない」ことを503で返す', async () => {
    const response = await fetch(`${baseUrl}/api/rag/documents`);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('rag_not_configured');
  });
});
