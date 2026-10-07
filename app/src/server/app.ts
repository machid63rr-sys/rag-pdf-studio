import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type Response } from 'express';
import type { DiagramOutcome } from '../shared/mermaid.js';
import { DEFAULT_PAGE_SETTINGS, parsePageSettings, type PageSettings } from '../shared/pageSettings.js';
import { sendError } from './apiError.js';
import type { RagConfig } from './config.js';
import { prepareHtmlForPdf } from './htmlDocument.js';
import { buildDocumentHtml, extractMermaidSources, type DiagramMap, type MarkdownAssets, type RenderOptions } from './markdownToHtml.js';
import { PdfRenderError, type PdfRenderer } from './pdf.js';
import { createRagProxy, ragNotConfigured } from './ragProxy.js';

export interface AppDependencies {
  // MarkdownまたはHTMLの最大バイト数(UTF-8換算)
  readonly maxMarkdownBytes: number;
  readonly renderer: PdfRenderer;
  // PDFに適用する共有CSS(プレビューと同じもの)
  readonly css: string;
  // ビルド済みクライアント(dist/client)のディレクトリ
  readonly clientDir: string;
  // /healthz に表示するChromiumの版
  readonly chromiumVersion: string;
  // OCR・RAGサービスへの中継の設定。省略すると、/api/rag/* は「設定されていない」ことを返す
  readonly rag?: RagConfig;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// 画像の参照先が外部でもプレビューに出ないよう、読み込み元を自分自身とdata/blobに限る
const CONTENT_SECURITY_POLICY = "img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
}

interface PdfSource {
  readonly kind: 'markdown' | 'html';
  readonly text: string;
  // Markdownの相対パスの画像(kindがmarkdownのときだけ)
  readonly assets?: MarkdownAssets;
  // 用紙・向き・余白・ページ番号(省略されたときは、既定)。HTMLでは、ページ番号の有無だけが使われる
  readonly pageSettings: PageSettings;
}

const SOURCE_LABEL = { markdown: 'Markdown', html: 'HTML' } as const;

// 画像の数・パスの長さの上限(巨大なリクエストで、処理が重くならないように)
const MAX_ASSET_FILES = 1000;
const MAX_PATH_LENGTH = 1000;

// 1つの文書で描画するMermaidの図の数の上限(それを超える図は、コードのまま表示する)
const MAX_DIAGRAMS = 30;

const invalid = (message: string): ApiError => new ApiError(400, 'invalid_request', message);

function parseAssets(baseDir: unknown, assets: unknown): MarkdownAssets | undefined {
  if (baseDir === undefined && assets === undefined) {
    return undefined;
  }
  if (typeof baseDir !== 'string' || baseDir.length > MAX_PATH_LENGTH) {
    throw invalid('baseDir は、文字列で指定してください。');
  }
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
    throw invalid('assets は、{"パス": "data:image/…;base64,…"} の形式で指定してください。');
  }
  const entries = Object.entries(assets);
  if (entries.length > MAX_ASSET_FILES || entries.some(([path, uri]) => path.length > MAX_PATH_LENGTH || typeof uri !== 'string')) {
    throw invalid(`assets は、パス(${MAX_PATH_LENGTH}文字以内)と文字列の組を、${MAX_ASSET_FILES}個以内で指定してください。`);
  }
  return { baseDir, files: Object.fromEntries(entries) as Record<string, string> };
}

function parsePageSettingsField(value: unknown): PageSettings {
  if (value === undefined) {
    return DEFAULT_PAGE_SETTINGS;
  }
  const settings = parsePageSettings(value);
  if (settings === undefined) {
    throw invalid('pageSettings は、{"paper": "A4", "orientation": "portrait", "margin": "standard", "pageNumbers": true} の形式で、4つの項目をすべて、決められた値で指定してください。');
  }
  return settings;
}

