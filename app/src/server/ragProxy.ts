import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { sendError } from './apiError.js';
import type { RagConfig } from './config.js';

// 中継を許す、ocr-rag(Python)のパス。開発者向けの画面(/docs など)は中継しない
const ALLOWED_PATH = /^\/(?:ocr-drafts|documents|equipment-names|search|chat|healthz|readyz)(?:[/?]|$)/;

// 中継してはならない、接続単位のヘッダ(RFC 9110)。hostは、宛先に合わせて作り直す
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

function forwardableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));
}

/** ocr-ragが設定されていない(環境変数 OCR_RAG_URL が無い)ときの応答。黙って404にせず、設定が無いことを返す */
export const ragNotConfigured: RequestHandler = (_req, res) => {
  sendError(res, 503, 'rag_not_configured', 'OCR・RAGサービスが設定されていません(環境変数 OCR_RAG_URL)。「PDF→OCR→MD」「RAG」の機能は使えません。');
};

/**
 * /api/rag/* を、ocr-rag(Python)へそのまま中継する。
 *
 * PDF(最大約100MB)を通すため、リクエスト・レスポンスの本文は溜めずに、流して渡す。
 * アップロードの上限(maxUploadBytes)を超えるものは、ocr-ragへ渡さずに413で断る。
 * 接続できない・時間切れは、原因が分かる502/504を返す(500で握りつぶさない)。
 */
export function createRagProxy(config: RagConfig): RequestHandler {
  const { upstream, timeoutMs, maxUploadBytes } = config;
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');
  const port = upstream.port === '' ? 80 : Number(upstream.port);
  const basePath = upstream.pathname.replace(/\/+$/, '');

  return (req, res) => {
    // req.url は、マウント位置(/api/rag)を除いた、"/ocr-drafts?x=1" の形
    if (!ALLOWED_PATH.test(req.url)) {
      sendError(res, 404, 'not_found', '指定されたAPIは存在しません。');
      return;
    }

    // 413で断ったあとも、残りの本文は読み捨てる(読まずに閉じると、クライアントが413を受け取れない)
    let rejected = false;
    const rejectTooLarge = (): void => {
      if (rejected) {
        return;
      }
      rejected = true;
      req.unpipe();
      req.resume();
      sendError(res, 413, 'upload_too_large', `アップロードが大きすぎます(上限 ${Math.floor(maxUploadBytes / (1024 * 1024))}MB)。`);
    };

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      rejectTooLarge();
      return;
    }

    let timedOut = false;
    const proxyReq = httpRequest({ hostname, port, method: req.method, path: `${basePath}${req.url}`, headers: forwardableHeaders(req.headers), timeout: timeoutMs }, (proxyRes) => {
      res.status(proxyRes.statusCode ?? 502);
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) {
          res.setHeader(name, value);
        }
      }
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      timedOut = true;
      proxyReq.destroy();
    });
    proxyReq.on('error', (cause) => {
      // 413で断った後、またはブラウザが先に切断した後の、中継の後始末で出るエラーは、応答先が無いので無視する
      if (rejected || res.destroyed) {
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (timedOut) {
        sendError(res, 504, 'rag_timeout', `OCR・RAGサービスの応答が${Math.floor(timeoutMs / 1000)}秒以内に返りませんでした。`);
        return;
      }
      console.error('OCR・RAGサービスへの中継に失敗しました:', cause);
      sendError(res, 502, 'rag_unavailable', 'OCR・RAGサービスに接続できません。サービスが起動しているか確認してください。');
    });
    // ブラウザが先に切断したら、中継も止める
    res.on('close', () => {
      if (!res.writableFinished) {
        proxyReq.destroy();
      }
    });

    // 長さを宣言しないアップロードも、上限を超えたところで打ち切る
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxUploadBytes) {
        proxyReq.destroy();
        rejectTooLarge();
      }
    });
    req.pipe(proxyReq);
  };
}
