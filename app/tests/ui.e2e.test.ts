import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type ElementHandle, type Frame, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { createPdfRenderer } from '../src/server/pdf.js';

/*
 * 画面全体の結合テスト。ビルド済みクライアント(dist/client)を実サーバ・実Chromiumで動かし、
 * 「取り込み → 書式付き編集 → Markdownタブ → 出力」を操作する。
 * ヘッドレスではネイティブのフォルダ選択ダイアログを操作できないため、ダイアログ(showDirectoryPicker)だけを
 * ブラウザ標準のオリジン私有ファイルシステム(OPFS)のハンドルを返す関数に差し替える。
 * ファイルの存在確認・書き込み・上書きは、本物のFile System Access APIで行われる。
 * 事前に `npm run build` が必要(無ければ、わかりやすいメッセージで失敗する)。
 * 環境変数 E2E_SCREENSHOT_DIR を指定すると、各画面のスクリーンショットを保存する。
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const clientDir = join(root, 'dist/client');
const css = readFileSync(join(root, 'src/shared/document.css'), 'utf8');
const screenshotDir = process.env['E2E_SCREENSHOT_DIR'];

let browser: Browser;
let server: Server;
let baseUrl: string;
let page: Page;
const consoleErrors: string[] = [];

beforeAll(async () => {
  if (!existsSync(join(clientDir, 'index.html'))) {
    throw new Error('dist/client がありません。先に `npm run build` を実行してください。');
  }
  const renderer = createPdfRenderer({
    chromiumPath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
    timeoutMs: 60_000,
    mermaidScript: readFileSync(join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8'),
  });
  const app = createApp({ maxMarkdownBytes: 5 * 1024 * 1024, renderer, css, clientDir, chromiumVersion: 'e2e' });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await puppeteer.launch({
    executablePath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    // ロケール未設定(Cロケール)のコンテナでは、Chromiumが日本語のファイル名を保存できず「download」になる。
    // 利用者のブラウザ(Windows等)では起きないため、検証用のChromiumだけUTF-8ロケールで起動する
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  if (screenshotDir !== undefined) {
    mkdirSync(screenshotDir, { recursive: true });
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1000 });
  consoleErrors.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  // フォルダ選択ダイアログの代わりに、OPFSのルートを「選ばれたフォルダ」として返す(中身は毎回空にする)
  await page.evaluateOnNewDocument(() => {
    window.showDirectoryPicker = async () => {
      const dir = await navigator.storage.getDirectory();
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        await dir.removeEntry(name, { recursive: true });
      }
      return dir;
    };
  });
  page.on('dialog', (dialog) => void dialog.accept());
});

const shot = async (name: string): Promise<void> => {
  if (screenshotDir !== undefined) {
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
  }
};

const SAMPLE = [
  '# 取扱説明書',
  '',
  '画面に <エラー一覧表> と表示されます。型は `List<string>` のようにも書きます。',
  '',
  '| 項目 | 説明 |',
  '| --- | --- |',
  '| A | 最初の項目 |',
  '',
  '```python',
  'print("こんにちは")',
  '```',
].join('\n');

// textareaへ長い文字列を入れるには、1文字ずつ入力せず値を直接設定してinputイベントを発火させる
async function setPasted(markdown: string): Promise<void> {
  await page.goto(baseUrl);
  await page.waitForSelector('#paste-area');
  await page.$eval(
    '#paste-area',
    (element, value) => {
      const area = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    },
    markdown,
  );
}

const clickButton = async (label: string): Promise<void> => {
  const handle = await page.evaluateHandle((text) => {
    return [...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((button) => button.textContent?.includes(text)) ?? null;
  }, label);
  const element = handle.asElement();
  if (element === null) {
    throw new Error(`ボタン「${label}」が見つかりません`);
  }
  await (element as unknown as { click(): Promise<void> }).click();
};

const sourceValue = (): Promise<string> =>
  page.$eval('textarea[aria-label="Markdown"]', (element) => (element as HTMLTextAreaElement).value);

async function loadMarkdown(markdown: string): Promise<void> {
  await setPasted(markdown);
  await shot('1-import');
  await clickButton('貼り付けた内容を読み込む');
}

async function openEditor(markdown: string): Promise<void> {
  await loadMarkdown(markdown);
  await page.waitForSelector('.md-editor-content');
}

describe('画面操作(実ブラウザ)', () => {
  it('取り込むと、書式付きプレビューに見出し・表・コードが描画され、解釈エラーにならない', async () => {
    await openEditor(SAMPLE);
    await page.waitForFunction(() => document.querySelector('.md-editor-content h1') !== null);

    const text = await page.$eval('.md-editor-content', (element) => (element as HTMLElement).innerText);
    expect(text).toContain('取扱説明書');
    expect(text).toContain('<エラー一覧表>');
    expect(text).toContain('List<string>');
    expect(text).not.toContain('\\<');
    expect(await page.$('.md-editor-content table')).not.toBeNull();
    expect(await page.$('[role="alert"]')).toBeNull();
    await shot('2-edit-rich');
    expect(consoleErrors).toEqual([]);
  });

  it('編集しなければMarkdownは取り込んだままで、Markdownタブにそのまま表示される', async () => {
    await openEditor(SAMPLE);
    await clickButton('Markdown');
    expect(await sourceValue()).toBe(SAMPLE);
  });

  it('書式付きで編集すると、山括弧とインラインコードが壊れずにMarkdownへ反映される', async () => {
    await openEditor(SAMPLE);
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.type('(第2版)');
    await clickButton('Markdown');

    const edited = await sourceValue();
    expect(edited).toContain('# 取扱説明書(第2版)');
    expect(edited).toContain('<エラー一覧表>');
    expect(edited).toContain('`List<string>`');
    expect(edited).not.toContain('\\<');
    expect(edited).toContain('```python');
    expect(edited).toMatch(/\| 項目\s*\| 説明\s*\|/);
    await shot('3-edit-source');
  });

  it('Markdownタブでの編集が、書式付きプレビューへ反映される', async () => {
    await openEditor(SAMPLE);
    await clickButton('Markdown');
    await page.$eval('textarea[aria-label="Markdown"]', (element) => {
      const area = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(area, `${area.value}\n\n## 追記した見出し`);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('プレビュー');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.md-editor-content h2')].some((h) => h.textContent === '追記した見出し'),
    );
  });

  it('脚注を含むMarkdownは、書式付きでは扱えない旨を表示してMarkdownタブへ切り替わる(黙って壊さない)', async () => {
    await loadMarkdown('本文[^1]\n\n[^1]: 脚注');
    await page.waitForSelector('[role="alert"]');
    const alertText = await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText);
    expect(alertText).toContain('書式付きエディタで扱えない記法');
    expect(await sourceValue()).toBe('本文[^1]\n\n[^1]: 脚注');
    await shot('4-parse-error');
  });

  it('生HTML・外部画像・front matterの警告が表示される', async () => {
    await openEditor('---\ntitle: T\n---\n\n改行<br>です\n\n![図](https://example.com/a.png)');
    await page.waitForSelector('.warning-list');
    const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
    expect(warnings).toContain('front matter');
    expect(warnings).toContain('HTMLタグ');
    expect(warnings).toContain('表示できない画像');
    await shot('5-warnings');
  });

  describe('出力', () => {
    const outputButton = (): Promise<boolean> =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへMDとPDFを出力'));
        return button?.disabled ?? true;
      });

    const readOutputs = (): Promise<{ names: string[]; markdown: string; pdfHeader: string; pdfSize: number }> =>
      page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(name);
        }
        names.sort();
        const mdFile = await (await dir.getFileHandle('manual.md')).getFile();
        const pdfFile = await (await dir.getFileHandle('manual.pdf')).getFile();
        const header = new TextDecoder('latin1').decode((await pdfFile.arrayBuffer()).slice(0, 5));
        return { names, markdown: await mdFile.text(), pdfHeader: header, pdfSize: pdfFile.size };
      });

    it('フォルダを選ぶまで出力ボタンは無効。選ぶとMDとPDFが同じ名前で書き込まれる', async () => {
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'manual');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(await outputButton()).toBe(true);

      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(() => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへMDとPDFを出力'))?.disabled ?? true));
      await clickButton('選んだフォルダへMDとPDFを出力');
      await page.waitForSelector('.notice-success', { timeout: 60_000 });

      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('manual.md');
      expect(status).toContain('manual.pdf');
      const outputs = await readOutputs();
      expect(outputs.names).toEqual(['manual.md', 'manual.pdf']);
      expect(outputs.markdown).toBe(SAMPLE);
      expect(outputs.pdfHeader).toBe('%PDF-');
      expect(outputs.pdfSize).toBeGreaterThan(1000);
      await shot('6-output-success');
      expect(consoleErrors).toEqual([]);
    });

    it('ファイル名に使えない文字があると、理由を表示して出力できない', async () => {
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'a/b');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector('.field-error');
      const message = await page.$eval('.field-error', (element) => (element as HTMLElement).innerText);
      expect(message).toContain('使えません');
      expect(await outputButton()).toBe(true);
    });
  });

  it('showDirectoryPickerが無いブラウザでは、出力ボタンを無効にして理由を表示する', async () => {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    });
    await openEditor(SAMPLE);
    const reason = await page.$eval('.field-error', (element) => (element as HTMLElement).innerText);
    expect(reason).toContain('Chrome または Edge');
  });

  describe('保存するファイルの選択(チェックボックス)', () => {
    const state = (): Promise<{
      nameDisabled: boolean;
      suffix: string;
      folder: boolean;
      primary: string;
      primaryDisabled: boolean;
      download: boolean;
      text: string;
    }> =>
      page.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')];
        const find = (text: string) => buttons.find((b) => b.textContent?.includes(text));
        const primary = document.querySelector('.actions .button-primary') as HTMLButtonElement;
        return {
          nameDisabled: (document.getElementById('base-name') as HTMLInputElement).disabled,
          suffix: (document.querySelector('.field-suffix') as HTMLElement).innerText,
          folder: find('出力先フォルダを選択')?.disabled ?? true,
          primary: primary.textContent ?? '',
          primaryDisabled: primary.disabled,
          download: find('ダウンロードで保存')?.disabled ?? true,
          text: (document.querySelector('.output-panel') as HTMLElement).innerText,
        };
      });

    // ブラウザ内の保存先(OPFS)は、テストをまたいで残るため、毎回空にして「保存されていないこと」を検証できるようにする
    beforeEach(async () => {
      await page.goto(baseUrl);
      await page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          await dir.removeEntry(name, { recursive: true });
        }
      });
    });

    const setChecked = async (label: string, checked: boolean): Promise<void> => {
      await page.evaluate(
        (text, value) => {
          const input = [...document.querySelectorAll('.file-select label')]
            .find((l) => l.textContent?.includes(text))
            ?.querySelector('input') as HTMLInputElement;
          if (input.checked !== value) {
            input.click();
          }
        },
        label,
        checked,
      );
    };

    const setBaseName = (value: string): Promise<void> =>
      page.$eval(
        '#base-name',
        (element, name) => {
          const input = element as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, name);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        value,
      );

    const savedNames = (): Promise<string[]> =>
      page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(name);
        }
        return names.sort();
      });

    const savedFile = (name: string): Promise<{ text: string; header: string } | null> =>
      page.evaluate(async (fileName) => {
        const dir = await navigator.storage.getDirectory();
        try {
          const file = await (await dir.getFileHandle(fileName)).getFile();
          return { text: await file.text(), header: new TextDecoder('latin1').decode((await file.arrayBuffer()).slice(0, 5)) };
        } catch {
          return null;
        }
      }, name);

    // フォルダを選び、出力ボタンが有効になってから押す
    const chooseFolderAndOutput = async (label: string): Promise<void> => {
      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(
        (text) => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes(text))?.disabled ?? true),
        {},
        label,
      );
      await clickButton(label);
      await page.waitForSelector('.notice-success', { timeout: 60_000 });
    };

    it('初期状態は両方チェック。ファイル名を編集でき、フォルダを選んでまとめて出力する', async () => {
      await openEditor(SAMPLE);
      const initial = await state();
      expect(initial.nameDisabled).toBe(false);
      expect(initial.suffix).toBe('.md / .pdf');
      expect(initial.folder).toBe(false);
      expect(initial.primary).toBe('選んだフォルダへMDとPDFを出力');
      expect(initial.download).toBe(false);
      await shot('7-select-both');
    });

    it.each([
      ['Markdown (.md)', '.pdf', '選んだフォルダへPDFを出力'],
      ['PDF (.pdf)', '.md', '選んだフォルダへMDを出力'],
    ])('%s を外しても(片方だけ保存)、ファイル名を編集でき、フォルダ選択とダウンロードも使える', async (unchecked, suffix, expectedLabel) => {
      await openEditor(SAMPLE);
      await setChecked(unchecked, false);

      const single = await state();
      expect(single.nameDisabled).toBe(false);
      expect(single.suffix).toBe(suffix);
      expect(single.folder).toBe(false);
      expect(single.download).toBe(false);
      expect(single.primary).toBe(expectedLabel);
      // フォルダを選ぶまでは、出力できない
      expect(single.primaryDisabled).toBe(true);
      expect(single.text).not.toContain('名前を付けて保存');
      await shot('8-select-single');

      // 両方に戻すと、元の状態に戻る
      await setChecked(unchecked, true);
      const both = await state();
      expect(both.suffix).toBe('.md / .pdf');
      expect(both.primary).toBe('選んだフォルダへMDとPDFを出力');
    });

    it('両方外すと、保存系のボタンはすべて無効になり、選ぶよう促す', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await setChecked('PDF (.pdf)', false);

      const none = await state();
      expect(none.nameDisabled).toBe(true);
      expect(none.folder).toBe(true);
      expect(none.primaryDisabled).toBe(true);
      expect(none.download).toBe(true);
      expect(none.text).toContain('保存するファイルを1つ以上選んでください');
    });

    it('PDFだけ保存: ファイル名を決めてフォルダを選ぶと、「<名前>.pdf」だけが書き込まれる', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await setBaseName('手順書');
      await chooseFolderAndOutput('選んだフォルダへPDFを出力');

      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('手順書.pdf');
      expect(status).not.toContain('手順書.md');
      expect(await savedNames()).toEqual(['手順書.pdf']);
      expect((await savedFile('手順書.pdf'))?.header).toBe('%PDF-');
      await shot('9-save-pdf-only');
      expect(consoleErrors).toEqual([]);
    });

    it('Markdownだけ保存: ファイル名を決めてフォルダを選ぶと、編集した内容の「<名前>.md」だけが書き込まれる', async () => {
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await chooseFolderAndOutput('選んだフォルダへMDを出力');

      expect(await savedNames()).toEqual(['document.md']);
      expect((await savedFile('document.md'))?.text).toBe(SAMPLE);
      expect(consoleErrors).toEqual([]);
    });

    it('片方だけ保存でも、ファイル名に使えない文字があると、理由を表示して出力できない', async () => {
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await setBaseName('a/b');
      await page.waitForSelector('.field-error');

      const invalid = await state();
      expect(invalid.text).toContain('使えません');
      expect(invalid.primaryDisabled).toBe(true);
      expect(invalid.download).toBe(true);
    });

    it('片方だけ保存でもダウンロードできる: 選んだファイルだけが、入力した名前で保存される', async () => {
      const downloads = mkdtempSync(join(tmpdir(), 'md-pdf-editor-single-'));
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await setBaseName('メモ');

      await clickButton('ダウンロードで保存');
      await page.waitForSelector('.notice-success');
      const deadline = Date.now() + 30_000;
      while (!readdirSync(downloads).includes('メモ.md') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(readdirSync(downloads).sort()).toEqual(['メモ.md']);
      expect(readFileSync(join(downloads, 'メモ.md'), 'utf8')).toBe(SAMPLE);
      rmSync(downloads, { recursive: true, force: true });
    });
  });

  describe('ダウンロードで保存', () => {
    let downloadDir: string;

    beforeEach(() => {
      downloadDir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-download-'));
    });

    const allowDownloads = async (): Promise<void> => {
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    };

    const waitForFiles = async (names: string[]): Promise<void> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const present = readdirSync(downloadDir);
        if (names.every((name) => present.includes(name) && statSync(join(downloadDir, name)).size > 0)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`ダウンロードされませんでした: ${names.join(', ')} (実際: ${readdirSync(downloadDir).join(', ')})`);
    };

    it('フォルダを選ばなくても、MDとPDFの両方がダウンロードされる(内容も正しい)', async () => {
      await allowDownloads();
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '手順書');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await clickButton('ダウンロードで保存');
      await waitForFiles(['手順書.md', '手順書.pdf']);

      expect(readFileSync(join(downloadDir, '手順書.md'), 'utf8')).toBe(SAMPLE);
      expect(readFileSync(join(downloadDir, '手順書.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('手順書.md');
      expect(status).toContain('手順書.pdf');
      rmSync(downloadDir, { recursive: true, force: true });
    });

    it('フォルダ選択に対応していないブラウザでも、ダウンロードで保存できる', async () => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
      });
      await allowDownloads();
      await openEditor(SAMPLE);
      const reason = await page.$eval('.field-error', (element) => (element as HTMLElement).innerText);
      expect(reason).toContain('ダウンロードで保存');

      await clickButton('ダウンロードで保存');
      await waitForFiles(['document.md', 'document.pdf']);
      rmSync(downloadDir, { recursive: true, force: true });
    });

    it('ファイル名が不正なときは、ダウンロードできない', async () => {
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'a/b');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const disabled = await page.evaluate(
        () => [...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('ダウンロードで保存'))?.disabled,
      );
      expect(disabled).toBe(true);
    });
  });

  describe('HTML・CSSの編集(実ブラウザ)', () => {
    // 整っていない書き方(省略タグ・引用符の違い・実体参照・コメント・表のtbody省略)を含む、取り込んだままの形が保たれるべきHTML
    const HTML_SAMPLE = [
      '<!DOCTYPE html>',
      '<html lang="ja">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <title>案内</title>',
      '  <style>h1 { color: #c00; } p.lead { font-weight: bold }</style>',
      '</head>',
      '<body class=main>',
      '  <h1 id=top>お知らせ &amp; ご案内</h1>',
      "  <p class='lead'>本日は休業です。&copy; 2026</p>",
      '  <!-- メモ -->',
      '  <p class="note">補足です。</p>',
      '  <ul>',
      '    <li>項目1',
      '    <li>項目2',
      '  </ul>',
      '  <table><tr><td>A</td><td>B</td></tr></table>',
      '  <pre>  整形済み\n    テキスト</pre>',
      '</body>',
      '</html>',
      '',
    ].join('\n');

    const selectPasteKind = (label: string): Promise<void> =>
      page.evaluate((text) => {
        const input = [...document.querySelectorAll('.paste-kind label')].find((l) => l.textContent?.includes(text))?.querySelector('input');
        (input as HTMLInputElement).click();
      }, label);

    // 編集できるプレビュー(iframe)が表示され、編集の準備ができるまで待つ
    const previewFrame = async (): Promise<Frame> => {
      await page.waitForFunction(
        () => (document.querySelector('iframe.html-preview-frame') as HTMLIFrameElement | null)?.contentDocument?.designMode === 'on',
      );
      const handle = await page.$('iframe.html-preview-frame');
      const frame = await handle?.contentFrame();
      if (frame === null || frame === undefined) {
        throw new Error('プレビューのiframeが見つかりません');
      }
      return frame;
    };

    async function openHtml(html: string): Promise<Frame> {
      await setPasted(html);
      await selectPasteKind('HTML');
      await clickButton('貼り付けた内容を読み込む');
      return previewFrame();
    }

    const htmlSource = async (): Promise<string> => {
      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      return page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value);
    };

    // プレビュー内で、指定した要素の末尾にカーソルを置く(フォーカスはiframeへ移す)
    const caretAtEnd = async (frame: Frame, selector: string): Promise<void> => {
      await (await page.$('iframe.html-preview-frame'))?.click();
      await frame.evaluate((sel) => {
        const element = document.querySelector(sel) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      }, selector);
    };

    const WAIT_FOR_DEBOUNCE_MS = 400;
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, WAIT_FOR_DEBOUNCE_MS));

    it('HTMLを貼り付けると、プレビューに表示される(CSSも適用され、エラーにならない)', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      const text = await frame.$eval('body', (element) => (element as HTMLElement).innerText);
      expect(text).toContain('お知らせ & ご案内');
      expect(text).toContain('項目2');
      expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
      expect(await page.$('[role="alert"]')).toBeNull();
      await shot('10-html-preview');
      expect(consoleErrors).toEqual([]);
    });

    it('編集していなければ、実ブラウザが解釈し直した文書から差分を取っても、HTMLは1文字も変わらない', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      // 編集イベントを人為的に起こし、実Chromiumが解釈した文書とソースを比較させる(差分が無ければ何も書き換わらない)
      await frame.evaluate(() => document.dispatchEvent(new Event('input')));
      await settle();
      expect(await htmlSource()).toBe(HTML_SAMPLE);
      expect(await page.$('[role="alert"]')).toBeNull();
    });

    it('プレビューで文字を編集すると、その箇所だけがHTMLへ反映され、他の部分(引用符・省略タグ・実体参照・コメント)はそのまま', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      await caretAtEnd(frame, 'p.lead');
      await page.keyboard.type('ありがとう');
      await settle();

      const source = await htmlSource();
      expect(source).toBe(HTML_SAMPLE.replace('本日は休業です。&copy; 2026', '本日は休業です。© 2026ありがとう'));
      expect(source).toContain('<h1 id=top>お知らせ &amp; ご案内</h1>');
      expect(source).toContain('<li>項目1\n    <li>項目2\n  </ul>');
      expect(source).toContain('<body class=main>');
      expect(source).toContain('<!-- メモ -->');
      await shot('11-html-edited');
      expect(consoleErrors).toEqual([]);
    });

    it('「太字」ボタンで、選択した範囲がタグで囲まれ、その段落の中だけが書き換わる', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      await (await page.$('iframe.html-preview-frame'))?.click();
      await frame.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('p.note') as HTMLElement);
        const selection = window.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await clickButton('太字');
      await settle();

      const source = await htmlSource();
      expect(source).toBe(HTML_SAMPLE.replace('<p class="note">補足です。</p>', '<p class="note"><b>補足です。</b></p>'));
    });

    it('Enterで新しい段落を作ると、その分だけが追加され、他の部分は変わらない', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      await caretAtEnd(frame, 'p.lead');
      await page.keyboard.press('Enter');
      await page.keyboard.type('新しい段落');
      await settle();

      const source = await htmlSource();
      expect(source).toContain('新しい段落</p>');
      expect(source).toContain('<h1 id=top>お知らせ &amp; ご案内</h1>');
      expect(source).toContain('<li>項目1\n    <li>項目2\n  </ul>');
      expect(source).toContain('<table><tr><td>A</td><td>B</td></tr></table>');
      expect(source.startsWith('<!DOCTYPE html>\n<html lang="ja">\n<head>')).toBe(true);
      expect(source.endsWith('</body>\n</html>\n')).toBe(true);
    });

    it('HTMLタブで直接編集すると、隣のプレビューに反映され、プレビューへ戻っても編集内容が表示される', async () => {
      await openHtml(HTML_SAMPLE);
      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      await page.$eval('textarea[aria-label="HTML"]', (element, value) => {
        const area = element as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(area, value);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      }, HTML_SAMPLE.replace('項目1', '直接編集した項目'));

      const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
      await side.waitForFunction(() => document.body.innerText.includes('直接編集した項目'));
      await shot('12-html-source-tab');

      await clickButton('プレビュー');
      const frame = await previewFrame();
      await frame.waitForFunction(() => document.body.innerText.includes('直接編集した項目'));
    });

    it('スクリプトは実行されず、外部へも通信しない(プレビュー)', async () => {
      const requested: string[] = [];
      const probe: Server = createServer((req, res) => {
        requested.push(req.url ?? '');
        res.end();
      });
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const { port } = probe.address() as AddressInfo;
      try {
        const html =
          '<!DOCTYPE html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script>' +
          `<img src="http://127.0.0.1:${port}/img.png" onerror="document.getElementById('t').textContent='実行された'">` +
          `<style>p { background: url(http://127.0.0.1:${port}/bg.png) }</style></body>`;
        const frame = await openHtml(html);
        await settle();

        expect(await frame.$eval('#t', (element) => element.textContent)).toBe('前');
        expect(requested).toEqual([]);
        // 出力前の警告で知らせる
        const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
        expect(warnings).toContain('スクリプト');
        expect(warnings).toContain('外部の画像');
      } finally {
        await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
      }
    });

    it('リンクをクリックしても、プレビューは別のページへ移らない', async () => {
      await openHtml('<!DOCTYPE html><body><p><a href="https://example.com/">リンク</a></p></body>');
      await clickButton('HTML');
      const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
      await side.waitForSelector('a');
      await side.click('a');
      await settle();
      expect(side.url()).toBe('about:srcdoc');
      expect(await side.$eval('p', (element) => element.textContent)).toBe('リンク');
    });

    describe('CSSファイルを一緒に取り込む', () => {
      let dir: string;
      const files = (): { html: string; css: string; other: string } => ({
        html: join(dir, 'index.html'),
        css: join(dir, 'style.css'),
        other: join(dir, 'other.html'),
      });
      const PAGE = '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n<link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n<h1>見出し</h1>\n<p>本文</p>\n</body>\n</html>\n';

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-html-'));
        writeFileSync(files().html, PAGE);
        writeFileSync(files().css, 'h1 { color: rgb(204, 0, 0); }');
        writeFileSync(files().other, '<p>別</p>');
      });

      const upload = async (...paths: string[]): Promise<void> => {
        await page.goto(baseUrl);
        await page.waitForSelector('input[type=file]', { hidden: true });
        const input = (await page.$('input[type=file]')) as ElementHandle<HTMLInputElement>;
        await input.uploadFile(...paths);
      };

      it('HTMLの<link>と同じ名前のCSSが適用され、CSSタブで編集でき、隣のプレビューに反映される', async () => {
        await upload(files().css, files().html);
        const frame = await previewFrame();
        expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
        // 参照されているCSSなので、「参照されていない」旨の警告は出ない
        expect(await page.$('.warning-list')).toBeNull();
        expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(直接編集)', 'HTML', 'CSS: style.css']);

        await clickButton('CSS: style.css');
        await page.waitForSelector('textarea[aria-label="CSS: style.css"]');
        await page.$eval('textarea[aria-label="CSS: style.css"]', (element) => {
          const area = element as HTMLTextAreaElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(area, 'h1 { color: rgb(0, 0, 255); }');
          area.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
        await side.waitForFunction(() => getComputedStyle(document.querySelector('h1') as Element).color === 'rgb(0, 0, 255)');
        await shot('13-css-tab');

        // プレビューへ戻っても、編集したCSSが適用されている。HTMLは、CSSを埋め込まれず、取り込んだままである
        await clickButton('プレビュー');
        const edited = await previewFrame();
        expect(await edited.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(0, 0, 255)');
        expect(await htmlSource()).toBe(PAGE);
      });

      it('HTML・CSS・PDFを、HTMLの参照名(style.css)のまま、選んだフォルダへ出力できる', async () => {
        await upload(files().html, files().css);
        const frame = await previewFrame();
        await caretAtEnd(frame, 'p');
        await page.keyboard.type('(追記)');
        await settle();

        // HTMLが css/style.css を指しているため、CSSも、HTMLと同じ出力フォルダの css/style.css に保存する
        const labels = await page.$$eval('.file-select label', (items) => items.map((item) => item.textContent?.trim()));
        expect(labels).toEqual(['HTML (.html)', 'CSS (css/style.css)', 'PDF (.pdf)']);
        await clickButton('出力先フォルダを選択');
        await page.waitForFunction(
          () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへHTMLとCSSとPDFを出力'))?.disabled ?? true),
        );
        await clickButton('選んだフォルダへHTMLとCSSとPDFを出力');
        await page.waitForSelector('.notice-success', { timeout: 60_000 });

        const saved = await page.evaluate(async () => {
          const dir = await navigator.storage.getDirectory();
          const names: string[] = [];
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            names.push(name);
          }
          const read = async (name: string) => (await (await dir.getFileHandle(name)).getFile()).text();
          return {
            names: names.sort(),
            html: await read('index.html'),
            css: await (await (await dir.getDirectoryHandle('css')).getFileHandle('style.css')).getFile().then((f) => f.text()),
            pdfHeader: (await read('index.pdf')).slice(0, 5),
          };
        });
        expect(saved.names).toEqual(['css', 'index.html', 'index.pdf']);
        expect(saved.html).toBe(PAGE.replace('<p>本文</p>', '<p>本文(追記)</p>'));
        expect(saved.css).toBe('h1 { color: rgb(204, 0, 0); }');
        expect(saved.pdfHeader).toBe('%PDF-');
        await shot('14-html-output');
        expect(consoleErrors).toEqual([]);
      });

      it('HTMLだけを選んで保存すると、ファイル名の指定は.htmlに使われ、CSSとPDFは保存されない', async () => {
        await upload(files().html, files().css);
        await previewFrame();
        await page.evaluate(() => {
          for (const text of ['CSS (css/style.css)', 'PDF (.pdf)']) {
            const input = [...document.querySelectorAll('.file-select label')].find((l) => l.textContent?.includes(text))?.querySelector('input');
            (input as HTMLInputElement).click();
          }
        });
        await page.$eval('#base-name', (element) => {
          const input = element as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, '案内');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await clickButton('出力先フォルダを選択');
        await page.waitForFunction(
          () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへHTMLを出力'))?.disabled ?? true),
        );
        await clickButton('選んだフォルダへHTMLを出力');
        await page.waitForSelector('.notice-success');
        const names = await page.evaluate(async () => {
          const dir = await navigator.storage.getDirectory();
          const found: string[] = [];
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            found.push(name);
          }
          return found;
        });
        expect(names).toEqual(['案内.html']);
      });

      it('CSSだけ・HTMLが2つ・Markdownと一緒のCSSは、取り込まず理由を表示する', async () => {
        await upload(files().css);
        await page.waitForSelector('[role="alert"]');
        expect(await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText)).toContain('CSSファイルだけは取り込めません');

        await upload(files().html, files().other);
        await page.waitForSelector('[role="alert"]');
        expect(await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText)).toContain('1つずつ取り込んでください');
      });

      it('どの<link>にも参照されていないCSSは、<head>の末尾に追加して適用し、その旨を知らせる', async () => {
        writeFileSync(files().html, '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body>\n<h1>見出し</h1>\n</body>\n</html>\n');
        await upload(files().html, files().css);
        const frame = await previewFrame();
        expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
        const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
        expect(warnings).toContain('style.css');
        expect(warnings).toContain('追加して適用');
      });
    });
  describe('フォルダごとの取り込みと画像(実ブラウザ)', () => {
    // 1x1のPNG
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    interface Entry {
      path: string;
      text?: string;
      base64?: string;
    }

    // フォルダの選択ダイアログは操作できないため、「選んだフォルダ内のファイル(相対パスつき)」を、フォルダ選択の入力へ渡す
    async function importFolder(entries: Entry[], root = 'site'): Promise<void> {
      await page.goto(baseUrl);
      await page.waitForSelector('input[aria-label="フォルダを選択"]', { hidden: true });
      await page.evaluate(
        (items, rootName) => {
          const input = document.querySelector('input[aria-label="フォルダを選択"]') as HTMLInputElement;
          const files = items.map((item) => {
            const bytes = item.base64 !== undefined ? Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(item.text ?? '');
            const file = new File([bytes], item.path.split('/').pop() as string);
            Object.defineProperty(file, 'webkitRelativePath', { value: `${rootName}/${item.path}` });
            return file;
          });
          Object.defineProperty(input, 'files', { value: files, configurable: true });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        entries,
        root,
      );
    }

    const SETTLE_MS = 400;
    const settleAfterEdit = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    const waitForPreviewFrame = async (): Promise<Frame> => {
      await page.waitForFunction(
        () => (document.querySelector('iframe.html-preview-frame') as HTMLIFrameElement | null)?.contentDocument?.designMode === 'on',
        { timeout: 30_000 },
      );
      return (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
    };

    const imageLoadedIn = (frame: Frame): Promise<unknown> =>
      frame.waitForFunction(() => {
        const image = document.querySelector('img');
        return image !== null && image.complete && image.naturalWidth > 0;
      });

    const pdfImageCount = (bytes: number[]): number => {
      const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-pdfimg-')), 'out.pdf');
      writeFileSync(path, Buffer.from(bytes));
      return execFileSync('pdfimages', ['-list', path], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line)).length;
    };

    const outputTo = async (label: string): Promise<void> => {
      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(
        (text) => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes(text))?.disabled ?? true),
        {},
        label,
      );
      await clickButton(label);
      await page.waitForSelector('.notice-success', { timeout: 60_000 });
    };

    const readOpfs = (path: string): Promise<number[] | null> =>
      page.evaluate(async (target) => {
        let dir = await navigator.storage.getDirectory();
        const segments = target.split('/');
        try {
          for (const segment of segments.slice(0, -1)) {
            dir = await dir.getDirectoryHandle(segment);
          }
          const file = await (await dir.getFileHandle(segments[segments.length - 1] as string)).getFile();
          return [...new Uint8Array(await file.arrayBuffer())];
        } catch {
          return null;
        }
      }, path);

    const listOpfsRoot = (): Promise<string[]> =>
      page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(name);
        }
        return names.sort();
      });

    const INDEX_HTML =
      '<!DOCTYPE html>\n<html>\n<head>\n<link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n<h1>見出し</h1>\n<p>本文</p>\n<img src="images/a.png" alt="図">\n</body>\n</html>\n';
    const SITE: Entry[] = [
      { path: 'index.html', text: INDEX_HTML },
      { path: 'css/style.css', text: 'h1 { color: rgb(204, 0, 0); }\nbody { background: url(../images/bg.png) }' },
      { path: 'css/unused.css', text: 'p { color: blue }' },
      { path: 'images/a.png', base64: PNG },
      { path: 'images/bg.png', base64: PNG },
    ];

    it('HTMLを含むフォルダを取り込むと、参照しているCSS・画像が、フォルダ内の位置のとおりに読み込まれて表示される', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);

      expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
      // CSS内の url(../images/bg.png) は、CSSのフォルダを基準に解決される
      expect(await frame.$eval('body', (element) => getComputedStyle(element).backgroundImage)).toContain('blob:');
      // HTMLが参照しているCSSだけを取り込む(フォルダ内の他のCSSは取り込まない)
      expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(直接編集)', 'HTML', 'CSS: css/style.css']);
      expect(await page.$('.warning-list')).toBeNull();
      expect(consoleErrors).toEqual([]);
      await shot('15-folder-html');
    });

    it('編集していなければ、画像を埋め込んだプレビューから差分を取っても、HTMLの画像の参照は変わらない', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      await frame.evaluate(() => document.dispatchEvent(new Event('input')));
      await settleAfterEdit();

      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      expect(await page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value)).toBe(INDEX_HTML);
    });

    it('プレビューで文字を編集しても、画像の参照(images/a.png)は、data: URIに書き換わらない', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      await (await page.$('iframe.html-preview-frame'))?.click();
      await frame.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('p') as HTMLElement);
        range.collapse(false);
        const selection = window.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.keyboard.type('(追記)');
      await settleAfterEdit();

      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      const source = await page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value);
      expect(source).toBe(INDEX_HTML.replace('<p>本文</p>', '<p>本文(追記)</p>'));
      expect(source).not.toContain('data:');
      expect(source).not.toContain('blob:');
    });

    it('HTML・CSS・PDFを出力すると、CSSは<link>が指している位置(css/style.css)に保存され、PDFには画像が入り、HTML・CSSは取り込んだまま', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      await outputTo('選んだフォルダへHTMLとCSSとPDFを出力');

      expect(await listOpfsRoot()).toEqual(['css', 'index.html', 'index.pdf']);
      expect(Buffer.from((await readOpfs('index.html')) ?? []).toString('utf8')).toBe(INDEX_HTML);
      expect(Buffer.from((await readOpfs('css/style.css')) ?? []).toString('utf8')).toBe(SITE[1]?.text);
      expect(pdfImageCount((await readOpfs('index.pdf')) ?? [])).toBeGreaterThan(0);
      await shot('16-folder-html-output');
    });

    it('フォルダを実際にドラッグ&ドロップすると、下位のフォルダのCSS・画像まで読み込まれる(隠しフォルダ・node_modulesは読まない)', async () => {
      const site = mkdtempSync(join(tmpdir(), 'md-pdf-editor-drop-'));
      for (const directory of ['css', 'images', '.git', 'node_modules']) {
        mkdirSync(join(site, directory));
      }
      writeFileSync(join(site, 'index.html'), INDEX_HTML);
      writeFileSync(join(site, 'css/style.css'), 'h1 { color: rgb(204, 0, 0); }');
      writeFileSync(join(site, 'images/a.png'), Buffer.from(PNG, 'base64'));
      // 隠しフォルダ・node_modulesの中のHTMLは、候補に入らない(入れば、開くファイルの選択になる)
      writeFileSync(join(site, '.git/other.html'), '<p>x</p>');
      writeFileSync(join(site, 'node_modules/lib.html'), '<p>x</p>');

      await page.goto(baseUrl);
      await page.waitForSelector('.drop-zone');
      const box = await (await page.$('.drop-zone'))?.boundingBox();
      const client = await page.createCDPSession();
      const data = { items: [], files: [site], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await client.send('Input.dispatchDragEvent', { type, x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2, data });
      }
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
      expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(直接編集)', 'HTML', 'CSS: css/style.css']);
      rmSync(site, { recursive: true, force: true });
    });

    it('見つからない画像と外部の画像は、区別して警告する', async () => {
      await importFolder([{ path: 'a.html', text: '<p>x</p><img src="images/none.png"><img src="https://example.com/a.png">' }]);
      await waitForPreviewFrame();
      const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
      expect(warnings).toContain('見つからない画像');
      expect(warnings).toContain('外部の画像');
    });

    it('ファイルを個別に選んだ場合は、HTMLの<img src="images/a.png">が、選んだ画像(a.png)にファイル名で対応する', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-flat-'));
      writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html>\n<body>\n<img src="images/a.png">\n</body>\n');
      writeFileSync(join(dir, 'a.png'), Buffer.from(PNG, 'base64'));
      await page.goto(baseUrl);
      await page.waitForSelector('input[type=file]', { hidden: true });
      await ((await page.$('input[type=file]')) as ElementHandle<HTMLInputElement>).uploadFile(join(dir, 'index.html'), join(dir, 'a.png'));
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      expect(await page.$('.warning-list')).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it('フォルダにMarkdownまたはHTMLが複数あるときは、開くファイルを選べる', async () => {
      await importFolder([
        { path: 'a.html', text: '<p>HTMLの文書</p>' },
        { path: 'docs/b.md', text: '# Markdownの文書' },
      ]);
      await page.waitForSelector('.choose-list');
      expect(await page.$$eval('.choose-list button', (buttons) => buttons.map((button) => button.textContent))).toEqual(['a.html', 'docs/b.md']);
      await clickButton('docs/b.md');
      await page.waitForSelector('.md-editor-content h1');
      expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(書式付きで編集)', 'Markdown']);
    });

    it('MarkdownやHTMLが無いフォルダは、取り込まず理由を表示する', async () => {
      await importFolder([{ path: 'images/a.png', base64: PNG }]);
      await page.waitForSelector('[role="alert"]');
      expect(await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText)).toContain('見つかりません');
    });

    it('Markdownの画像(![図](img/a.png))を、フォルダ内の位置のとおりに、エディタに表示し、PDFにも入れる(Markdownの本文は変わらない)', async () => {
      const markdown = '# 題\n\n![図](img/a.png)\n';
      await importFolder([
        { path: 'docs/guide.md', text: markdown },
        { path: 'docs/img/a.png', base64: PNG },
      ]);
      await page.waitForSelector('.md-editor-content h1');
      await page.waitForFunction(() => {
        const image = document.querySelector('.md-editor-content img') as HTMLImageElement | null;
        return image !== null && image.complete && image.naturalWidth > 0;
      });
      expect(await page.$('.warning-list')).toBeNull();

      await page.click('.md-editor-content h1');
      await page.keyboard.press('End');
      await page.keyboard.type('改');
      await clickButton('Markdown');
      const edited = await sourceValue();
      expect(edited).toContain('# 題改');
      expect(edited).toContain('![図](img/a.png)');
      expect(edited).not.toContain('data:');
      expect(edited).not.toContain('blob:');

      await outputTo('選んだフォルダへMDとPDFを出力');
      expect(await listOpfsRoot()).toEqual(['guide.md', 'guide.pdf']);
      expect(Buffer.from((await readOpfs('guide.md')) ?? []).toString('utf8')).toContain('![図](img/a.png)');
      expect(pdfImageCount((await readOpfs('guide.pdf')) ?? [])).toBeGreaterThan(0);
      await shot('17-folder-markdown');
    });

    it('Markdownの画像が見つからない場合は、警告する', async () => {
      await importFolder([{ path: 'a.md', text: '![図](images/none.png)' }]);
      await page.waitForSelector('.warning-list');
      expect(await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText)).toContain('表示できない画像');
    });
  });
  });

  it('「PDFを生成して確認」でPDFが新しいタブに開く', async () => {
    await openEditor(SAMPLE);
    const popupPromise = new Promise<Page>((resolve) => {
      browser.once('targetcreated', (target) => void target.page().then((created) => resolve(created as Page)));
    });
    await clickButton('PDFを生成して確認');
    const popup = await popupPromise;
    await popup.waitForFunction(() => location.href.startsWith('blob:'), { timeout: 60_000 });
    expect(popup.url()).toMatch(/^blob:http:\/\/127\.0\.0\.1:\d+\//);
    await popup.close();
  });
});

describe('コードブロックの色分けとMermaidの図(実ブラウザ)', () => {
  const FLOW = 'graph TD\n  A[開始] --> B{判定}\n  B -->|はい| C[処理]\n  B -->|いいえ| D[終了]';

  // 色分けされた(クラスの付いた)文字の数。コードブロックごと
  const coloredSpans = (): Promise<number[]> =>
    page.$$eval('.cm-editor', (editors) => editors.map((editor) => editor.querySelectorAll('.cm-line span[class]').length));

  const diagramLoaded = (): Promise<unknown> =>
    page.waitForFunction(() => {
      const image = document.querySelector('.mermaid-image') as HTMLImageElement | null;
      return image !== null && image.complete && image.naturalWidth > 0;
    });

  it('Python・JavaScriptなど、言語名のあるコードブロックは、エディタ上で色分けされる', async () => {
    await openEditor('```python\ndef f(x):\n    return "a"\n```\n\n```js\nconst x = 1; // メモ\n```');
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-editor')].every((editor) => editor.querySelectorAll('.cm-line span[class]').length > 0));
    expect((await coloredSpans()).every((count) => count > 0)).toBe(true);
  });

  it('エディタの言語一覧に無い言語(Ruby・PHP・Kotlin・PowerShellなど)も、色分けされる', async () => {
    const samples: [string, string][] = [
      ['ruby', 'def hello(name)\n  puts "hi"\nend'],
      ['php', '<?php\necho "hi";'],
      ['kotlin', 'fun main() {\n  println("hi")\n}'],
      ['powershell', 'Get-ChildItem -Path . | Where-Object { $_.Length -gt 1 }'],
      ['dockerfile', 'FROM node:24\nRUN npm ci'],
      ['toml', '[server]\nport = 8080'],
      ['swift', 'let x: Int = 1'],
      ['lua', 'local x = 1\nprint(x)'],
      ['perl', 'my $x = 1; print $x;'],
    ];
    await openEditor(samples.map(([language, code]) => '```' + language + '\n' + code + '\n```').join('\n\n'));
    await page.waitForFunction(
      (count) => {
        const editors = [...document.querySelectorAll('.cm-editor')];
        return editors.length === count && editors.every((editor) => editor.querySelectorAll('.cm-line span[class]').length > 0);
      },
      { timeout: 30_000 },
      samples.length,
    );
    expect((await coloredSpans()).every((count) => count > 0)).toBe(true);
  });

  it('言語名の無いコードブロック・テキストは、色分けされない', async () => {
    await openEditor('```\nplain text\n```\n\n```txt\nplain text\n```');
    await page.waitForFunction(() => document.querySelectorAll('.cm-editor').length === 2);
    expect(await coloredSpans()).toEqual([0, 0]);
  });

  it('Mermaidのコードブロックは、コードの下に図が描画される(コードも編集できる)', async () => {
    await openEditor(`# 図\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``);
    await diagramLoaded();

    expect(await page.$eval('.mermaid-block .cm-content', (element) => (element as HTMLElement).innerText)).toContain('graph TD');
    expect(await page.$('.mermaid-error')).toBeNull();
    // 図は画像として表示されるため、図の中の文字は、ページの文字には混ざらない
    const size = await page.$eval('.mermaid-image', (element) => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }));
    expect(size.width).toBeGreaterThan(100);
    expect(size.height).toBeGreaterThan(100);
    await shot('18-mermaid-editor');
    expect(consoleErrors).toEqual([]);
  });

  it('図を表示しても、Markdownの本文は変わらない(図のSVGは、Markdownに入らない)', async () => {
    const markdown = `# 図\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n本文`;
    await openEditor(markdown);
    await diagramLoaded();
    await clickButton('Markdown');
    expect(await sourceValue()).toBe(markdown);
  });

  it('Mermaidのコードを編集すると、図が更新され、Markdownにはコードだけが反映される', async () => {
    await openEditor('```mermaid\ngraph TD\n  A --> B\n```');
    await diagramLoaded();
    const before = await page.$eval('.mermaid-image', (element) => (element as HTMLImageElement).src);

    await page.click('.mermaid-block .cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type('graph LR; X[新しい図]-->Y; Y-->Z');
    await page.waitForFunction((previous) => (document.querySelector('.mermaid-image') as HTMLImageElement | null)?.src !== previous, {}, before);
    await diagramLoaded();

    await clickButton('Markdown');
    const edited = await sourceValue();
    expect(edited).toContain('graph LR; X[新しい図]-->Y; Y-->Z');
    expect(edited).not.toContain('<svg');
    expect(edited).not.toContain('data:image');
  });

  it('構文が誤っているMermaidは、図の代わりに理由を表示し、直すと図になる', async () => {
    await openEditor('```mermaid\ngraph TD\n  A[ --> B\n```');
    await page.waitForSelector('.mermaid-error');
    expect(await page.$eval('.mermaid-error', (element) => (element as HTMLElement).innerText)).toContain('図を描画できません');
    expect(await page.$('.mermaid-image')).toBeNull();
    await shot('19-mermaid-error');

    await page.click('.mermaid-block .cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type('graph TD; A-->B');
    await diagramLoaded();
    expect(await page.$('.mermaid-error')).toBeNull();
  });

  it('言語をMermaid以外に切り替えると、図は表示されず、通常のコードブロックになる', async () => {
    await openEditor('```mermaid\ngraph TD\n  A --> B\n```');
    await diagramLoaded();
    // 言語の選択は、標準の<select>ではなく、独自のドロップダウン
    const trigger = await page.evaluateHandle(() => [...document.querySelectorAll('[role="combobox"]')].find((element) => element.textContent?.includes('Mermaid')) ?? null);
    await (trigger.asElement() as ElementHandle<Element>).click();
    await page.waitForSelector('[role="option"]');
    const option = await page.evaluateHandle(() => [...document.querySelectorAll('[role="option"]')].find((element) => element.textContent?.includes('Python')) ?? null);
    await (option.asElement() as ElementHandle<Element>).click();
    await page.waitForFunction(() => document.querySelector('.mermaid-block') === null);
    expect(await page.$('.mermaid-image')).toBeNull();
    await clickButton('Markdown');
    expect(await sourceValue()).toContain('```python');
  });

  describe('PDFでの表示の選択', () => {
    const radioState = (): Promise<string[]> =>
      page.$$eval('.mermaid-view input[type="radio"]', (inputs) => inputs.filter((input) => (input as HTMLInputElement).checked).map((input) => input.parentElement?.textContent?.trim() ?? ''));

    const choose = async (label: string): Promise<void> => {
      const handle = await page.evaluateHandle(
        (text) => [...document.querySelectorAll('.mermaid-view label')].find((element) => element.textContent?.includes(text)) ?? null,
        label,
      );
      await (handle.asElement() as ElementHandle<Element>).click();
    };

    it('書かなければ「図のみ」が選ばれていて、Markdownは変わらない', async () => {
      const markdown = `\`\`\`mermaid\n${FLOW}\n\`\`\``;
      await openEditor(markdown);
      await diagramLoaded();
      expect(await radioState()).toEqual(['図のみ']);
      await clickButton('Markdown');
      expect(await sourceValue()).toBe(markdown);
    });

    it('「コードと図」「コードのみ」を選ぶと、Markdownの言語名の後ろに show= が書かれ、図のみに戻すと消える', async () => {
      await openEditor(`\`\`\`mermaid\n${FLOW}\n\`\`\``);
      await diagramLoaded();

      await choose('コードと図');
      expect(await radioState()).toEqual(['コードと図']);
      await clickButton('Markdown');
      expect(await sourceValue()).toBe(`\`\`\`mermaid show=both\n${FLOW}\n\`\`\``);

      await clickButton('プレビュー');
      await diagramLoaded();
      expect(await radioState()).toEqual(['コードと図']);
      await choose('コードのみ');
      await clickButton('Markdown');
      expect(await sourceValue()).toBe(`\`\`\`mermaid show=code\n${FLOW}\n\`\`\``);

      await clickButton('プレビュー');
      await diagramLoaded();
      await choose('図のみ');
      await clickButton('Markdown');
      expect(await sourceValue()).toBe(`\`\`\`mermaid\n${FLOW}\n\`\`\``);
    });

    it('Markdownに show=both と書いてあれば、取り込み時に反映され、編集しても保たれる', async () => {
      await openEditor(`\`\`\`mermaid show=both\n${FLOW}\n\`\`\``);
      await diagramLoaded();
      expect(await radioState()).toEqual(['コードと図']);

      await page.click('.mermaid-block .cm-content');
      await page.keyboard.down('Control');
      await page.keyboard.press('End');
      await page.keyboard.up('Control');
      await page.keyboard.type('\n  D --> E');
      await clickButton('Markdown');
      const edited = await sourceValue();
      expect(edited).toContain('```mermaid show=both');
      expect(edited).toContain('D --> E');
    });

    it('ブロックごとに別々に選べる', async () => {
      await openEditor(`\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; C-->D\n\`\`\``);
      await page.waitForFunction(() => document.querySelectorAll('.mermaid-image').length === 2);
      await page.evaluate(() => {
        const second = [...document.querySelectorAll('.mermaid-block')][1];
        const both = [...(second?.querySelectorAll('.mermaid-view label') ?? [])].find((label) => label.textContent?.includes('コードと図')) as HTMLElement;
        both.click();
      });
      await clickButton('Markdown');
      expect(await sourceValue()).toBe('```mermaid\ngraph TD; A-->B\n```\n\n```mermaid show=both\ngraph TD; C-->D\n```');
    });

    it('選んだとおりにPDFが作られる(コードのみ: 図は出ず、コードが出る)', async () => {
      await openEditor(`\`\`\`mermaid show=code\n${FLOW}\n\`\`\``);
      await diagramLoaded();
      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(
        () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへ'))?.disabled ?? true),
      );
      await clickButton('選んだフォルダへ');
      await page.waitForSelector('.notice-success', { timeout: 60_000 });
      const bytes = await page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const file = await (await dir.getFileHandle('document.pdf')).getFile();
        return [...new Uint8Array(await file.arrayBuffer())];
      });
      const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-view-')), 'out.pdf');
      writeFileSync(path, Buffer.from(bytes));
      expect(execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' })).toContain('graph TD');
    });
  });

  it('PDFには、Mermaidの図(日本語の文字つき)が入り、コードはPDFに出ない', async () => {
    await openEditor(`# 図のある文書\n\n\`\`\`python\ndef f():\n    return 1\n\`\`\`\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``);
    await diagramLoaded();
    await clickButton('出力先フォルダを選択');
    await page.waitForFunction(
      () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへ'))?.disabled ?? true),
    );
    await clickButton('選んだフォルダへ');
    await page.waitForSelector('.notice-success', { timeout: 60_000 });

    const bytes = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const file = await (await dir.getFileHandle('document.pdf')).getFile();
      return [...new Uint8Array(await file.arrayBuffer())];
    });
    const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-mermaid-')), 'out.pdf');
    writeFileSync(path, Buffer.from(bytes));
    const text = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
    for (const label of ['図のある文書', 'def f():', '開始', '判定', '処理', '終了']) {
      expect(text, label).toContain(label);
    }
    expect(text).not.toContain('graph TD');
  });
});

describe('画像のドラッグ&ドロップによる埋め込み(実ブラウザ)', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const HTML_PAGE = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>t</title>\n</head>\n<body>\n<h1>見出し</h1>\n<p>本文です。</p>\n</body>\n</html>\n';
  const DATA_PNG = /data:image\/png;base64,[A-Za-z0-9+/=]+/;
  let dir: string;
  const path = (name: string): string => join(dir, name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-embed-'));
    writeFileSync(path('a.png'), Buffer.from(PNG, 'base64'));
    writeFileSync(path('b.txt'), 'テキスト');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // 実際のファイルを、指定の位置へドロップする(ブラウザのドラッグ&ドロップそのもの)
  const dropAt = async (x: number, y: number, ...paths: string[]): Promise<void> => {
    const client = await page.createCDPSession();
    const data = { items: [], files: paths, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await client.send('Input.dispatchDragEvent', { type, x, y, data });
    }
    await client.detach();
  };

  const boxOf = async (handle: ElementHandle<Element> | null): Promise<{ x: number; y: number; width: number; height: number }> => {
    const box = await handle?.boundingBox();
    if (box === null || box === undefined) {
      throw new Error('ドロップ先の要素が見つかりません');
    }
    return box;
  };

  const dropOnCenter = async (handle: ElementHandle<Element> | null, ...paths: string[]): Promise<void> => {
    const box = await boxOf(handle);
    await dropAt(box.x + box.width / 2, box.y + box.height / 2, ...paths);
  };

  const noticeText = (): Promise<string> =>
    page.$eval('.notice-info[role="status"], .notice-error[role="alert"]', (element) => (element as HTMLElement).innerText);

  const setCaret = (selector: string, offset: number): Promise<void> =>
    page.$eval(
      selector,
      (element, position) => {
        const area = element as HTMLTextAreaElement;
        area.focus();
        area.setSelectionRange(position, position);
      },
      offset,
    );

  const textareaState = (selector: string): Promise<{ value: string; caret: number }> =>
    page.$eval(selector, (element) => ({ value: (element as HTMLTextAreaElement).value, caret: (element as HTMLTextAreaElement).selectionStart }));

  const selectPasteKind = (label: string): Promise<void> =>
    page.evaluate((text) => {
      const input = [...document.querySelectorAll('.paste-kind label')].find((l) => l.textContent?.includes(text))?.querySelector('input');
      (input as HTMLInputElement).click();
    }, label);

  const openHtml = async (html: string): Promise<Frame> => {
    await setPasted(html);
    await selectPasteKind('HTML');
    await clickButton('貼り付けた内容を読み込む');
    await page.waitForFunction(
      () => (document.querySelector('iframe.html-preview-frame') as HTMLIFrameElement | null)?.contentDocument?.designMode === 'on',
    );
    return (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
  };

  const outputPdfImageCount = async (): Promise<number> => {
    await clickButton('出力先フォルダを選択');
    await page.waitForFunction(
      () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへ'))?.disabled ?? true),
    );
    await clickButton('選んだフォルダへ');
    await page.waitForSelector('.notice-success', { timeout: 60_000 });
    const bytes = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('document.pdf')).getFile();
      return [...new Uint8Array(await file.arrayBuffer())];
    });
    const pdf = join(dir, 'out.pdf');
    writeFileSync(pdf, Buffer.from(bytes));
    return execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line)).length;
  };

  describe('Markdown(書式付きプレビュー)', () => {
    it('画像ファイルをドロップすると、画像として埋め込まれ、Markdownとして保存され、PDFにも入る', async () => {
      await openEditor('# 題\n\n本文です。');
      await page.waitForSelector('.md-editor-content p');
      await dropOnCenter(await page.$('.md-editor-content p'), path('a.png'));

      await page.waitForFunction(() => (document.querySelector('.md-editor-content img') as HTMLImageElement | null)?.src.startsWith('data:image/png;base64,'));
      expect(await noticeText()).toContain('画像「a.png」を埋め込みました');
      await shot('20-drop-markdown');

      // 画像を表示するだけでなく、Markdownの中に、画像のデータが入る(元の文章は、そのまま)
      expect(await page.$eval('.md-editor-content img', (element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await outputPdfImageCount()).toBeGreaterThan(0);
      await clickButton('Markdown');
      const markdown = await sourceValue();
      expect(markdown).toContain('# 題');
      expect(markdown).toContain('本文です。');
      expect(markdown).toMatch(/!\[\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
      expect(page.url()).toBe(`${baseUrl}/`);
      expect(consoleErrors).toEqual([]);
    });

    it('ドロップした位置(どの段落か)に、画像が入る(文書の末尾ではない)', async () => {
      await openEditor('AAA\n\nBBB\n\nCCC');
      await page.waitForSelector('.md-editor-content p');
      const first = (await page.$$('.md-editor-content p'))[0] ?? null;
      await dropOnCenter(first, path('a.png'));
      await page.waitForSelector('.md-editor-content img');
      await clickButton('Markdown');
      const markdown = await sourceValue();
      expect(markdown).toMatch(/^AAA!\[\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)\n\nBBB\n\nCCC$/);
    });

    it('文の途中にドロップすると、その位置に画像が入り、文が前後に分かれる', async () => {
      await openEditor('ABCDEFGHIJ');
      await page.waitForSelector('.md-editor-content p');
      // 5文字目と6文字目の間の、画面上の位置
      const point = await page.evaluate(() => {
        // エディタは、文字を<span>で包むため、文字のノードを探す
        const text = document.createTreeWalker(document.querySelector('.md-editor-content p') as Element, NodeFilter.SHOW_TEXT).nextNode() as Text;
        const range = document.createRange();
        range.setStart(text, 5);
        range.setEnd(text, 5);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      });
      await dropAt(point.x, point.y, path('a.png'));
      await page.waitForSelector('.md-editor-content img');
      await clickButton('Markdown');
      expect(await sourceValue()).toMatch(/^ABCDE!\[\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)FGHIJ$/);
    });

    it('埋め込んだ画像の大きさを変えると、MarkdownにはHTMLの<img>で書かれるが、警告は出ず、PDFには画像として、変えた大きさで入る', async () => {
      await openEditor('# 題\n\n本文です。');
      await page.waitForSelector('.md-editor-content p');
      // サイズ変更のつまみを操作できるよう、1x1ではない画像を、ブラウザで作る
      const wide = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 160;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        context.fillStyle = '#2563eb';
        context.fillRect(0, 0, 320, 160);
        return canvas.toDataURL('image/png').split(',')[1] as string;
      });
      writeFileSync(path('wide.png'), Buffer.from(wide, 'base64'));
      await dropOnCenter(await page.$('.md-editor-content p'), path('wide.png'));
      await page.waitForSelector('.md-editor-content img');
      await page.click('.md-editor-content img');
      await page.waitForSelector('[class*="imageResizerSe"]');
      const handle = await page.evaluate(() => {
        const rect = document.querySelector('[class*="imageResizerSe"]')?.getBoundingClientRect() as DOMRect;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x + 40, handle.y + 40, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.md-editor-content img')?.getAttribute('width') !== null);

      // エディタは、大きさを変えた画像を、<img>のタグで書き出す
      await clickButton('Markdown');
      const markdown = await sourceValue();
      expect(markdown).toMatch(/<img [^>]*src="data:image\/png;base64,[A-Za-z0-9+/=]+"[^>]*\/>/);
      expect(markdown).toMatch(/width="\d+/);
      // 画像として表示されるため、「HTMLタグは文字として表示される」という警告は出ない
      expect(await page.$('.warning-list')).toBeNull();

      // PDFには、画像が入り、タグの文字は出ない
      const bytes = await (async () => {
        await clickButton('出力先フォルダを選択');
        await page.waitForFunction(
          () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへ'))?.disabled ?? true),
        );
        await clickButton('選んだフォルダへ');
        await page.waitForSelector('.notice-success', { timeout: 60_000 });
        return page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const file = await (await root.getFileHandle('document.pdf')).getFile();
          return [...new Uint8Array(await file.arrayBuffer())];
        });
      })();
      const pdf = join(dir, 'resized.pdf');
      writeFileSync(pdf, Buffer.from(bytes));
      expect(execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8' }).split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line)).length).toBeGreaterThan(0);
      const text = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
      expect(text).not.toContain('<img');
      expect(text).not.toContain('base64');
      expect(text).toContain('本文です。');
    });

    it('画像でないファイルをドロップすると、ブラウザがそのファイルを開かず、文書も変わらず、理由が表示される', async () => {
      const original = '# 題\n\n本文です。';
      await openEditor(original);
      await page.waitForSelector('.md-editor-content p');
      await dropOnCenter(await page.$('.md-editor-content p'), path('b.txt'));

      await page.waitForSelector('.notice-error[role="alert"]');
      expect(await noticeText()).toContain('「b.txt」は画像として埋め込めません');
      expect(page.url()).toBe(`${baseUrl}/`);
      expect(await page.$('.md-editor-content img')).toBeNull();
      await clickButton('Markdown');
      expect(await sourceValue()).toBe(original);
    });

    it('大きすぎる画像は、埋め込まず、理由が表示される', async () => {
      writeFileSync(path('big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
      await openEditor('# 題');
      await dropOnCenter(await page.$('.md-editor-content h1'), path('big.png'));
      await page.waitForSelector('.notice-error[role="alert"]');
      expect(await noticeText()).toContain('「big.png」は大きすぎるため埋め込めません');
      expect(await page.$('.md-editor-content img')).toBeNull();
    });

    it('画像と画像でないファイルを一緒にドロップすると、何も埋め込まず、理由が表示される', async () => {
      await openEditor('# 題');
      await dropOnCenter(await page.$('.md-editor-content h1'), path('a.png'), path('b.txt'));
      await page.waitForSelector('.notice-error[role="alert"]');
      expect(await page.$('.md-editor-content img')).toBeNull();
    });

    it('クリップボードの画像(スクリーンショットなど)を貼り付けても、埋め込まれる', async () => {
      await openEditor('# 題\n\n本文です。');
      await page.click('.md-editor-content p');
      await page.evaluate((base64) => {
        const file = new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(file);
        document.querySelector('.md-editor-content p')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, PNG);
      await page.waitForFunction(() => (document.querySelector('.md-editor-content img') as HTMLImageElement | null)?.src.startsWith('data:image/png;base64,'));
      expect(await noticeText()).toContain('画像「image.png」を埋め込みました');
    });
  });

  describe('Markdown(ソース)', () => {
    const SOURCE = 'AAA\nBBB';

    it('画像ファイルをドロップすると、カーソルの位置に、独立した段落として挿入され、カーソルは画像の後ろに移る', async () => {
      await openEditor(SOURCE);
      await clickButton('Markdown');
      await page.waitForSelector('textarea[aria-label="Markdown"]');
      await setCaret('textarea[aria-label="Markdown"]', 3);
      await dropOnCenter(await page.$('textarea[aria-label="Markdown"]'), path('a.png'));

      await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Markdown"]') as HTMLTextAreaElement).value.includes('data:image/png'));
      const { value, caret } = await textareaState('textarea[aria-label="Markdown"]');
      const image = /!\[a\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/.exec(value)?.[0] ?? '';
      expect(image).not.toBe('');
      expect(value).toBe(`AAA\n\n${image}\n\nBBB`);
      expect(caret).toBe(`AAA\n\n${image}`.length);
      expect(await noticeText()).toContain('画像「a.png」を埋め込みました');
      expect(page.url()).toBe(`${baseUrl}/`);

      // 書式付きプレビューに戻すと、画像として表示される
      await clickButton('プレビュー');
      await page.waitForFunction(() => (document.querySelector('.md-editor-content img') as HTMLImageElement | null)?.naturalWidth! > 0);
    });

    it('画像でないファイルをドロップしても、ブラウザがそのファイルを開かず、内容も変わらず、理由が表示される', async () => {
      await openEditor(SOURCE);
      await clickButton('Markdown');
      await page.waitForSelector('textarea[aria-label="Markdown"]');
      await dropOnCenter(await page.$('textarea[aria-label="Markdown"]'), path('b.txt'));
      await page.waitForSelector('.notice-error[role="alert"]');
      expect(await noticeText()).toContain('「b.txt」は画像として埋め込めません');
      expect(page.url()).toBe(`${baseUrl}/`);
      expect((await textareaState('textarea[aria-label="Markdown"]')).value).toBe(SOURCE);
    });
  });

  describe('HTML', () => {
    it('プレビューへ画像ファイルをドロップすると、ドロップした位置に画像が入り、HTMLには、その画像の分だけが加わる', async () => {
      const frame = await openHtml(HTML_PAGE);
      const box = await boxOf(await frame.$('p'));
      // 文の右側(行末)にドロップする
      await dropAt(box.x + box.width - 5, box.y + box.height / 2, path('a.png'));

      await frame.waitForSelector('img[src^="data:image/png;base64,"]');
      expect(await noticeText()).toContain('画像「a.png」を埋め込みました');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await shot('21-drop-html-preview');

      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      const { value } = await textareaState('textarea[aria-label="HTML"]');
      expect(value).toMatch(new RegExp(`<img src="${DATA_PNG.source}" alt="a">`));
      // 加わったのは画像だけ。それ以外のHTMLは、取り込んだままである
      expect(value.replace(new RegExp(`<img src="${DATA_PNG.source}" alt="a">`), '')).toBe(HTML_PAGE);
      expect(page.url()).toBe(`${baseUrl}/`);
    });

    it('画像でないファイルをプレビューへドロップしても、プレビューは別の文書に切り替わらず、理由が表示される', async () => {
      const frame = await openHtml(HTML_PAGE);
      await dropOnCenter(await frame.$('p'), path('b.txt'));
      await page.waitForSelector('.notice-error[role="alert"]');
      expect(await noticeText()).toContain('「b.txt」は画像として埋め込めません');
      expect(await frame.$('h1')).not.toBeNull();
      await clickButton('HTML');
      expect((await textareaState('textarea[aria-label="HTML"]')).value).toBe(HTML_PAGE);
    });

    it('HTMLタブへドロップすると、カーソルの位置に <img> が挿入され、隣の読み取り専用のプレビューにも表示される。プレビューは、別の文書に切り替わらない', async () => {
      await openHtml(HTML_PAGE);
      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      const position = HTML_PAGE.indexOf('<p>');
      await setCaret('textarea[aria-label="HTML"]', position);
      await dropOnCenter(await page.$('textarea[aria-label="HTML"]'), path('a.png'));

      await page.waitForFunction(() => (document.querySelector('textarea[aria-label="HTML"]') as HTMLTextAreaElement).value.includes('<img src="data:image/png'));
      const { value, caret } = await textareaState('textarea[aria-label="HTML"]');
      const tag = new RegExp(`<img src="${DATA_PNG.source}" alt="a">`).exec(value)?.[0] ?? '';
      expect(value).toBe(HTML_PAGE.slice(0, position) + tag + HTML_PAGE.slice(position));
      expect(caret).toBe(position + tag.length);

      const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
      await side.waitForSelector('img[src^="data:image/png"]');

      // 読み取り専用のプレビューへのドロップでも、プレビューは、別の文書に切り替わらない
      await dropOnCenter(await page.$('iframe.html-preview-frame'), path('b.txt'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(page.url()).toBe(`${baseUrl}/`);
      expect(await side.$('h1')).not.toBeNull();
    });

    it('CSSタブへドロップすると、カーソルの位置に url("data:…") が挿入される', async () => {
      writeFileSync(path('index.html'), '<!DOCTYPE html>\n<html>\n<head>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n<p>本文</p>\n</body>\n</html>\n');
      writeFileSync(path('style.css'), 'body { background: red; }\n');
      await page.goto(baseUrl);
      await page.waitForSelector('input[type=file]', { hidden: true });
      await ((await page.$('input[type=file]')) as ElementHandle<HTMLInputElement>).uploadFile(path('index.html'), path('style.css'));
      await page.waitForFunction(() => [...document.querySelectorAll('.tab')].some((tab) => tab.textContent === 'CSS: style.css'));
      await clickButton('CSS: style.css');
      await page.waitForSelector('textarea[aria-label="CSS: style.css"]');
      await setCaret('textarea[aria-label="CSS: style.css"]', 'body { background: '.length);
      await dropOnCenter(await page.$('textarea[aria-label="CSS: style.css"]'), path('a.png'));

      await page.waitForFunction(() => (document.querySelector('textarea[aria-label="CSS: style.css"]') as HTMLTextAreaElement).value.includes('url("data:image/png'));
      const { value } = await textareaState('textarea[aria-label="CSS: style.css"]');
      expect(value).toMatch(new RegExp(`^body \\{ background: url\\("${DATA_PNG.source}"\\)red; \\}\\n$`));
    });
  });
});

describe('空行(空の段落)(実ブラウザ)', () => {
  const NBSP_CHAR = '\u00a0';
  const BASE = '# 題\n\n最初の段落です。\n';

  const markdownTab = async (): Promise<string> => {
    await clickButton('Markdown');
    await page.waitForSelector('textarea[aria-label="Markdown"]');
    return sourceValue();
  };

  // 「最初の段落」の末尾で、Enterを3回押し(空の段落を2つ作り)、文字を入力する
  const typeAfterBlankParagraphs = async (): Promise<void> => {
    await page.click('.md-editor-content p');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('空行のあとの段落です。');
    await new Promise((resolve) => setTimeout(resolve, 500));
  };

  const paragraphTexts = (): Promise<string[]> => page.$$eval('.md-editor-content p', (items) => items.map((item) => item.textContent ?? ''));

  it('Enterで空行を作って文字を入力すると、Markdownには、空の段落が「&nbsp;」の段落として保存される(空行が重なるだけにならない)', async () => {
    await openEditor(BASE);
    await typeAfterBlankParagraphs();
    expect(await paragraphTexts()).toEqual(['最初の段落です。', '', '', '空行のあとの段落です。']);

    const markdown = await markdownTab();
    expect(markdown).toBe('# 題\n\n最初の段落です。\n\n&nbsp;\n\n&nbsp;\n\n空行のあとの段落です。');
    // 見えない空白(U+00A0)そのものは、保存されない
    expect(markdown).not.toContain(NBSP_CHAR);
    expect(markdown).not.toMatch(/\n{4,}/);
  });

  it('PDFでも、空行が詰まらず、空の段落の数だけ、段落の間が空く', async () => {
    await openEditor(BASE);
    await typeAfterBlankParagraphs();
    const markdown = await markdownTab();

    const gapOf = async (text: string): Promise<number> => {
      const response = await fetch(`${baseUrl}/api/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: text }) });
      expect(response.status).toBe(200);
      const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-blank-')), 'out.pdf');
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      const xml = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8' });
      const y = (word: string): number => Number(new RegExp(`yMin="([\\d.]+)"[^>]*>${word}</word>`).exec(xml)?.[1]);
      return y('空行のあとの段落です。') - y('最初の段落です。');
    };
    const withBlanks = await gapOf(markdown);
    const withoutBlanks = await gapOf('# 題\n\n最初の段落です。\n\n空行のあとの段落です。');
    // 空の段落2つ分(1つにつき約25pt)
    expect(withBlanks - withoutBlanks).toBeGreaterThan(44);
    expect(withBlanks - withoutBlanks).toBeLessThan(56);
  });

  it('Markdownタブへ切り替えて、プレビューに戻っても、空の段落が残る(消えない)', async () => {
    await openEditor(BASE);
    await typeAfterBlankParagraphs();
    await markdownTab();
    await clickButton('プレビュー');
    await page.waitForSelector('.md-editor-content h1');
    expect(await paragraphTexts()).toEqual(['最初の段落です。', '', '', '空行のあとの段落です。']);
  });

  it('空の段落に文字を入力しても、先頭に見えない空白が残らない', async () => {
    await openEditor('# 題\n\n最初の段落です。\n\n&nbsp;\n\n&nbsp;\n\n最後の段落です。');
    await page.waitForFunction(() => document.querySelectorAll('.md-editor-content p').length === 4);
    // 2番目の段落(1つ目の空の段落)に入力する
    await (await page.$$('.md-editor-content p'))[1]?.click();
    await page.keyboard.type('追加した段落');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const markdown = await markdownTab();
    expect(markdown).toBe('# 題\n\n最初の段落です。\n\n追加した段落\n\n&nbsp;\n\n最後の段落です。');
    expect(markdown).not.toContain(NBSP_CHAR);
  });

  it('「&nbsp;」の段落を含むMarkdownは、編集しなければ、取り込んだままで、プレビューには空の段落として表示される', async () => {
    const markdown = '# 題\n\n&nbsp;\n\n最初の段落です。\n\n&nbsp;\n\n&nbsp;\n\n最後の段落です。';
    await openEditor(markdown);
    await page.waitForFunction(() => document.querySelectorAll('.md-editor-content p').length === 5);
    expect(await paragraphTexts()).toEqual(['', '最初の段落です。', '', '', '最後の段落です。']);
    expect(await markdownTab()).toBe(markdown);
  });

  it('末尾に、エディタが置く空の段落(表で終わる文書など)は、保存されない', async () => {
    await openEditor('# 題\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    await page.waitForSelector('.md-editor-content table');
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.type('(編集)');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const markdown = await markdownTab();
    expect(markdown).toContain('# 題(編集)');
    expect(markdown).not.toContain('&nbsp;');
  });

  describe('段落の中の改行(Shift+Enter)', () => {
    const shiftEnter = async (times: number): Promise<void> => {
      await page.keyboard.down('Shift');
      for (let count = 0; count < times; count += 1) {
        await page.keyboard.press('Enter');
      }
      await page.keyboard.up('Shift');
    };

    const typeAfterLineBreaks = async (times: number): Promise<void> => {
      await page.click('.md-editor-content p');
      await page.keyboard.press('End');
      await shiftEnter(times);
      await page.keyboard.type('改行のあとの文です。');
      await new Promise((resolve) => setTimeout(resolve, 500));
    };

    it('改行が続くとき(2つ以上)は、強制改行(行末の「\\」)として保存され、1つの段落のまま、段落が分かれない', async () => {
      await openEditor(`${BASE}\n次の段落です。`);
      await typeAfterLineBreaks(3);
      // プレビューは、1つの段落の中に、改行が3つ
      expect(await paragraphTexts()).toEqual(['最初の段落です。改行のあとの文です。', '次の段落です。']);
      expect(await page.$$eval('.md-editor-content p br', (items) => items.length)).toBe(3);
      expect(await markdownTab()).toBe('# 題\n\n最初の段落です。\\\n\\\n\\\n改行のあとの文です。\n\n次の段落です。');
    });

    it('改行が1つだけのときは、これまでどおり、ただの改行(「\\」を付けない)', async () => {
      await openEditor(`${BASE}\n次の段落です。`);
      await typeAfterLineBreaks(1);
      expect(await markdownTab()).toBe('# 題\n\n最初の段落です。\n改行のあとの文です。\n\n次の段落です。');
    });

    it('Markdownタブへ切り替えて、プレビューに戻っても、改行が3つの1つの段落のまま(段落の数が変わらない)', async () => {
      await openEditor(`${BASE}\n次の段落です。`);
      await typeAfterLineBreaks(3);
      await markdownTab();
      await clickButton('プレビュー');
      await page.waitForSelector('.md-editor-content h1');
      expect(await paragraphTexts()).toEqual(['最初の段落です。改行のあとの文です。', '次の段落です。']);
      expect(await page.$$eval('.md-editor-content p br', (items) => items.length)).toBe(3);
    });

    it('PDFでも、改行の数だけ、行が空く(段落が分かれて、詰まったりしない)', async () => {
      await openEditor(`${BASE}\n次の段落です。`);
      await typeAfterLineBreaks(3);
      const markdown = await markdownTab();
      const lineGap = async (text: string): Promise<number> => {
        const response = await fetch(`${baseUrl}/api/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: text }) });
        expect(response.status).toBe(200);
        const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-break-')), 'out.pdf');
        writeFileSync(path, Buffer.from(await response.arrayBuffer()));
        const xml = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8' });
        const y = (word: string): number => Number(new RegExp(`yMin="([\\d.]+)"[^>]*>${word}</word>`).exec(xml)?.[1]);
        return y('改行のあとの文です。') - y('最初の段落です。');
      };
      const withBreaks = await lineGap(markdown);
      const withoutBreaks = await lineGap('# 題\n\n最初の段落です。\n改行のあとの文です。');
      // 空いた改行の数 = 2つ(3つの改行のうち、1つは、行を分ける改行)。1つにつき、行の高さ(約18.7pt)
      expect(withBreaks - withoutBreaks).toBeGreaterThan(34);
      expect(withBreaks - withoutBreaks).toBeLessThan(40);
    });
  });

  it('コードブロックの中の空行は、「&nbsp;」にならない', async () => {
    await openEditor('# 題\n\n```text\nA\n\n\n\nB\n```');
    await page.waitForSelector('.cm-editor');
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const markdown = await markdownTab();
    expect(markdown).toContain('```text\nA\n\n\n\nB\n```');
    expect(markdown).not.toContain('&nbsp;');
  });
});

describe('ページの区切りの表示(実ブラウザ)', () => {
  // 文ごとに番号を入れて、どの文がどのページの先頭かを、文書の中で一意に決められるようにする
  const para = (label: string, sentences = 8): string =>
    Array.from({ length: sentences }, (_, index) => `${label}の文${index + 1}番です。PDFのページの区切りを確かめるための文章です。`).join('');

  // 3ページ以上になる文書(見出し・段落・リスト・表)
  const longDocument = (): string => {
    const parts: string[] = ['# 長い文書', ''];
    for (let chapter = 1; chapter <= 4; chapter += 1) {
      parts.push(`## 第${chapter}章`, '', para(`第${chapter}章A`), '', para(`第${chapter}章B`, 5), '');
      parts.push(...Array.from({ length: 5 }, (_, index) => `- 第${chapter}章の項目${index + 1} ${'説明の文章'.repeat(6)}`), '');
      if (chapter === 2) {
        parts.push('| 番号 | 名前 |', '| --- | --- |', ...Array.from({ length: 30 }, (_, index) => `| ${index + 1} | 行${index + 1}の名前 |`), '');
      }
    }
    return parts.join('\n');
  };

  const statusText = (): Promise<string> => page.$eval('.page-status', (element) => (element as HTMLElement).innerText);

  // 測定が終わり(測り直し中でない)、「全Nページ」が表示されるまで待って、Nを返す
  const settledTotalPages = async (): Promise<number> => {
    await page.waitForFunction(
      () => /全\d+ページ/.test(document.querySelector('.page-status')?.textContent ?? '') && !document.querySelector('.page-status-stale, .page-break-stale'),
      { timeout: 30_000 },
    );
    return Number(/全(\d+)ページ/.exec(await statusText())?.[1]);
  };

  const breakPages = (): Promise<string[]> => page.$$eval('.page-break', (lines) => lines.map((line) => (line as HTMLElement).dataset['page'] ?? ''));
  const breakTops = (): Promise<number[]> => page.$$eval('.page-break', (lines) => lines.map((line) => line.getBoundingClientRect().top));

  // プレビューの本文の中で、空白を除いた文字列 needle が、ちょうど1か所だけ現れる位置の上端(画面上のy座標)。見つからなければ null
  const topOfText = (needle: string): Promise<number | null> =>
    page.evaluate((target) => {
      const root = document.querySelector('.md-editor-content') as HTMLElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const entries: { node: Text; index: number }[] = [];
      let joined = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (text.parentElement?.closest('button, svg, [data-tool-cell]')) {
          continue;
        }
        for (let index = 0; index < text.data.length; index += 1) {
          if (!/\s/.test(text.data.charAt(index))) {
            joined += text.data.charAt(index);
            entries.push({ node: text, index });
          }
        }
      }
      const at = joined.indexOf(target);
      if (at < 0 || joined.indexOf(target, at + 1) >= 0) {
        return null;
      }
      const entry = entries[at] as { node: Text; index: number };
      const range = document.createRange();
      range.setStart(entry.node, entry.index);
      range.setEnd(entry.node, entry.index + 1);
      return range.getBoundingClientRect().top;
    }, needle);

  // 線(lineTop)と、文字(textTop)の間にある、空の段落(空行)の数。いずれも、画面上のy座標
  const blankParagraphsBetween = (lineTop: number, textTop: number): Promise<number> =>
    page.evaluate(
      (from, to) =>
        [...document.querySelectorAll('.md-editor-content > p')].filter((element) => {
          const top = element.getBoundingClientRect().top;
          return element.textContent === '' && top >= from - 1 && top < to;
        }).length,
      lineTop,
      textTop,
    );

  // 実際にPDFを出力して、ページ数を返す
  const outputPdf = async (): Promise<{ path: string; pages: number }> => {
    await clickButton('出力先フォルダを選択');
    await page.waitForFunction(
      () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへ'))?.disabled ?? true),
    );
    await clickButton('選んだフォルダへ');
    await page.waitForSelector('.notice-success', { timeout: 60_000 });
    const bytes = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('document.pdf')).getFile();
      return [...new Uint8Array(await file.arrayBuffer())];
    });
    const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-pages-')), 'out.pdf');
    writeFileSync(path, Buffer.from(bytes));
    return { path, pages: Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [path], { encoding: 'utf8' }))?.[1]) };
  };

  it('PDFのページの切り替わり位置に、区切り線と「Nページ目」が、常に表示される', async () => {
    await openEditor(longDocument());
    const total = await settledTotalPages();
    expect(total).toBeGreaterThanOrEqual(3);
    expect(await breakPages()).toEqual(Array.from({ length: total - 1 }, (_, index) => String(index + 2)));
    expect(await page.$eval('.page-break-label', (element) => element.textContent)).toBe('2ページ目');
    expect(await statusText()).toContain('赤い点線が、PDFのページの区切りです');
    await shot('22-page-breaks');
    expect(consoleErrors).toEqual([]);
  });

  // 区切り線が、実際のPDFのページ数・各ページの先頭と一致することを確かめる
  const expectBreaksToMatchPdf = async (): Promise<void> => {
    const total = await settledTotalPages();
    const pdf = await outputPdf();
    expect(total).toBe(pdf.pages);

    const tops = await breakTops();
    expect(tops).toHaveLength(pdf.pages - 1);
    for (const [index, lineTop] of tops.entries()) {
      const pageNumber = index + 2;
      let pageText = execFileSync('pdftotext', ['-raw', '-f', String(pageNumber), '-l', String(pageNumber), pdf.path, '-'], { encoding: 'utf8' }).replace(/\s+/g, '');
      // 表の途中で始まるページは、先頭に、見出しの行が繰り返される。リストの記号(PDFの文字には含まれる)は、除く
      pageText = pageText.replace(/^番号名前/, '').replace(/[•◦▪]/g, '');
      // 繰り返しの文面でも、プレビューの中で1か所に決まるよう、次の文の番号まで含む長さで探す
      const needle = pageText.slice(0, 40);
      const textTop = await topOfText(needle);
      expect(textTop, `ページ${pageNumber}の先頭「${needle}」が、プレビューの中に1か所だけある`).not.toBeNull();
      // 線は、その文字の行の、上か下の、すぐ隣にある(プレビューの行の高さ以内)。
      // ページの上端に空行が残る場合は、線は、その空行の前にある(PDFでも、ページの上端に、空行の空きがあるため)ので、空行の分だけ離れる
      const blanks = await blankParagraphsBetween(lineTop, textTop as number);
      expect(Math.abs((textTop as number) - lineTop), `ページ${pageNumber}: 先頭「${needle}」 y=${textTop} 線 y=${lineTop} 間の空行${blanks}`).toBeLessThanOrEqual(45 + blanks * 40);
    }
  };

  it('線は、実際のPDFの各ページの先頭の、すぐ近くにある(ページ数も同じ。プレビューの折り返しがPDFと違っても、同じ内容の前に付く)', async () => {
    await openEditor(longDocument());
    await expectBreaksToMatchPdf();
  });

  it('空行(「&nbsp;」の段落)を含む文書でも、線は、実際のPDFのページの切り替わりと一致する(空の段落も、ブロックとして数える)', async () => {
    await openEditor(longDocument().replace(/\n\n## 第/g, '\n\n&nbsp;\n\n&nbsp;\n\n&nbsp;\n\n## 第'));
    await expectBreaksToMatchPdf();
  });

  it('空行を重ねてから文字を入力して、空行の途中でページが替わる場合、線は、入力した文字の直前ではなく、PDFと同じ空行の前に引かれる', async () => {
    await openEditor(['# 長い文書', ...Array.from({ length: 12 }, (_, index) => para(`段落${index + 1}`, 6))].join('\n\n'));
    await settledTotalPages();

    // 4つ目の段落の末尾で、Enterを14回押して(空行を13個作って)、文字を入力する
    const paragraphs = await page.$$('.md-editor-content > p');
    await (paragraphs[3] as NonNullable<(typeof paragraphs)[number]>).click();
    await page.keyboard.press('End');
    for (let count = 0; count < 14; count += 1) {
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('追加の段落です。');
    await page.waitForSelector('.page-break-stale, .page-status-stale', { timeout: 5_000 });
    const total = await settledTotalPages();

    // PDFで、ページの先頭に残っている空行の数(2ページ目の最初の行と、空行の無い3ページ目の最初の行の、高さの差から)
    const pdf = await outputPdf();
    expect(total).toBe(pdf.pages);
    const firstLineTop = (pageNumber: number): number =>
      Number(/yMin="([\d.]+)"/.exec(execFileSync('pdftotext', ['-bbox', '-f', String(pageNumber), '-l', String(pageNumber), pdf.path, '-'], { encoding: 'utf8' }))?.[1]);
    const blanksOnPdfPage = Math.round((firstLineTop(2) - firstLineTop(3)) / 25.3);
    expect(blanksOnPdfPage, '2ページ目の上端に、空行が残っている(この文書では、空行の途中でページが替わる)').toBeGreaterThanOrEqual(1);

    // プレビューでも、線の下に、同じ数の空の段落がある(入力した文字の段落の前)
    const blanksBelowLine = await page.evaluate(() => {
      const line = document.querySelector('.page-break[data-page="2"]') as HTMLElement;
      const typed = [...document.querySelectorAll('.md-editor-content > p')].find((element) => element.textContent?.startsWith('追加の段落です。')) as HTMLElement;
      const lineTop = line.getBoundingClientRect().top;
      return [...document.querySelectorAll('.md-editor-content > p')].filter(
        (element) => element.textContent === '' && element.getBoundingClientRect().top >= lineTop - 1 && element.getBoundingClientRect().top < typed.getBoundingClientRect().top,
      ).length;
    });
    expect(blanksBelowLine).toBe(blanksOnPdfPage);
    expect(await statusText()).not.toContain('表示できません');
    await shot('24-page-break-in-blank-lines');
    expect(consoleErrors).toEqual([]);
  });

  it('コード・Mermaidの図(図のみ・コードと図・描けない図)・引用・水平線・画像・入れ子のリスト・表が混ざった文書でも、すべての区切りが表示され、PDFの各ページの先頭の近くにある', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sections = Array.from({ length: 5 }, (_, n) => {
      const chapter = n + 1;
      return [
        `## 節${chapter}`,
        para(`節${chapter}の導入`, 6),
        ['```python', ...Array.from({ length: 12 }, (_, line) => `print("節${chapter} 行${line + 1}")`), '```'].join('\n'),
        n % 2 === 0 ? '```mermaid\ngraph TD\n  A[開始] --> B[終了]\n```' : '```mermaid show=both\ngraph LR\n  X --> Y\n```',
        `> 節${chapter}の引用です。${'引用の文章'.repeat(8)}`,
        `![](${png})`,
        ['- 節' + chapter + 'の項目1', '  - 入れ子の項目A ' + '説明'.repeat(10), '  - 入れ子の項目B', '- [ ] タスク' + chapter].join('\n'),
        ['| 番号 | 名前 |', '| --- | --- |', ...Array.from({ length: 8 }, (_, row) => `| ${chapter}-${row + 1} | 節${chapter}の行${row + 1} |`)].join('\n'),
        '---',
        para(`節${chapter}のまとめ`, 5),
      ].join('\n\n');
    });
    await openEditor(['# 混在した文書', ...sections].join('\n\n'));
    const total = await settledTotalPages();
    expect(total).toBeGreaterThanOrEqual(3);
    // すべての区切りを、プレビューの上に置けている
    expect(await statusText()).not.toContain('表示できません');
    expect(await breakPages()).toEqual(Array.from({ length: total - 1 }, (_, index) => String(index + 2)));
    await shot('23-page-breaks-mixed');

    const pdf = await outputPdf();
    expect(total).toBe(pdf.pages);
    const tops = await breakTops();
    let checked = 0;
    for (const [index, lineTop] of tops.entries()) {
      const pageNumber = index + 2;
      const rawText = execFileSync('pdftotext', ['-raw', '-f', String(pageNumber), '-l', String(pageNumber), pdf.path, '-'], { encoding: 'utf8' }).replace(/\s+/g, '');
      // 表の見出しの行から始まるページは、見出しの下の行の文字を探すため、1行分(約45px)余計に離れる
      const afterHeader = rawText.startsWith('番号名前');
      const pageText = rawText.replace(/^番号名前/, '');
      // 先頭の文字が、プレビューの中で一意に決まるページだけ、位置を確かめる(コードの行・繰り返しの文は、決まらないため飛ばす)
      const needle = pageText.slice(0, 10);
      const textTop = await topOfText(needle);
      if (textTop !== null) {
        expect(Math.abs(textTop - lineTop), `ページ${pageNumber}: 先頭「${needle}」 y=${textTop} 線 y=${lineTop}`).toBeLessThanOrEqual(afterHeader ? 110 : 45);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(consoleErrors).toEqual([]);
  });

  it('1ページに収まる文書には、区切り線が無く、「全1ページ」と表示される', async () => {
    await openEditor('# 短い文書\n\n本文です。');
    expect(await settledTotalPages()).toBe(1);
    expect(await page.$('.page-break')).toBeNull();
  });

  it('編集すると、測り直すまでの間は、線が薄くなり、測り終わると、新しい位置に変わる(実際のPDFとも一致する)', async () => {
    await openEditor(longDocument());
    const before = await settledTotalPages();

    // 先頭に、長い段落を足す(後ろの区切りが、後ろへ動き、ページが増える)
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(para('追加', 60));
    await page.waitForSelector('.page-break-stale, .page-status-stale', { timeout: 5_000 });
    expect(await statusText()).toContain('測り直し中');

    const after = await settledTotalPages();
    expect(after).toBeGreaterThan(before);
    expect(await breakPages()).toHaveLength(after - 1);
    expect(after).toBe((await outputPdf()).pages);
  });

  it('プレビューをスクロールしても、線は、内容と一緒に動く', async () => {
    await openEditor(longDocument());
    await settledTotalPages();
    const before = await breakTops();
    const scrolled = await page.$eval('.md-editor-content', (element) => {
      element.scrollTop = 300;
      return element.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await breakTops();
    expect(after).toHaveLength(before.length);
    for (const [index, top] of before.entries()) {
      expect(Math.abs((after[index] as number) - (top - scrolled))).toBeLessThanOrEqual(1);
    }
  });

  it('「Markdown」タブでは、区切り線は表示されない。プレビューに戻ると、再び表示される', async () => {
    await openEditor(longDocument());
    await settledTotalPages();
    await clickButton('Markdown');
    await page.waitForSelector('textarea[aria-label="Markdown"]');
    expect(await page.$('.page-break')).toBeNull();
    await clickButton('プレビュー');
    await settledTotalPages();
    expect((await breakPages()).length).toBeGreaterThan(0);
  });

  it('画像を埋め込んでも、測定のために、画像のデータは送らない(大きな画像でも、要求は軽い)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-layout-'));
    const sizes: number[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/layout')) {
        sizes.push((request.postData() ?? '').length);
      }
    });
    await openEditor('# 画像\n\n本文です。');
    await settledTotalPages();
    // 大きな画像(ノイズなので、圧縮されず、数百KBになる)を作り、ドロップする
    const noise = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 400;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      const data = context.createImageData(600, 400);
      for (let index = 0; index < data.data.length; index += 4) {
        data.data[index] = Math.random() * 255;
        data.data[index + 1] = Math.random() * 255;
        data.data[index + 2] = Math.random() * 255;
        data.data[index + 3] = 255;
      }
      context.putImageData(data, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1] as string;
    });
    writeFileSync(join(dir, 'noise.png'), Buffer.from(noise, 'base64'));
    expect(Buffer.from(noise, 'base64').length).toBeGreaterThan(500_000);
    const box = (await (await page.$('.md-editor-content p'))?.boundingBox()) as { x: number; y: number; width: number; height: number };
    const client = await page.createCDPSession();
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await client.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data: { items: [], files: [join(dir, 'noise.png')], dragOperationsMask: 1 } });
    }
    await page.waitForSelector('.md-editor-content img');
    // 画像を含む文書が、測り直される
    await page.waitForFunction(() => document.querySelector('.page-status-stale, .page-break-stale') !== null, { timeout: 5_000 });
    await settledTotalPages();
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(5_000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('手動の改ページ(実ブラウザ)', () => {
  const MARKER = '<div style="page-break-after: always"></div>';
  const DOC = ['# 題', '', '最初のページの段落です。', '', MARKER, '', '次のページの段落です。'].join('\n');

  const markdownTab = async (): Promise<string> => {
    await clickButton('Markdown');
    await page.waitForSelector('textarea[aria-label="Markdown"]');
    return sourceValue();
  };
  const previewTab = async (): Promise<void> => {
    await clickButton('プレビュー');
    await page.waitForSelector('.md-editor-content h1');
  };
  const markerCount = (): Promise<number> => page.$$eval('.page-break-marker', (items) => items.length);
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

  it('改ページの印を含むMarkdownは、プレビューに「改ページ」の区切りとして表示され(印の文字は出ない)、編集しなければ、取り込んだままになる', async () => {
    await openEditor(DOC);
    await page.waitForSelector('.page-break-marker');
    expect(await markerCount()).toBe(1);
    const text = await page.$eval('.md-editor-content', (element) => (element as HTMLElement).innerText);
    expect(text).toContain('改ページ');
    expect(text).not.toContain('page-break-after');
    expect(text).not.toContain('\\<');
    expect(await page.$('[role="alert"]')).toBeNull();
    await shot('30-page-break-marker');
    expect(await markdownTab()).toBe(DOC);
    expect(consoleErrors).toEqual([]);
  });

  it('ツールバーの「改ページ」で、カーソルの位置に区切りを入れられる。Markdownには、印の1行が、独立したブロックとして保存される', async () => {
    await openEditor('# 題\n\n最初の段落です。\n\n次の段落です。\n');
    await page.waitForSelector('.md-editor-content h1');
    await (await page.$$('.md-editor-content p'))[0]?.click();
    await page.keyboard.press('End');
    await clickButton('改ページ');
    await page.waitForSelector('.page-break-marker');
    await settle();
    expect(await markerCount()).toBe(1);
    const markdown = await markdownTab();
    expect(markdown).toBe(`# 題\n\n最初の段落です。\n\n${MARKER}\n\n次の段落です。`);
    expect(markdown).not.toContain('\\<');
  });

  it('Markdownタブへ切り替えて、プレビューに戻っても、区切りが残る(印の1行が崩れない)', async () => {
    await openEditor(DOC);
    await page.waitForSelector('.page-break-marker');
    // 編集して、エディタが書き出した形(正規化後)にする
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.type('(編集)');
    await settle();
    const first = await markdownTab();
    expect(first).toBe(DOC.replace('# 題', '# 題(編集)'));
    await previewTab();
    await page.waitForSelector('.page-break-marker');
    expect(await markerCount()).toBe(1);
    expect(await markdownTab()).toBe(first);
  });

  it('区切りの「削除」ボタンで、区切りを消せる。Markdownから、印の行も消える', async () => {
    await openEditor(DOC);
    await page.waitForSelector('.page-break-marker');
    await page.click('.page-break-marker-remove');
    await page.waitForFunction(() => document.querySelector('.page-break-marker') === null);
    await settle();
    const markdown = await markdownTab();
    expect(markdown).not.toContain('page-break-after');
    expect(markdown).toContain('最初のページの段落です。');
    expect(markdown).toContain('次のページの段落です。');
  });

  it('「Markdown」タブに、印を書いても、プレビューで区切りになる', async () => {
    await openEditor('# 題\n\n本文です。');
    await clickButton('Markdown');
    await page.waitForSelector('textarea[aria-label="Markdown"]');
    await page.$eval(
      'textarea[aria-label="Markdown"]',
      (element, value) => {
        const area = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, value);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      },
      `# 題\n\n本文です。\n\n<div style='break-after: page;'></div>\n\n次です。`,
    );
    await previewTab();
    await page.waitForSelector('.page-break-marker');
    expect(await markerCount()).toBe(1);
  });

  it('PDFは、区切りの位置で改ページされ、プレビューの赤い点線(ページの区切り)は、区切りの直後(次のページの先頭)に出る', async () => {
    await openEditor(DOC);
    await page.waitForSelector('.page-break-marker');
    await page.waitForFunction(() => /全2ページ/.test(document.querySelector('.page-status')?.textContent ?? '') && !document.querySelector('.page-status-stale, .page-break-stale'), {
      timeout: 30_000,
    });
    expect(await page.$$eval('.page-break', (lines) => lines.map((line) => (line as HTMLElement).dataset['page']))).toEqual(['2']);
    const { marker, line, next } = await page.evaluate(() => {
      const paragraphs = [...document.querySelectorAll('.md-editor-content > p')];
      return {
        marker: document.querySelector('.page-break-marker')?.getBoundingClientRect().bottom ?? NaN,
        line: document.querySelector('.page-break')?.getBoundingClientRect().top ?? NaN,
        next: paragraphs[paragraphs.length - 1]?.getBoundingClientRect().top ?? NaN,
      };
    });
    expect(line).toBeGreaterThanOrEqual(marker - 1);
    expect(line).toBeLessThanOrEqual(next + 1);

    const response = await fetch(`${baseUrl}/api/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: await markdownTab() }) });
    expect(response.status).toBe(200);
    const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-break-')), 'out.pdf');
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    expect(Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [path], { encoding: 'utf8' }))?.[1])).toBe(2);
    const second = execFileSync('pdftotext', ['-raw', '-f', '2', '-l', '2', path, '-'], { encoding: 'utf8' });
    expect(second).toContain('次のページの段落です。');
    expect(second).not.toContain('最初のページの段落です。');
  });
});

describe('ページ設定(実ブラウザ)', () => {
  const para = (label: string, sentences = 8): string =>
    Array.from({ length: sentences }, (_, index) => `${label}の文${index + 1}番です。PDFのページの区切りを確かめるための文章です。`).join('');
  const longDocument = (): string => {
    const parts: string[] = ['# 長い文書', ''];
    for (let chapter = 1; chapter <= 6; chapter += 1) {
      parts.push(`## 第${chapter}章`, '', para(`第${chapter}章A`), '', para(`第${chapter}章B`, 5), '');
      parts.push(...Array.from({ length: 5 }, (_, index) => `- 第${chapter}章の項目${index + 1} ${'説明の文章'.repeat(6)}`), '');
    }
    return parts.join('\n');
  };
  const HTML_DOC = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>t</title>\n</head>\n<body>\n<h1>見出し</h1>\n<p>HTMLの本文です。</p>\n</body>\n</html>\n';

  // localStorage(ページ設定の保存先)は、ページをまたいで残るため、テストごとに空にする
  const clearStorage = async (): Promise<void> => {
    await page.goto(baseUrl);
    await page.evaluate(() => localStorage.clear());
  };
  beforeEach(clearStorage);
  afterEach(clearStorage);

  const valueOf = (id: string): Promise<string> => page.$eval(`#${id}`, (element) => (element as HTMLSelectElement).value);
  const pageNumbersChecked = (): Promise<boolean> => page.$eval('.page-number-toggle input', (element) => (element as HTMLInputElement).checked);
  const togglePageNumbers = (): Promise<void> => page.click('.page-number-toggle input');

  const totalPages = (): Promise<number | null> =>
    page.evaluate(() => {
      const status = document.querySelector('.page-status');
      if (status === null || document.querySelector('.page-status-stale, .page-break-stale')) {
        return null;
      }
      const match = /全(\d+)ページ/.exec(status.textContent ?? '');
      return match === null ? null : Number(match[1]);
    });
  // 測定が終わり、全ページ数が表示されるまで待つ。before を指定すれば、その値と違う数になるまで待つ
  const settledTotalPages = async (before?: number): Promise<number> => {
    await page.waitForFunction(
      (previous) => {
        const status = document.querySelector('.page-status');
        const match = /全(\d+)ページ/.exec(status?.textContent ?? '');
        return match !== null && !document.querySelector('.page-status-stale, .page-break-stale') && Number(match[1]) !== previous;
      },
      { timeout: 30_000 },
      before ?? -1,
    );
    return (await totalPages()) as number;
  };

  const outputPdf = async (): Promise<string> => {
    await clickButton('出力先フォルダを選択');
    await page.waitForFunction(
      () => !([...document.querySelectorAll<HTMLButtonElement>('#feature-pane-pdf button')].find((b) => b.textContent?.includes('選んだフォルダへ'))?.disabled ?? true),
    );
    await clickButton('選んだフォルダへ');
    await page.waitForSelector('.notice-success', { timeout: 60_000 });
    const bytes = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('document.pdf')).getFile();
      return [...new Uint8Array(await file.arrayBuffer())];
    });
    const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-settings-')), 'out.pdf');
    writeFileSync(path, Buffer.from(bytes));
    return path;
  };
  const pdfInfo = (path: string): { pages: number; width: number; height: number } => {
    const info = execFileSync('pdfinfo', [path], { encoding: 'utf8' });
    const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    return { pages: Number(/Pages:\s+(\d+)/.exec(info)?.[1]), width: Number(size?.[1]), height: Number(size?.[2]) };
  };
  const firstPageText = (path: string): string => execFileSync('pdftotext', ['-raw', '-f', '1', '-l', '1', path, '-'], { encoding: 'utf8' });

  const openHtmlDocument = async (html: string): Promise<void> => {
    await setPasted(html);
    await page.evaluate(() => {
      const input = [...document.querySelectorAll('.paste-kind label')].find((l) => l.textContent?.includes('HTML'))?.querySelector('input');
      (input as HTMLInputElement).click();
    });
    await clickButton('貼り付けた内容を読み込む');
    await page.waitForSelector('iframe.html-preview-frame');
  };

  it('Markdown: ページ設定のパネルが、既定(A4・縦・標準・ページ番号あり)で表示される', async () => {
    await openEditor(SAMPLE);
    await page.waitForSelector('.page-settings');
    expect(await valueOf('page-paper')).toBe('A4');
    expect(await valueOf('page-orientation')).toBe('portrait');
    expect(await valueOf('page-margin')).toBe('standard');
    expect(await pageNumbersChecked()).toBe(true);
    await shot('31-page-settings');
    expect(consoleErrors).toEqual([]);
  });

  it('Markdown: 用紙・余白を変えると、ページの区切り(赤い点線)が、その設定で測り直され、出力したPDFのページ数・用紙の大きさと一致する', async () => {
    await openEditor(longDocument());
    const a4Pages = await settledTotalPages();
    expect(a4Pages).toBeGreaterThanOrEqual(3);

    await page.select('#page-paper', 'A3');
    await page.select('#page-margin', 'narrow');
    const a3Pages = await settledTotalPages(a4Pages);
    expect(a3Pages).toBeLessThan(a4Pages);
    expect(await page.$$eval('.page-break', (lines) => lines.length)).toBe(a3Pages - 1);

    const pdf = pdfInfo(await outputPdf());
    expect(pdf.pages).toBe(a3Pages);
    // A3縦(841.9 × 1190.6pt)
    expect(Math.abs(pdf.width - 841.9)).toBeLessThan(2);
    expect(Math.abs(pdf.height - 1190.6)).toBeLessThan(2);
  });

  it('Markdown: 向きを横に変えると、PDFは横向きになり、ページ数が、区切りの表示と一致する', async () => {
    await openEditor(longDocument());
    const portraitPages = await settledTotalPages();
    await page.select('#page-orientation', 'landscape');
    const landscapePages = await settledTotalPages(portraitPages);
    expect(landscapePages).toBeGreaterThan(portraitPages);
    const pdf = pdfInfo(await outputPdf());
    expect(pdf.pages).toBe(landscapePages);
    expect(pdf.width).toBeGreaterThan(pdf.height);
  });

  it('Markdown: ページ番号を外すと、PDFのフッターにページ番号が出ない(余白は変わらないため、ページ数も変わらない)', async () => {
    await openEditor(longDocument());
    const pages = await settledTotalPages();
    await togglePageNumbers();
    expect(await pageNumbersChecked()).toBe(false);
    const path = await outputPdf();
    expect(firstPageText(path)).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(pdfInfo(path).pages).toBe(pages);
  });

  it('設定は、画面を開き直しても覚えている(次に開く文書も、前回の設定で始まる)', async () => {
    await openEditor(SAMPLE);
    await page.select('#page-paper', 'B5');
    await page.select('#page-orientation', 'landscape');
    await page.select('#page-margin', 'wide');
    await togglePageNumbers();

    await openEditor(SAMPLE);
    await page.waitForSelector('.page-settings');
    expect(await valueOf('page-paper')).toBe('B5');
    expect(await valueOf('page-orientation')).toBe('landscape');
    expect(await valueOf('page-margin')).toBe('wide');
    expect(await pageNumbersChecked()).toBe(false);
  });

  it('保存してあった設定が壊れていても、既定で始まる', async () => {
    await page.evaluate(() => localStorage.setItem('md-pdf-editor:page-settings', '{"paper":"A9"}'));
    await openEditor(SAMPLE);
    await page.waitForSelector('.page-settings');
    expect(await valueOf('page-paper')).toBe('A4');
    expect(await pageNumbersChecked()).toBe(true);
  });

  it('HTML: 用紙・向き・余白は選べず(文書のCSSで決まる)、ページ番号だけ選べる。HTMLのソースは書き換わらない', async () => {
    await openHtmlDocument(HTML_DOC);
    await page.waitForSelector('.page-settings');
    expect(await page.$('#page-paper')).toBeNull();
    expect(await page.$('#page-orientation')).toBeNull();
    expect(await page.$('#page-margin')).toBeNull();
    expect(await page.$eval('.page-settings .field-hint', (element) => element.textContent)).toContain('@page');
    expect(await pageNumbersChecked()).toBe(true);

    const withNumbers = await outputPdf();
    expect(firstPageText(withNumbers)).toMatch(/1\s*\/\s*1/);

    await togglePageNumbers();
    const without = await outputPdf();
    expect(firstPageText(without)).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(firstPageText(without)).toContain('HTMLの本文です。');

    await clickButton('HTML');
    await page.waitForSelector('textarea[aria-label="HTML"]');
    expect(await page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value)).toBe(HTML_DOC);
  });
});

describe('下書きの自動保存と復元(実ブラウザ)', () => {
  const STYLE_KEY = 'md-pdf-editor:page-settings';
  const dialogs: string[] = [];

  // 下書き(IndexedDB)とページ設定(localStorage)は、ページをまたいで残るため、テストごとに空にする
  const clearAll = async (): Promise<void> => {
    await page.goto(baseUrl);
    await page.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('md-pdf-editor');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    });
  };
  beforeEach(async () => {
    dialogs.length = 0;
    page.on('dialog', (dialog) => dialogs.push(`${dialog.type()}: ${dialog.message()}`));
    await clearAll();
  });
  afterEach(clearAll);

  const waitSaved = (): Promise<unknown> =>
    page.waitForFunction(() => /このブラウザに保存しました/.test(document.querySelector('.draft-status')?.textContent ?? ''), { timeout: 15_000 });
  const typeInHeading = async (text: string): Promise<void> => {
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.type(text);
  };
  const markdownTab = async (): Promise<string> => {
    await clickButton('Markdown');
    await page.waitForSelector('textarea[aria-label="Markdown"]');
    return sourceValue();
  };
  const reload = async (): Promise<void> => {
    await page.goto(baseUrl);
    await page.waitForSelector('#paste-area');
  };
  const draftBanner = (): Promise<string | null> => page.$eval('.draft-section', (element) => element.textContent).catch(() => null);
  const unloadPrevented = (): Promise<boolean> => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  // 編集して、自動保存されるまで待ち、画面を開き直して、取り込み画面で「続きから再開」を押す。編集後のMarkdownを返す
  const editSaveReloadResume = async (): Promise<string> => {
    await openEditor(SAMPLE);
    await typeInHeading('(編集)');
    await waitSaved();
    const edited = await markdownTab();
    await reload();
    await page.waitForSelector('.draft-section');
    await clickButton('続きから再開');
    await page.waitForSelector('.md-editor-content h1');
    return edited;
  };

  it('編集すると自動保存され、画面を開き直すと、取り込み画面で案内される。「続きから再開」で、編集内容が戻る', async () => {
    await openEditor(SAMPLE);
    await typeInHeading('(編集)');
    await waitSaved();
    expect(await page.$eval('.draft-status', (element) => element.textContent)).toContain('画像・CSSのファイルは、保存されません');
    const edited = await markdownTab();

    await reload();
    await page.waitForSelector('.draft-section');
    const banner = await draftBanner();
    expect(banner).toContain('前回の編集内容が残っています');
    expect(banner).toContain('貼り付けたMarkdown');
    await shot('32-draft-banner');

    await clickButton('続きから再開');
    await page.waitForSelector('.md-editor-content h1');
    expect(await page.$eval('.md-editor-content h1', (element) => element.textContent)).toBe('取扱説明書(編集)');
    expect(await page.$eval('.notice-info', (element) => element.textContent)).toContain('自動保存した下書きから復元しました');
    expect(await markdownTab()).toBe(edited);
    expect(consoleErrors).toEqual([]);
  });

  it('編集していない文書は、保存しない(開き直しても、案内は出ない)', async () => {
    await openEditor(SAMPLE);
    await page.waitForSelector('.md-editor-content h1');
    await pause(2500);
    expect(await page.$('.draft-status')).toBeNull();
    await reload();
    await pause(300);
    expect(await draftBanner()).toBeNull();
  });

  it('編集を元に戻した(取り込んだままの内容にした)ときは、保存した下書きを消す', async () => {
    await openEditor('# 題\n\n本文');
    await typeInHeading('X');
    await waitSaved();
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.querySelector('.draft-status') === null, { timeout: 15_000 });
    await pause(300);
    await reload();
    await pause(300);
    expect(await draftBanner()).toBeNull();
  });

  it('「破棄」で下書きが消え、開き直しても、案内は出ない', async () => {
    await openEditor(SAMPLE);
    await typeInHeading('(編集)');
    await waitSaved();
    await reload();
    await page.waitForSelector('.draft-section');
    await clickButton('破棄');
    await page.waitForFunction(() => document.querySelector('.draft-section') === null);
    await reload();
    await pause(300);
    expect(await draftBanner()).toBeNull();
  });

  it('再開した文書は「変更あり」として扱われ、別のファイルを読み込むときに確認が出る。続けると、下書きも消える', async () => {
    await editSaveReloadResume();
    dialogs.length = 0;
    await clickButton('別のファイルを読み込む');
    await page.waitForSelector('#paste-area');
    expect(dialogs.some((entry) => entry.startsWith('confirm') && entry.includes('編集内容は破棄されます'))).toBe(true);
    // 破棄を選んだ編集内容は、取り込み画面に戻っても、案内されない
    await pause(300);
    expect(await draftBanner()).toBeNull();
    await reload();
    await pause(300);
    expect(await draftBanner()).toBeNull();
  });

  it('ページ設定も、下書きと一緒に戻る(保存してあった前回の設定ではなく、下書きの設定)', async () => {
    await openEditor(SAMPLE);
    await page.select('#page-paper', 'B5');
    await page.select('#page-orientation', 'landscape');
    await page.select('#page-margin', 'wide');
    await page.click('.page-number-toggle input');
    await typeInHeading('(編集)');
    await waitSaved();
    await reload();
    // 前回の設定(localStorage)を消しても、下書きの設定が戻る
    await page.evaluate((key) => localStorage.removeItem(key), STYLE_KEY);
    await page.waitForSelector('.draft-section');
    await clickButton('続きから再開');
    await page.waitForSelector('.page-settings');
    expect(await page.$eval('#page-paper', (element) => (element as HTMLSelectElement).value)).toBe('B5');
    expect(await page.$eval('#page-orientation', (element) => (element as HTMLSelectElement).value)).toBe('landscape');
    expect(await page.$eval('#page-margin', (element) => (element as HTMLSelectElement).value)).toBe('wide');
    expect(await page.$eval('.page-number-toggle input', (element) => (element as HTMLInputElement).checked)).toBe(false);
  });

  it('ページ設定だけを変えても(文書は編集していない)、下書きは作らない', async () => {
    await openEditor(SAMPLE);
    await page.select('#page-paper', 'A3');
    await pause(2500);
    await reload();
    await pause(300);
    expect(await draftBanner()).toBeNull();
  });

  it('保存していない編集があるときだけ、タブを閉じる前の警告(beforeunload)が出る', async () => {
    await openEditor(SAMPLE);
    await page.waitForSelector('.md-editor-content h1');
    expect(await unloadPrevented()).toBe(false);
    await typeInHeading('(編集)');
    expect(await unloadPrevented()).toBe(true);
    await waitSaved();
    expect(await unloadPrevented()).toBe(false);
  });

  it('保存できないとき(容量不足など)は、理由を警告として表示し、タブを閉じる前の警告も出し続ける', async () => {
    await openEditor(SAMPLE);
    await page.waitForSelector('.md-editor-content h1');
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = () => {
        throw new DOMException('容量が足りません', 'QuotaExceededError');
      };
    });
    await typeInHeading('(編集)');
    await page.waitForSelector('.draft-status[role="alert"]', { timeout: 15_000 });
    const text = await page.$eval('.draft-status[role="alert"]', (element) => element.textContent);
    expect(text).toContain('自動保存できません');
    expect(text).toContain('容量が足りません');
    expect(await unloadPrevented()).toBe(true);
  });

  it('HTML・CSSも、編集内容が戻る。<link>の位置にCSSが当たり、HTMLのソースは取り込んだままになる', async () => {
    const html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n<h1>見出し</h1>\n</body>\n</html>\n';
    await page.goto(baseUrl);
    await page.waitForSelector('input[aria-label="フォルダを選択"]', { hidden: true });
    await page.evaluate(
      (items) => {
        const input = document.querySelector('input[aria-label="フォルダを選択"]') as HTMLInputElement;
        const files = items.map((item) => {
          const file = new File([new TextEncoder().encode(item.text)], item.path.split('/').pop() as string);
          Object.defineProperty(file, 'webkitRelativePath', { value: `site/${item.path}` });
          return file;
        });
        Object.defineProperty(input, 'files', { value: files, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      [
        { path: 'index.html', text: html },
        { path: 'css/style.css', text: 'h1 { color: rgb(255, 0, 0); }' },
      ],
    );
    await page.waitForSelector('iframe.html-preview-frame');
    // CSSタブで、CSSを編集する
    await clickButton('CSS: css/style.css');
    await page.waitForSelector('textarea[aria-label="CSS: css/style.css"]');
    await page.$eval(
      'textarea[aria-label="CSS: css/style.css"]',
      (element, value) => {
        const area = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, value);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      },
      'h1 { color: rgb(0, 0, 255); }',
    );
    await waitSaved();

    await reload();
    await page.waitForSelector('.draft-section');
    expect(await draftBanner()).toContain('index.html');
    await clickButton('続きから再開');
    await page.waitForSelector('iframe.html-preview-frame');
    expect(await page.$eval('.notice-info', (element) => element.textContent)).toContain('自動保存した下書きから復元しました(HTML・CSSの編集内容、ページ設定)');

    // CSSの編集内容が戻っていて、プレビューのh1に当たっている(<link>の位置に埋め込まれる)
    await page.waitForFunction(
      () => (document.querySelector('iframe.html-preview-frame') as HTMLIFrameElement | null)?.contentDocument?.designMode === 'on',
      { timeout: 30_000 },
    );
    const frame = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
    expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(0, 0, 255)');
    await clickButton('CSS: css/style.css');
    await page.waitForSelector('textarea[aria-label="CSS: css/style.css"]');
    expect(await page.$eval('textarea[aria-label="CSS: css/style.css"]', (element) => (element as HTMLTextAreaElement).value)).toBe('h1 { color: rgb(0, 0, 255); }');
    // HTMLは、編集していないため、取り込んだままで、CSSを指す<link>は「見つからない」警告にならない
    await clickButton('HTML');
    await page.waitForSelector('textarea[aria-label="HTML"]');
    expect(await page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value)).toBe(html);
    expect(await page.$eval('main', (element) => (element as HTMLElement).innerText)).not.toContain('見つからない');
  });
});
