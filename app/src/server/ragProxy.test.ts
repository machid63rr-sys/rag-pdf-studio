import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { RagConfig } from './config.js';
import { createRagProxy, ragNotConfigured } from './ragProxy.js';

// 本物のHTTPサーバを2つ立てて(ocr-ragの代役と、中継するExpress)、中継の挙動を検証する
interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

type UpstreamBehavior = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

async function startUpstream(behavior: UpstreamBehavior): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      behavior(req, res, body);
    });
  });
  return { port: await listen(server), seen };
}

async function startProxy(upstreamPort: number, overrides: Partial<RagConfig> = {}, upstreamPath = ''): Promise<string> {
  const config: RagConfig = {
    upstream: new URL(`http://127.0.0.1:${upstreamPort}${upstreamPath}`),
    timeoutMs: 5_000,
    maxUploadBytes: 1024 * 1024,
    ...overrides,
  };
  const app = express();
  app.use('/api/rag', createRagProxy(config));
  const port = await listen(createServer(app));
  return `http://127.0.0.1:${port}/api/rag`;
}

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

describe('createRagProxy', () => {
  it('GETのパスとクエリを、そのままocr-ragへ渡し、状態・ヘッダ・本文を返す', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Custom': 'abc' });
      res.end('[{"id":"1"}]');
    });
    const base = await startProxy(upstream.port);

    const response = await fetch(`${base}/ocr-drafts?limit=3`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-custom')).toBe('abc');
    expect(await response.text()).toBe('[{"id":"1"}]');
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]?.method).toBe('GET');
    expect(upstream.seen[0]?.url).toBe('/ocr-drafts?limit=3');
  });

  it('JSONのPOSTの本文とContent-Typeを、そのまま渡す', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 200, []));
    const base = await startProxy(upstream.port);

    await fetch(`${base}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'ポンプ' }) });

    expect(upstream.seen[0]?.method).toBe('POST');
    expect(upstream.seen[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(upstream.seen[0]?.body.toString('utf8') ?? '')).toEqual({ query: 'ポンプ' });
  });

  it('バイナリ(multipart)の本文を、1バイトも変えずに渡す', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 202, { ok: true }));
    const base = await startProxy(upstream.port);
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(300_000)]);
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'R-1.pdf');

    const response = await fetch(`${base}/ocr-drafts`, { method: 'POST', body: form });

    expect(response.status).toBe(202);
    const received = upstream.seen[0]?.body ?? Buffer.alloc(0);
    expect(received.includes(pdf)).toBe(true);
    expect(upstream.seen[0]?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('ocr-ragのエラー(422など)を、状態と本文ごとそのまま返す', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 422, { detail: [{ msg: '検索クエリが空です' }] }));
    const base = await startProxy(upstream.port);

    const response = await fetch(`${base}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: [{ msg: '検索クエリが空です' }] });
  });

  it('PDFのレスポンス(バイナリ・Content-Disposition)を、そのまま返す', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(100_000)]);
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''%E3%83%81%E3%83%A9%E3%83%BC.pdf" });
      res.end(pdf);
    });
    const base = await startProxy(upstream.port);

    const response = await fetch(`${base}/documents/abc/pdf`);

    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('filename*=UTF-8');
    expect(Buffer.from(await response.arrayBuffer()).equals(pdf)).toBe(true);
  });

  it('ストリームの応答(チャットの回答)は、溜めずに、届いた断片から順に返す', async () => {
    let finishUpstream: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finishUpstream = resolve;
    });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"type":"delta","text":"最初"}\n');
      // 2つ目の断片は、テストが1つ目を受け取ってから流す(中継が溜めていれば、1つ目も届かない)
      void finished.then(() => res.end('{"type":"done"}\n'));
    });
    const base = await startProxy(upstream.port);

    const response = await fetch(`${base}/chat/sessions/x/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"question":"q"}' });
    const reader = response.body?.getReader();
    const first = await Promise.race([reader?.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('最初の断片が、応答の完了まで届かなかった')), 3000))]);

    expect(new TextDecoder().decode(first?.value)).toBe('{"type":"delta","text":"最初"}\n');
    finishUpstream();
    const rest = await reader?.read();
    expect(new TextDecoder().decode(rest?.value)).toBe('{"type":"done"}\n');
  });

  it('hostは、ocr-ragの宛先に作り直す(ブラウザ側のhostを渡さない)', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 200, {}));
    const base = await startProxy(upstream.port);

    await fetch(`${base}/healthz`);

    expect(upstream.seen[0]?.headers['host']).toBe(`127.0.0.1:${upstream.port}`);
  });

  it('ocr-ragのURLにパスがあれば、その下へ中継する', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 200, {}));
    const base = await startProxy(upstream.port, {}, '/base/');

    await fetch(`${base}/documents`);

    expect(upstream.seen[0]?.url).toBe('/base/documents');
  });

  it.each(['/documents', '/documents/x/pdf', '/ocr-drafts', '/ocr-drafts/x', '/equipment-names', '/search', '/chat/sessions', '/chat/sessions/x/messages', '/healthz', '/readyz'])(
    '許可したパス %s は、中継する',
    async (path) => {
      const upstream = await startUpstream((_req, res) => json(res, 200, {}));
      const base = await startProxy(upstream.port);

      expect((await fetch(`${base}${path}`)).status).toBe(200);
    },
  );

  it.each(['/', '/docs', '/openapi.json', '/redoc', '/other', '/documentsx', '/ocr-draftsX/1', '/chatter', '/chat-x/sessions'])('許可していないパス %s は、ocr-ragへ渡さず404にする', async (path) => {
    const upstream = await startUpstream((_req, res) => json(res, 200, {}));
    const base = await startProxy(upstream.port);

    const response = await fetch(`${base}${path}`);

    expect(response.status).toBe(404);
    expect(upstream.seen).toHaveLength(0);
  });

  it('ocr-ragに接続できないときは、502で原因が分かるエラーを返す', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 200, {}));
    const base = await startProxy(upstream.port);
    await new Promise<void>((resolve) => {
      const server = servers.find((s) => (s.address() as AddressInfo | null)?.port === upstream.port);
      server?.closeAllConnections();
      server?.close(() => resolve());
    });

    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('rag_unavailable');
  });

  it('ocr-ragが応答しないときは、時間切れを504で返す', async () => {
    const upstream = await startUpstream(() => {
      // 応答しない
    });
    const base = await startProxy(upstream.port, { timeoutMs: 200 });

    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('rag_timeout');
  });

  it('Content-Lengthが上限を超えるアップロードは、ocr-ragへ渡さず413にする', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 202, {}));
    const base = await startProxy(upstream.port, { maxUploadBytes: 1000 });

    const response = await fetch(`${base}/ocr-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1001) });

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('upload_too_large');
    expect(upstream.seen).toHaveLength(0);
  });

  it('上限ちょうどのアップロードは、中継する', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 202, {}));
    const base = await startProxy(upstream.port, { maxUploadBytes: 1000 });

    const response = await fetch(`${base}/ocr-drafts`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1000) });

    expect(response.status).toBe(202);
  });

  it('長さを宣言しない(chunked)アップロードも、上限を超えたら413にする', async () => {
    const upstream = await startUpstream((_req, res) => json(res, 202, {}));
    const base = await startProxy(upstream.port, { maxUploadBytes: 1000 });
    const url = new URL(`${base}/ocr-drafts`);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write(Buffer.alloc(600));
      req.write(Buffer.alloc(600));
      req.end();
    });

    expect(status).toBe(413);
  });

  it('ブラウザが先に切断したら、ocr-ragへの中継も止める', async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = await startUpstream((req) => {
      req.on('close', () => upstreamClosed());
      // 応答しない
    });
    const base = await startProxy(upstream.port);
    const controller = new AbortController();

    const pending = fetch(`${base}/healthz`, { signal: controller.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await pending;

    await expect(Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('中継が止まらなかった')), 3000))])).resolves.toBeUndefined();
  });
});

describe('ragNotConfigured', () => {
  it('OCR_RAG_URLが無いときは、設定が無いことを503で返す', async () => {
    const app = express();
    app.use('/api/rag', ragNotConfigured);
    const port = await listen(createServer(app));

    const response = await fetch(`http://127.0.0.1:${port}/api/rag/documents`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rag_not_configured');
    expect(body.error.message).toContain('OCR_RAG_URL');
  });
});
