import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPdfRenderer } from './pdf.js';
import { selfCheck } from './selfCheck.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const css = readFileSync(new URL('./document.css', import.meta.url), 'utf8');
  const mermaidScript = readFileSync(new URL('./mermaid.min.js', import.meta.url), 'utf8');
  const renderer = createPdfRenderer({ chromiumPath: config.chromiumPath, timeoutMs: config.pdfTimeoutMs, mermaidScript });

  // 壊れた状態で起動し続けないよう、起動時に実際にPDFを1本生成して確認する
  const { chromium } = await selfCheck(renderer, css);
  console.log(`起動時セルフチェックOK (Chromium: ${chromium})`);

  const app = createApp({
    maxMarkdownBytes: config.maxMarkdownBytes,
    renderer,
    css,
    clientDir: fileURLToPath(new URL('../client', import.meta.url)),
    chromiumVersion: chromium,
    ...(config.rag === null ? {} : { rag: config.rag }),
  });
  console.log(config.rag === null ? 'OCR・RAGサービス: 未設定(OCR_RAG_URL)。PDF生成だけが使えます' : `OCR・RAGサービス: ${config.rag.upstream.origin} へ中継します`);
  const server = app.listen(config.port, config.host, () => {
    console.log(`rag-pdf-studio: http://${config.host}:${config.port} で待ち受け中`);
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} を受信したため停止します`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((cause: unknown) => {
  console.error('起動に失敗しました:', cause);
  process.exit(1);
});
