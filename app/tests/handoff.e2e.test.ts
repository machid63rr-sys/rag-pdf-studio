import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementHandle } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiffSegment } from '../src/client/ragApi.js';
import { startE2eStack, type E2ePage, type E2eStack } from './support/e2eHarness.js';

/*
 * 機能どうしの受け渡しの結合テスト。② PDF → OCR → MD の画面で、PDFをOCRして完了させ、その結果を
 * ③ RAG(登録)・① MD/HTML → PDF へ渡す。②と③は別々の画面なので、つなぎ目(渡す内容・タブの切り替え・
 * 受け取った側の取り込み)を、実際の画面操作で確認する。OCR・RAGサービスは偽物につなぐ。
 */
let stack: E2eStack;
let view: E2ePage;
let workDir: string;

const POLL_WAIT_MS = 15_000;
const PDF_BYTES = Buffer.from('%PDF-1.4\n%uploaded pdf for handoff\n');
const MARKDOWN = '## PDF 1ページ目\n\n# 異常について\n\nE011 は凍結異常です。\n\n## PDF 2ページ目\n\n| 表示 | 名称 |\n| --- | --- |\n| E001 | 圧縮機高圧異常 |\n';
const NEEDS_REVIEW: DiffSegment = {
  page: 2, segment_id: 'seg-2', glm_text: '圧縮機高圧異常', glm_alt_text: '圧縮機高圧異倿', status: 'needs_review', final_text: '圧縮機高圧異常', reason: '画像を見ても判定できない',
};

beforeAll(async () => {
  stack = await startE2eStack();
  workDir = mkdtempSync(join(tmpdir(), 'handoff-e2e-'));
});

afterAll(async () => {
  await stack.stop();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  stack.rag.drafts.clear();
  stack.rag.documents.splice(0);
  stack.rag.requests.splice(0);
  stack.rag.ready = { ok: true };
  view = await stack.newPage();
  await view.page.goto(stack.baseUrl);
  await view.page.evaluate(() => localStorage.clear());
});

afterEach(async () => {
  const errors = view.consoleErrors;
  await view.page.close();
  expect(errors).toEqual([]);
});

const textOf = (selector: string): Promise<string> => view.page.$eval(selector, (element) => element.textContent ?? '');
const valueOf = (selector: string): Promise<string> => view.page.$eval(selector, (element) => (element as HTMLInputElement | HTMLTextAreaElement).value);

