import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('未指定なら既定値になる', () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      host: '0.0.0.0',
      maxMarkdownBytes: 30 * 1024 * 1024,
      pdfTimeoutMs: 60_000,
      chromiumPath: '/usr/bin/chromium',
      rag: null,
    });
  });

  it('環境変数で上書きできる', () => {
    const config = loadConfig({
      PORT: '9000',
      HOST: '127.0.0.1',
      MAX_MARKDOWN_BYTES: '1024',
      PDF_TIMEOUT_MS: '5000',
      CHROMIUM_PATH: '/opt/chromium',
    });
    expect(config).toEqual({
      port: 9000,
      host: '127.0.0.1',
      maxMarkdownBytes: 1024,
      pdfTimeoutMs: 5000,
      chromiumPath: '/opt/chromium',
      rag: null,
    });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['MAX_MARKDOWN_BYTES', '1.5'],
    ['MAX_MARKDOWN_BYTES', '0'],
    ['PDF_TIMEOUT_MS', '10s'],
  ])('%s=%s のような不正な値は、黙って既定値に戻さずエラーにする', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrowError(name);
  });
});

describe('loadConfig: OCR・RAGサービス', () => {
  it('OCR_RAG_URLを指定すると、中継の設定になる(既定の待ち時間・上限つき)', () => {
    const { rag } = loadConfig({ OCR_RAG_URL: 'http://ocr-rag:8000' });

    expect(rag?.upstream.href).toBe('http://ocr-rag:8000/');
    expect(rag?.timeoutMs).toBe(10 * 60_000);
    expect(rag?.maxUploadBytes).toBe(110 * 1024 * 1024);
  });

  it('待ち時間とアップロードの上限を、環境変数で変えられる', () => {
    const { rag } = loadConfig({ OCR_RAG_URL: 'http://ocr-rag:8000', RAG_PROXY_TIMEOUT_MS: '30000', RAG_MAX_UPLOAD_BYTES: '2048' });

    expect(rag?.timeoutMs).toBe(30_000);
    expect(rag?.maxUploadBytes).toBe(2048);
  });

  it('空文字は、未指定と同じ(OCR・RAGを使わない)', () => {
    expect(loadConfig({ OCR_RAG_URL: '' }).rag).toBeNull();
  });

  it.each([['not a url'], ['https://ocr-rag:8000'], ['ftp://ocr-rag'], ['ocr-rag:8000']])('OCR_RAG_URL=%s のような不正な値は、黙って無視せずエラーにする', (value) => {
    expect(() => loadConfig({ OCR_RAG_URL: value })).toThrow(/OCR_RAG_URL/);
  });

  it.each([['RAG_PROXY_TIMEOUT_MS', '10s'], ['RAG_PROXY_TIMEOUT_MS', '0'], ['RAG_MAX_UPLOAD_BYTES', '-1']])('%s=%s のような不正な値はエラーにする', (name, value) => {
    expect(() => loadConfig({ OCR_RAG_URL: 'http://ocr-rag:8000', [name]: value })).toThrow(new RegExp(name));
  });
});

