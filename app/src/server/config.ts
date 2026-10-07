/** OCR・RAGサービス(ocr-rag、Python)への中継の設定 */
export interface RagConfig {
  // ocr-ragのURL(例: http://ocr-rag:8000)
  readonly upstream: URL;
  // ocr-ragの応答を待つ時間(接続・応答が止まってからの待ち時間。ミリ秒)
  readonly timeoutMs: number;
  // 中継するアップロード(PDF・Markdown)の最大バイト数
  readonly maxUploadBytes: number;
}

export interface Config {
  readonly port: number;
  readonly host: string;
  // POST /api/pdf で受け付けるMarkdownの最大バイト数(UTF-8換算)
  readonly maxMarkdownBytes: number;
  // Chromiumの起動・描画・PDF化それぞれに適用するタイムアウト
  readonly pdfTimeoutMs: number;
  readonly chromiumPath: string;
  // OCR・RAGサービス。環境変数 OCR_RAG_URL が無い(PDF生成だけを使う)ときは null
  readonly rag: RagConfig | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';
// 文書に含まれる画像(data: URIにするため、元のファイルの約1.3倍になる)を含めた大きさ
const DEFAULT_MAX_MARKDOWN_BYTES = 30 * 1024 * 1024;
const DEFAULT_PDF_TIMEOUT_MS = 60_000;
const DEFAULT_CHROMIUM_PATH = '/usr/bin/chromium';
// OCR・RAGの登録は、チャンク数に比例して数十秒かかりうる(OCR自体はバックグラウンドで実行され、待たない)
const DEFAULT_RAG_PROXY_TIMEOUT_MS = 10 * 60_000;
// ocr-ragの上限(MAX_UPLOAD_BYTES、既定100MB)より少し大きくし、上限の判定はocr-ragに任せる
const DEFAULT_RAG_MAX_UPLOAD_BYTES = 110 * 1024 * 1024;

// 未指定ならdefault。指定されているのに不正な値は、黙ってdefaultへ戻さずエラーにする
function readPositiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error(`環境変数 ${name} は正の整数で指定してください (指定値: "${raw}")`);
  }
  return Number(raw);
}

// 未指定ならnull(OCR・RAGは使わない)。指定されているのに不正な値は、エラーにする
function readRagUrl(env: Env): URL | null {
  const raw = env['OCR_RAG_URL'];
  if (raw === undefined || raw === '') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`環境変数 OCR_RAG_URL はURLで指定してください (指定値: "${raw}")`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`環境変数 OCR_RAG_URL は http:// で始まるURLで指定してください (指定値: "${raw}")`);
  }
  return url;
}

export function loadConfig(env: Env = process.env): Config {
  const port = readPositiveInteger(env, 'PORT', DEFAULT_PORT);
  if (port > 65535) {
    throw new Error(`環境変数 PORT は 1〜65535 で指定してください (指定値: "${port}")`);
  }
  const ragUrl = readRagUrl(env);
  return {
    port,
    host: env['HOST'] || DEFAULT_HOST,
    maxMarkdownBytes: readPositiveInteger(env, 'MAX_MARKDOWN_BYTES', DEFAULT_MAX_MARKDOWN_BYTES),
    pdfTimeoutMs: readPositiveInteger(env, 'PDF_TIMEOUT_MS', DEFAULT_PDF_TIMEOUT_MS),
    chromiumPath: env['CHROMIUM_PATH'] || DEFAULT_CHROMIUM_PATH,
    rag: ragUrl === null ? null : {
      upstream: ragUrl,
      timeoutMs: readPositiveInteger(env, 'RAG_PROXY_TIMEOUT_MS', DEFAULT_RAG_PROXY_TIMEOUT_MS),
      maxUploadBytes: readPositiveInteger(env, 'RAG_MAX_UPLOAD_BYTES', DEFAULT_RAG_MAX_UPLOAD_BYTES),
    },
  };
}