async function clickButtonIn(pane: string, label: string): Promise<void> {
  const clicked = await view.page.evaluate(
    (paneSelector, text) => {
      const target = [...(document.querySelector(paneSelector)?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === text);
      target?.click();
      return target !== undefined;
    },
    pane,
    label,
  );
  if (!clicked) {
    throw new Error(`ボタン「${label}」が${pane}に見つかりません`);
  }
}

async function waitForTextIn(pane: string, text: string): Promise<void> {
  await view.page.waitForFunction((paneSelector, expected) => document.querySelector(paneSelector)?.textContent?.includes(expected) === true, { timeout: POLL_WAIT_MS }, pane, text);
}

// ②の画面で、PDFを選んでOCRを開始し、偽サーバ側でOCRを完了させて、確認・修正の画面まで進める
async function ocrUntilReview(fileName = 'R-1.pdf'): Promise<void> {
  await view.page.click('#feature-tab-ocr');
  await view.page.waitForSelector('#ocr-file-input');
  const path = join(workDir, fileName);
  writeFileSync(path, PDF_BYTES);
  await (await view.page.$('#ocr-file-input') as ElementHandle<HTMLInputElement>).uploadFile(path);
  await waitForTextIn('#feature-pane-ocr', `選択中: ${fileName}`);
  await clickButtonIn('#feature-pane-ocr', 'OCRを開始');
  await waitForTextIn('#feature-pane-ocr', 'OCRを実行しています');
  stack.rag.complete(stack.rag.latestDraft().id, MARKDOWN, [NEEDS_REVIEW], 2);
  await waitForTextIn('#feature-pane-ocr', 'OCR結果の確認・修正');
}

describe('② → ③ RAG登録への受け渡し', () => {
  it('OCR結果が③の登録フォームに入り(登録名・原本PDFつき)、そのまま登録して、確認の一覧に出る', async () => {
    await ocrUntilReview();

    await clickButtonIn('#feature-pane-ocr', '③ RAGに登録へ');

    // ③のタブに切り替わり、②が渡した内容が、登録フォームに入っている
    await view.page.waitForSelector('#feature-pane-rag:not([hidden])');
    await view.page.waitForFunction(() => document.querySelector('.rag-handoff-notice')?.textContent?.includes('原本PDFつき') === true, { timeout: POLL_WAIT_MS });
    expect(await valueOf('#rag-markdown')).toBe(MARKDOWN);
    expect(await valueOf('#rag-registration-name')).toBe('R-1.md');
    expect(await textOf('.rag-pdf-row')).toContain('R-1.pdf');
    expect(view.dialogs).toEqual([]);
    await stack.screenshot(view.page, 'handoff-1-rag-prefilled');

    // 機器名を付けて登録する。偽サーバが受け取った内容が、②の結果と、アップロードした原本PDFそのもの
    await view.page.type('#rag-equipment-input', 'R-1,');
    await view.page.click('#rag-register-submit');
    await view.page.waitForSelector('.rag-success');
    const registered = stack.rag.documents[0];
    expect(registered?.source_file_name).toBe('R-1.md');
    expect(registered?.equipment_names).toEqual(['R-1']);
    expect(registered?.chunks.join('\n')).toContain('E011 は凍結異常です。');
    expect(registered?.pdf?.equals(PDF_BYTES)).toBe(true);

    // 確認(一覧)で、登録した文書が見え、原本PDFが開ける
    await view.page.click('#rag-tab-browse');
    await view.page.waitForSelector('#rag-panel-browse:not([hidden])');
    await waitForTextIn('#rag-panel-browse', 'R-1');
    expect(await textOf('#rag-panel-browse')).toContain('R-1');
    const pdfLinks = await view.page.$$eval('#rag-panel-browse a[href*="/pdf"]', (links) => links.map((link) => link.getAttribute('href')));
    expect(pdfLinks).toHaveLength(1);
    await stack.screenshot(view.page, 'handoff-2-rag-registered');
  });

  it('OCR中に未保存の修正があっても、先に保存してから③へ渡す(保存した本文が登録される)', async () => {
    await ocrUntilReview();
    // 本文を「Markdown構文」で直接書き換える(未保存の変更にする)
    await clickButtonIn('#feature-pane-ocr', 'Markdown構文');
    await view.page.waitForSelector('#feature-pane-ocr textarea');
    await view.page.$eval(
      '#feature-pane-ocr textarea',
      (element, text) => {
        const area = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      },
      '## PDF 1ページ目\n\n人手で直した本文\n',
    );
    await waitForTextIn('#feature-pane-ocr', '未保存');

    await clickButtonIn('#feature-pane-ocr', '③ RAGに登録へ');

    await view.page.waitForSelector('#feature-pane-rag:not([hidden])');
    await view.page.waitForFunction(() => (document.querySelector('#rag-markdown') as HTMLTextAreaElement | null)?.value.includes('人手で直した本文') === true, { timeout: POLL_WAIT_MS });
    // ②の下書きにも保存されている(渡す前に、保存が行われた)
    expect(stack.rag.latestDraft().draft_markdown).toBe('## PDF 1ページ目\n\n人手で直した本文\n');
  });

  it('③に入力中の内容があるときは、受け取る前に、置き換えてよいか確認する(OKで置き換わる)', async () => {
    await view.page.click('#feature-tab-rag');
    await view.page.waitForSelector('#rag-markdown');
    await view.page.type('#rag-markdown', '③で入力中の内容');

    await ocrUntilReview();
    await clickButtonIn('#feature-pane-ocr', '③ RAGに登録へ');

    await view.page.waitForFunction(() => (document.querySelector('#rag-markdown') as HTMLTextAreaElement | null)?.value.includes('E011') === true, { timeout: POLL_WAIT_MS });
    expect(view.dialogs).toEqual(['③ に入力中の内容があります。② のOCR結果で置き換えますか?']);
  });
});

describe('② → ① PDFにして出力への受け渡し', () => {
  it('OCR結果が①の編集画面で開き、出力名の既定がOCRしたPDFの名前になる', async () => {
    await ocrUntilReview('チラー.pdf');

    await clickButtonIn('#feature-pane-ocr', '① PDFにして出力へ');

    await view.page.waitForSelector('#feature-pane-pdf:not([hidden])');
    await view.page.waitForSelector('#feature-pane-pdf .md-editor-content');
    const editorText = await textOf('#feature-pane-pdf .md-editor-content');
    expect(editorText).toContain('E011 は凍結異常です。');
    expect(editorText).toContain('圧縮機高圧異常');
    expect(await textOf('#feature-pane-pdf')).toContain('チラー');
    await stack.screenshot(view.page, 'handoff-3-pdf-editor');
  });

  it('①で編集中の文書があるときは、置き換えてよいか確認する', async () => {
    await view.page.waitForSelector('#paste-area');
    await view.page.$eval(
      '#paste-area',
      (element, text) => {
        const area = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      },
      '# ①で編集中\n\n本文',
    );
    await clickButtonIn('#feature-pane-pdf', '貼り付けた内容を読み込む');
    await view.page.waitForSelector('#feature-pane-pdf .md-editor-content');

    await ocrUntilReview();
    await clickButtonIn('#feature-pane-ocr', '① PDFにして出力へ');

    await view.page.waitForFunction(() => document.querySelector('#feature-pane-pdf .md-editor-content')?.textContent?.includes('E011') === true, { timeout: POLL_WAIT_MS });
    expect(view.dialogs).toEqual(['① で編集中の文書があります。② のOCR結果で置き換えますか?']);
  });
});
