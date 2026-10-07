import { mkdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createApp } from '../../src/server/app.js';
import { createPdfRenderer } from '../../src/server/pdf.js';
import { FakeRagServer } from './fakeRagServer.js';

/*
 * 画面の結合テストの土台。ビルド済みクライアント(dist/client)を、実サーバ・実Chromiumで動かし、
 * OCR・RAGサービス(ocr-rag)は偽物(FakeRagServer)につなぐ。事前に `npm run build` が必要。
 * 環境変数 E2E_SCREENSHOT_DIR を指定すると、screenshot() で各画面のスクリーンショットを保存する。
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const clientDir = join(root, 'dist/client');
const screenshotDir = process.env['E2E_SCREENSHOT_DIR'];

export interface E2ePage {
  readonly page: Page;
  // 画面のコンソールに出たエラー(テストの最後に、空であることを確認する)
  readonly consoleErrors: string[];
  // 画面に出た確認ダイアログ(confirm/alert)の文言。すべて「OK」で応答する
  readonly dialogs: string[];
}

export interface E2eStack {
  readonly baseUrl: string;
  readonly rag: FakeRagServer;
  readonly browser: Browser;
  newPage(viewport?: { width: number; height: number }): Promise<E2ePage>;
  screenshot(page: Page, name: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startE2eStack(): Promise<E2eStack> {
  const rag = await FakeRagServer.start();
  const renderer = createPdfRenderer({
    chromiumPath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
    timeoutMs: 60_000,
    mermaidScript: readFileSync(join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8'),
  });
  const app = createApp({
    maxMarkdownBytes: 5 * 1024 * 1024,
    renderer,
    css: readFileSync(join(root, 'src/shared/document.css'), 'utf8'),
    clientDir,
    chromiumVersion: 'e2e',
    rag: { upstream: new URL(rag.url), timeoutMs: 10_000, maxUploadBytes: 5 * 1024 * 1024 },
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    // ロケール未設定(Cロケール)のコンテナでは、日本語のファイル名を保存できない。検証用のChromiumだけUTF-8にする
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  if (screenshotDir !== undefined) {
    mkdirSync(screenshotDir, { recursive: true });
  }

  return {
    baseUrl,
    rag,
    browser,
    async newPage(viewport = { width: 1280, height: 1000 }) {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      const consoleErrors: string[] = [];
      const dialogs: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      return { page, consoleErrors, dialogs };
    },
    async screenshot(page, name) {
      if (screenshotDir !== undefined) {
        await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
      }
    },
    async stop() {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rag.stop();
    },
  };
}
