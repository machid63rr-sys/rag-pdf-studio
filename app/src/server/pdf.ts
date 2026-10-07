import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { MERMAID_CONFIG, diagramErrorMessage, type DiagramOutcome } from '../shared/mermaid.js';
import type { PageLayout } from '../shared/pageLayout.js';
import { contentSizePx, DEFAULT_PAGE_SETTINGS, type PageSettings } from '../shared/pageSettings.js';
import { MEASURE_PAGES_SCRIPT } from './measureScript.js';
import { pdfOptionsFor } from './pdfOptions.js';
import { SerialQueue } from './serialQueue.js';

export class PdfRenderError extends Error {}

export interface RenderOptions {
  // 文書のCSS(@page { size: … })が指定する用紙サイズを、既定のA4より優先する(利用者のHTML用)。
  // このとき、用紙・向き・余白の設定は使わず、ページ番号の有無だけが、pageSettings に従う
  readonly preferCssPageSize?: boolean;
  // 用紙・向き・余白・ページ番号。省略すると、既定(A4縦・標準・ページ番号あり)
  readonly pageSettings?: PageSettings;
}

export interface PdfRenderer {
  render(html: string, options?: RenderOptions): Promise<Buffer>;
  // Mermaidの図をSVGにする。結果は入力と同じ順で返し、描けなかった図は、理由つきの失敗にする
  drawDiagrams(sources: readonly string[]): Promise<DiagramOutcome[]>;
  // PDFにしたとき、各ページが、文書のどこから始まるかを測る(PDFと同じ用紙・余白で分割する。Markdownから作った文書用)。
  // settings を省略すると、既定(A4縦・標準)
  measurePages(html: string, settings?: PageSettings): Promise<PageLayout>;
  chromiumVersion(): Promise<string>;
}

export interface PdfRendererOptions {
  readonly chromiumPath: string;
  readonly timeoutMs: number;
  // Mermaidの描画スクリプト(mermaid.min.js の中身)
  readonly mermaidScript: string;
}

// コンテナ内では非rootでサンドボックスを使えないため --no-sandbox で起動する。
// その代わり、描画するHTMLは「JS無効・外部通信遮断・生HTML非実行」に限定している
const LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'];

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// 外部へは一切通信させない(data: の画像だけ許可する)
async function blockExternalRequests(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url === 'about:blank') {
      void request.continue();
    } else {
      void request.abort('blockedbyclient');
    }
  });
}

/*
 * ブラウザの中で、Mermaidの図を順にSVGにする(page.evaluateで実行するため、外の変数は参照しない)。
 * 1つの図が失敗しても、ほかの図は描く。
 */