// リクエストは {"markdown": "…"} か {"html": "…"} のどちらか一方。markdownには、画像(baseDir・assets)を添えられる。
// どちらにも、ページ設定(pageSettings。用紙・向き・余白・ページ番号)を添えられる
function parseSource(body: unknown, maxBytes: number): PdfSource {
  const { markdown, html, baseDir, assets, pageSettings } = (body ?? {}) as {
    markdown?: unknown;
    html?: unknown;
    baseDir?: unknown;
    assets?: unknown;
    pageSettings?: unknown;
  };
  if (markdown !== undefined && html !== undefined) {
    throw invalid('markdown と html は同時に指定できません。どちらか一方を指定してください。');
  }
  const kind = html !== undefined ? 'html' : 'markdown';
  const text = html !== undefined ? html : markdown;
  if (typeof text !== 'string') {
    throw invalid('リクエストは {"markdown": "<文字列>"} または {"html": "<文字列>"} の形式で指定してください。');
  }
  if (kind === 'html' && (baseDir !== undefined || assets !== undefined)) {
    throw invalid('baseDir・assets は、markdown のときだけ指定できます(HTMLは、画像を data: URI にして含めてください)。');
  }
  if (text.trim() === '') {
    throw new ApiError(400, `empty_${kind}`, `${SOURCE_LABEL[kind]}が空です。`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ApiError(413, `${kind}_too_large`, `${SOURCE_LABEL[kind]}が大きすぎます(上限 ${maxBytes} バイト)。`);
  }
  const parsedAssets = kind === 'markdown' ? parseAssets(baseDir, assets) : undefined;
  const settings = parsePageSettingsField(pageSettings);
  return parsedAssets === undefined ? { kind, text, pageSettings: settings } : { kind, text, assets: parsedAssets, pageSettings: settings };
}

// 描画した図の覚え(同じ内容の図を、何度も描き直さないため。ページの区切りの測定は、編集のたびに呼ばれる)
const MAX_CACHED_DIAGRAMS = 200;

/** Markdownの中のMermaidの図を描画する関数。図が無ければ、ブラウザを起動しない */
function createDiagramDrawer(renderer: PdfRenderer): (markdown: string) => Promise<DiagramMap | undefined> {
  const cache = new Map<string, DiagramOutcome>();
  return async (markdown) => {
    const sources = extractMermaidSources(markdown);
    if (sources.length === 0) {
      return undefined;
    }
    const limited = sources.slice(0, MAX_DIAGRAMS);
    const missing = limited.filter((source) => !cache.has(source));
    if (missing.length > 0) {
      const drawn = await renderer.drawDiagrams(missing);
      missing.forEach((source, index) => cache.set(source, drawn[index] ?? { ok: false, message: '図を描画できませんでした' }));
      while (cache.size > MAX_CACHED_DIAGRAMS) {
        cache.delete(cache.keys().next().value as string);
      }
    }
    return new Map(
      sources.map((source, index): [string, DiagramOutcome] => [
        source,
        index < MAX_DIAGRAMS ? (cache.get(source) ?? { ok: false, message: '図を描画できませんでした' }) : { ok: false, message: `図が多すぎるため描画しません(上限 ${MAX_DIAGRAMS} 個)` },
      ]),
    );
  };
}

export function createApp(deps: AppDependencies): Express {
  const drawDiagrams = createDiagramDrawer(deps.renderer);
  // MarkdownをPDFにする文書(HTML)にする。PDF生成とページの区切りの測定で、同じ文書を使う
  const markdownDocument = async (source: PdfSource, options?: RenderOptions): Promise<string> =>
    buildDocumentHtml(source.text, deps.css, source.assets, await drawDiagrams(source.text), { ...options, pageSettings: source.pageSettings });
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', chromium: deps.chromiumVersion });
  });

  // JSON表現はエスケープで本文より大きくなりうるため、本文の上限の2倍までパースを許可し、
  // 厳密な上限はバイト数で判定する
  const jsonParser = express.json({ limit: deps.maxMarkdownBytes * 2 + 1024 });

  app.post('/api/pdf', jsonParser, async (req, res) => {
    const source = parseSource(req.body, deps.maxMarkdownBytes);
    const pdf =
      source.kind === 'markdown'
        ? await deps.renderer.render(await markdownDocument(source), { pageSettings: source.pageSettings })
        : await deps.renderer.render(prepareHtmlForPdf(source.text), { preferCssPageSize: true, pageSettings: source.pageSettings });
    res.status(200).type('application/pdf').setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  // PDFにしたときの、ページの区切り位置(編集画面のプレビューに表示する)。リクエストは /api/pdf と同じ
  app.post('/api/layout', jsonParser, async (req, res) => {
    const source = parseSource(req.body, deps.maxMarkdownBytes);
    if (source.kind !== 'markdown') {
      throw invalid('ページの区切りの測定は、markdown のときだけ指定できます。');
    }
    // 画面のプレビューへ位置を対応づけるため、ブロックにMarkdownでの番号を付けて測る(PDFの見た目は変わらない)
    const layout = await deps.renderer.measurePages(await markdownDocument(source, { tagBlocks: true }), source.pageSettings);
    res.status(200).setHeader('Cache-Control', 'no-store');
    res.json(layout);
  });

  // OCR・RAG(ocr-rag、Python)への中継。画面の「PDF→OCR→MD」「RAG」が使う
  app.use('/api/rag', deps.rag === undefined ? ragNotConfigured : createRagProxy(deps.rag));

  app.use('/api', (_req, res) => {
    sendError(res, 404, 'not_found', '指定されたAPIは存在しません。');
  });

  app.use(
    express.static(deps.clientDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ApiError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      sendError(res, 413, 'markdown_too_large', `リクエストが大きすぎます(Markdown・HTMLの上限 ${deps.maxMarkdownBytes} バイト)。`);
      return;
    }
    if (type === 'entity.parse.failed') {
      sendError(res, 400, 'invalid_json', 'リクエストのJSONを解釈できません。');
      return;
    }
    if (err instanceof PdfRenderError) {
      console.error(err);
      sendError(res, 500, 'pdf_failed', err.message);
      return;
    }
    console.error(err);
    sendError(res, 500, 'internal_error', 'サーバ内部でエラーが発生しました。');
  };
  app.use(errorHandler);

  return app;
}