async function drawInPage(config: object, sources: string[]): Promise<({ ok: true; svg: string } | { ok: false; error: unknown })[]> {
  const mermaid = (globalThis as unknown as { mermaid: { initialize(config: object): void; render(id: string, text: string): Promise<{ svg: string }> } })
    .mermaid;
  mermaid.initialize(config);
  const results: ({ ok: true; svg: string } | { ok: false; error: unknown })[] = [];
  for (const [index, source] of sources.entries()) {
    try {
      results.push({ ok: true, svg: (await mermaid.render(`mermaid-${index}`, source)).svg });
    } catch (error) {
      // Errorオブジェクトはブラウザの外へ渡せないため、メッセージだけを取り出す
      results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch (cause) {
    console.error(`Chromiumの終了に失敗したため強制終了します: ${messageOf(cause)}`);
    browser.process()?.kill('SIGKILL');
  }
}

export function createPdfRenderer(options: PdfRendererOptions): PdfRenderer {
  const queue = new SerialQueue();

  // 常駐させず、要求ごとに起動・終了する(クラッシュや切断の後始末を持たないため)
  const launch = (): Promise<Browser> =>
    puppeteer.launch({
      executablePath: options.chromiumPath,
      headless: true,
      args: LAUNCH_ARGS,
      timeout: options.timeoutMs,
      // 描画が終わらないとき(巨大な図など)に、いつまでも待たない
      protocolTimeout: options.timeoutMs,
    });

  return {
    render(html: string, renderOptions?: RenderOptions): Promise<Buffer> {
      return queue.run(async () => {
        let browser: Browser | undefined;
        try {
          browser = await launch();
          const page = await browser.newPage();
          page.setDefaultTimeout(options.timeoutMs);
          await page.setJavaScriptEnabled(false);
          await blockExternalRequests(page);
          await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
          const pdf = await page.pdf(
            pdfOptionsFor(renderOptions?.pageSettings ?? DEFAULT_PAGE_SETTINGS, renderOptions?.preferCssPageSize ?? false, options.timeoutMs),
          );
          return Buffer.from(pdf);
        } catch (cause) {
          throw new PdfRenderError(`PDFの生成に失敗しました: ${messageOf(cause)}`, { cause });
        } finally {
          if (browser !== undefined) {
            await closeBrowser(browser);
          }
        }
      });
    },

    measurePages(html: string, settings?: PageSettings): Promise<PageLayout> {
      return queue.run(async () => {
        let browser: Browser | undefined;
        try {
          browser = await launch();
          const page = await browser.newPage();
          page.setDefaultTimeout(options.timeoutMs);
          await blockExternalRequests(page);
          // 測るためにスクリプトを実行できるようにするが、実行するのは、こちらが渡す測定用のスクリプトだけ。
          // 文書は、Markdownから作ったもの(生HTMLは、文字として表示するだけ)で、CSPでも、文書内のスクリプトを禁じている。
          // 印刷用のCSS(表の見出し行の繰り返し・行の途中で改ページしない)を、PDFと同じように効かせる
          await page.emulateMediaType('print');
          await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
          const size = contentSizePx(settings ?? DEFAULT_PAGE_SETTINGS);
          return (await page.evaluate(`${MEASURE_PAGES_SCRIPT}(${size.width}, ${size.height})`)) as PageLayout;
        } catch (cause) {
          throw new PdfRenderError(`ページの区切りを測れませんでした: ${messageOf(cause)}`, { cause });
        } finally {
          if (browser !== undefined) {
            await closeBrowser(browser);
          }
        }
      });
    },

    drawDiagrams(sources: readonly string[]): Promise<DiagramOutcome[]> {
      if (sources.length === 0) {
        return Promise.resolve([]);
      }
      return queue.run(async () => {
        let browser: Browser | undefined;
        try {
          browser = await launch();
          const page = await browser.newPage();
          page.setDefaultTimeout(options.timeoutMs);
          // 図の描画にはスクリプトが必要なため、このページだけJSを有効にする。
          // 実行されるのは、こちらが渡すMermaid本体だけ(利用者の文字は、データとして渡す)。
          // 外部通信は遮断し、図の文字に含まれるHTMLもMermaid側で無効にしている(securityLevel: strict)。
          // このページは図を作るだけで、PDFにはしない(PDFにするページは、JS無効のまま)
          await blockExternalRequests(page);
          await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', {
            waitUntil: 'load',
            timeout: options.timeoutMs,
          });
          await page.addScriptTag({ content: options.mermaidScript });
          const results = await page.evaluate(drawInPage, MERMAID_CONFIG, [...sources]);
          return results.map((result): DiagramOutcome => (result.ok ? result : { ok: false, message: diagramErrorMessage(result.error) }));
        } catch (cause) {
          throw new PdfRenderError(`図の描画に失敗しました: ${messageOf(cause)}`, { cause });
        } finally {
          if (browser !== undefined) {
            await closeBrowser(browser);
          }
        }
      });
    },

    chromiumVersion(): Promise<string> {
      return queue.run(async () => {
        let browser: Browser | undefined;
        try {
          browser = await launch();
          return await browser.version();
        } catch (cause) {
          throw new PdfRenderError(`Chromiumを起動できません: ${messageOf(cause)}`, { cause });
        } finally {
          if (browser !== undefined) {
            await closeBrowser(browser);
          }
        }
      });
    },
  };
}
