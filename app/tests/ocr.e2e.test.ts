import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementHandle } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiffSegment } from '../src/client/ragApi.js';
import { PAGE_BREAK_MARKUP } from '../src/shared/pageBreak.js';
import { startE2eStack, type E2ePage, type E2eStack } from './support/e2eHarness.js';
import type { FakeDraft } from './support/fakeRagServer.js';

/*
 * 機能②「PDF → OCR → MD」の結合テスト。ビルド済みクライアントを実サーバ・実Chromiumで動かし、
 * OCR・RAGサービスは偽物(FakeRagServer)につなぐ。OCRの進行は、テストが偽サーバを操作して進める。
 * 事前に `npm run build` が必要。
 */
let stack: E2eStack;
let view: E2ePage;
let workDir: string;
// 意図して、HTTPのエラー(404・500など)を起こすテストだけ、ブラウザが出す「Failed to load resource」を許す
let allowHttpErrors = false;

// OCRの完了・状態の切り替えは、画面が数秒ごとに見に行く。それを待つ最大の時間
const POLL_WAIT_MS = 15_000;

const NEEDS_REVIEW: DiffSegment = {
  page: 2, segment_id: 'seg-2', glm_text: '圧縮機高圧異常', glm_alt_text: '圧縮機高圧異倿', status: 'needs_review', final_text: '圧縮機高圧異常', reason: '画像を見ても判定できない',
};
const AUTO_CORRECTED: DiffSegment = {
  page: 1, segment_id: 'seg-1', glm_text: '還気温度センサ異常', glm_alt_text: '還気温庋センサ異常', status: 'auto_corrected', final_text: '還気温度センサ異常', reason: '画像から読み取れる',
};
const MATCH: DiffSegment = { page: 1, segment_id: 'seg-0', glm_text: '見出し', glm_alt_text: '見出し', status: 'match', final_text: '見出し', reason: null };
const SEGMENTS = [MATCH, AUTO_CORRECTED, NEEDS_REVIEW];
const MARKDOWN = '## PDF 1ページ目\n\n還気温度センサ異常\n\n## PDF 2ページ目\n\n圧縮機高圧異常\n';

beforeAll(async () => {
  stack = await startE2eStack();
  workDir = mkdtempSync(join(tmpdir(), 'ocr-e2e-'));
});

afterAll(async () => {
  await stack.stop();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { rag } = stack;
  rag.drafts.clear();
  rag.documents.splice(0);
  rag.requests.splice(0);
  rag.ready = { ok: true };
  rag.lastOcrPassword = null;
  rag.failAllWith = null;
  allowHttpErrors = false;
  view = await stack.newPage();
  // ダウンロードは、保存せずに、ファイル名と内容だけ記録する(headlessのダウンロード先の設定を避ける)
  await view.page.evaluateOnNewDocument(() => {
    const blobs = new Map<string, Blob>();
    const downloads: { name: string; blob: Blob }[] = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource): string => {
      const url = create(object);
      if (object instanceof Blob) {
        blobs.set(url, object);
      }
      return url;
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
      const blob = blobs.get(this.href);
      if (this.download !== '' && blob !== undefined) {
        downloads.push({ name: this.download, blob });
      }
    };
    (window as unknown as { __downloads: typeof downloads }).__downloads = downloads;
  });
  // 前のテストで覚えた「開いている下書き」を消す(同じオリジンのlocalStorageは、テスト間で共有される)
  await view.page.goto(stack.baseUrl);
  await view.page.evaluate(() => localStorage.clear());
});

afterEach(async () => {
  const unexpected = view.consoleErrors.filter((message) => !(allowHttpErrors && message.startsWith('Failed to load resource')));
  await view.page.close();
  expect(unexpected).toEqual([]);
});

// ---- 画面操作の部品 ----

const PANE = '#feature-pane-ocr';

async function openOcrTab(): Promise<void> {
  await view.page.goto(stack.baseUrl);
  await view.page.waitForSelector('#feature-tab-ocr');
  await view.page.click('#feature-tab-ocr');
  await view.page.waitForSelector(`${PANE} h1`);
}

async function waitForText(text: string, timeout = POLL_WAIT_MS): Promise<void> {
  await view.page.waitForFunction((pane, expected) => document.querySelector(pane)?.textContent?.includes(expected) === true, { timeout }, PANE, text);
}

async function paneText(): Promise<string> {
  return view.page.$eval(PANE, (element) => element.textContent ?? '');
}

async function clickButton(label: string): Promise<void> {
  const clicked = await view.page.evaluate(
    (pane, text) => {
      const target = [...(document.querySelector(pane)?.querySelectorAll('button, a') ?? [])].find((element) => element.textContent?.trim() === text);
      (target as HTMLElement | undefined)?.click();
      return target !== undefined;
    },
    PANE,
    label,
  );
  if (!clicked) {
    throw new Error(`ボタン「${label}」が見つかりません。画面の内容: ${(await paneText()).slice(0, 300)}`);
  }
}

async function isDisabled(label: string): Promise<boolean> {
  return view.page.evaluate(
    (pane, text) => {
      const target = [...(document.querySelector(pane)?.querySelectorAll('button') ?? [])].find((element) => element.textContent?.trim() === text);
      if (target === undefined) {
        throw new Error(`ボタン「${text}」が見つかりません`);
      }
      return (target as HTMLButtonElement).disabled;
    },
    PANE,
    label,
  );
}

function writeFile(name: string, content: string | Buffer): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

async function chooseFile(path: string): Promise<void> {
  const input = await view.page.$('#ocr-file-input');
  if (input === null) {
    throw new Error('ファイル選択欄がありません');
  }
  await (input as ElementHandle<HTMLInputElement>).uploadFile(path);
}

async function setTextarea(selector: string, value: string): Promise<void> {
  await view.page.$eval(
    selector,
    (element, text) => {
      const area = element as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
}

// OCRが完了した下書きを偽サーバに用意し、履歴の「開く」で、確認・修正の画面を開く
async function openReviewDraft(overrides: Partial<FakeDraft> = {}): Promise<FakeDraft> {
  const draft = stack.rag.addDraft({
    source_file_name: 'R-1.pdf', status: 'DRAFT', page_count: 2, pages_done: 2, draft_markdown: MARKDOWN, diff_segments: SEGMENTS, ...overrides,
  });
  await openOcrTab();
  await waitForText(draft.source_file_name);
  await clickButton('開く');
  await waitForText('OCR結果の確認・修正');
  return draft;
}

async function downloads(): Promise<{ name: string; text: string }[]> {
  return view.page.evaluate(async () => {
    const recorded = (window as unknown as { __downloads: { name: string; blob: Blob }[] }).__downloads;
    return Promise.all(recorded.map(async ({ name, blob }) => ({ name, text: await blob.text() })));
  });
}

describe('開始と実行中', () => {
  it('PDFを選んでOCRを開始すると、進捗が表示され、完了すると確認・修正の画面に切り替わる', async () => {
    await openOcrTab();
    await stack.screenshot(view.page, 'ocr-1-start');
    const pdf = writeFile('R-1.pdf', '%PDF-1.4\n%fake');

    await chooseFile(pdf);
    await waitForText('選択中: R-1.pdf');
    await clickButton('OCRを開始');
    await waitForText('OCRを実行しています');

    // 偽サーバが受け取った下書き: PDFのファイル名が入り、OCR待ち
    const draft = stack.rag.latestDraft();
    expect(draft.source_file_name).toBe('R-1.pdf');
    expect(draft.status).toBe('QUEUED');
    expect(await paneText()).toContain('待機中');

    // 実行中: 「n / N ページ」と、進捗バー
    stack.rag.progress(draft.id, 1, 4);
    await waitForText('1 / 4 ページ');
    expect(await view.page.$eval(`${PANE} [role="progressbar"]`, (bar) => [bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')])).toEqual(['1', '4']);
    expect(await paneText()).toContain('この画面を閉じても、OCRは続きます');
    await stack.screenshot(view.page, 'ocr-2-running');

    // 完了: 確認・修正の画面(要確認の一覧・原本PDFへのリンク)
    stack.rag.complete(draft.id, MARKDOWN, SEGMENTS, 2);
    await waitForText('OCR結果の確認・修正');
    const text = await paneText();
    expect(text).toContain('要確認: 1件');
    expect(text).toContain('圧縮機高圧異倿'); // 比較候補
    expect(text).toContain('画像を見ても判定できない');
    expect(text).toContain('自動修正された箇所: 1件');
    const link = await view.page.$eval(`${PANE} a.ocr-pdf-link`, (a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }));
    expect(link).toEqual({ href: `/api/rag/ocr-drafts/${draft.id}/pdf#page=2`, target: '_blank', rel: 'noopener noreferrer' });
    await stack.screenshot(view.page, 'ocr-3-review');
  });

  it('パスワードを入力すると、OCRの開始時に送られる', async () => {
    await openOcrTab();

    await chooseFile(writeFile('locked.pdf', '%PDF-1.4'));
    await view.page.type('#ocr-password', 'secret');
    await clickButton('OCRを開始');
    await waitForText('OCRを実行しています');

    expect(stack.rag.lastOcrPassword).toBe('secret');
  });

  it('PDFをドラッグ&ドロップでも選べる。複数のファイルは断る', async () => {
    await openOcrTab();

    const dropFiles = (names: string[]): Promise<void> =>
      view.page.evaluate((fileNames) => {
        const transfer = new DataTransfer();
        for (const name of fileNames) {
          transfer.items.add(new File(['%PDF-1.4'], name, { type: 'application/pdf' }));
        }
        document.querySelector('#feature-pane-ocr .drop-zone')?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, names);

    await dropFiles(['dropped.pdf']);
    await waitForText('選択中: dropped.pdf');
    expect(await isDisabled('OCRを開始')).toBe(false);

    await dropFiles(['a.pdf', 'b.pdf']);
    await waitForText('一度にOCRできるPDFは1つです');
    expect(await isDisabled('OCRを開始')).toBe(true);
  });

  it('PDF以外のファイルは、送る前に断る(サーバへは送らない)', async () => {
    await openOcrTab();

    await chooseFile(writeFile('manual.txt', 'テキスト'));

    await waitForText('「manual.txt」はPDFではありません');
    expect(await isDisabled('OCRを開始')).toBe(true);
    expect(stack.rag.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('100MBを超えるPDFは、送る前に断る', async () => {
    await openOcrTab();
    const big = writeFile('big.pdf', '%PDF-1.4');
    truncateSync(big, 101 * 1024 * 1024); // 中身の無い、大きなファイル(送らないため、実際の書き込みは起きない)

    await chooseFile(big);

    await waitForText('「big.pdf」は大きすぎます');
    expect(await paneText()).toContain('上限は100MBです');
    expect(await isDisabled('OCRを開始')).toBe(true);
    expect(stack.rag.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('OCRの開始がサーバで断られたら、その理由を表示し、開始画面にとどまる', async () => {
    allowHttpErrors = true;
    await openOcrTab();
    stack.rag.failAllWith = 'DBに接続できません';

    await chooseFile(writeFile('R-1.pdf', '%PDF-1.4'));
    await clickButton('OCRを開始');

    await waitForText('DBに接続できません');
    expect(await paneText()).not.toContain('OCRを実行しています');
    expect(await isDisabled('OCRを開始')).toBe(false); // もう一度、押せる
  });
});

describe('サービスが使えない場合', () => {
  it('モデルが未取得だと案内を出し、OCRの開始を止める。使えるようになって再確認すると、開始できる', async () => {
    allowHttpErrors = true; // /readyz が503を返す(ブラウザが、その通信失敗をコンソールに記録する)
    stack.rag.ready = { ok: false, detail: 'Ollamaに未取得のモデルがあります: glm-ocr', missingModels: ['glm-ocr'] };
    await openOcrTab();

    await view.page.waitForSelector(`${PANE} .readiness-banner`);
    expect(await view.page.$eval(`${PANE} .readiness-banner`, (banner) => banner.textContent)).toContain('glm-ocr');
    expect(await paneText()).toContain('モデルの取得(約10GB)に時間がかかります');
    await chooseFile(writeFile('R-1.pdf', '%PDF-1.4'));
    await waitForText('選択中: R-1.pdf');
    expect(await isDisabled('OCRを開始')).toBe(true);
    expect(await paneText()).toContain('OCRを開始できません');
    await stack.screenshot(view.page, 'ocr-0-not-ready');

    stack.rag.ready = { ok: true };
    await clickButton('再確認');
    await view.page.waitForFunction((pane) => document.querySelector(`${pane} .readiness-banner`) === null, { timeout: POLL_WAIT_MS }, PANE);
    expect(await isDisabled('OCRを開始')).toBe(false);
  });
});

describe('履歴', () => {
  it('過去のOCRを、状態つきで一覧し、開く・破棄ができる', async () => {
    const running = stack.rag.addDraft({ source_file_name: 'running.pdf', status: 'RUNNING', page_count: 4, pages_done: 1 });
    stack.rag.addDraft({ source_file_name: 'done.pdf', status: 'DRAFT', page_count: 2, pages_done: 2, draft_markdown: MARKDOWN, diff_segments: SEGMENTS });
    stack.rag.addDraft({ source_file_name: 'failed.pdf', status: 'FAILED', error_message: 'PDFから画像を抽出できませんでした' });
    stack.rag.addDraft({ source_file_name: 'discarded.pdf', status: 'DISCARDED' });

    await openOcrTab();
    await waitForText('running.pdf');

    const text = await paneText();
    expect(text).toContain('実行中 1/4ページ');
    expect(text).toContain('確認待ち');
    expect(text).toContain('失敗');
    expect(text).toContain('PDFから画像を抽出できませんでした');
    expect(text).not.toContain('discarded.pdf');

    // 破棄(確認ダイアログに「OK」)
    await view.page.evaluate((pane) => {
      const item = [...document.querySelectorAll(`${pane} .ocr-history-item`)].find((li) => li.textContent?.includes('failed.pdf'));
      ([...(item?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '破棄') as HTMLElement).click();
    }, PANE);
    await view.page.waitForFunction((pane) => !document.querySelector(pane)?.textContent?.includes('failed.pdf'), { timeout: POLL_WAIT_MS }, PANE);
    expect(view.dialogs.at(-1)).toContain('「failed.pdf」のOCR結果を破棄します');
    expect([...stack.rag.drafts.values()].find((d) => d.source_file_name === 'failed.pdf')?.status).toBe('DISCARDED');
    expect(running.status).toBe('RUNNING');
  });

  it('OCRが実行中の履歴は、自動で更新される', async () => {
    const draft = stack.rag.addDraft({ source_file_name: 'running.pdf', status: 'RUNNING', page_count: 4, pages_done: 1 });
    await openOcrTab();
    await waitForText('実行中 1/4ページ');

    stack.rag.progress(draft.id, 3, 4);

    await waitForText('実行中 3/4ページ');
  });
});

describe('確認・修正', () => {
  it('本文を編集して保存すると、サーバの下書きが更新され、「未保存」の表示が消える', async () => {
    const draft = await openReviewDraft();
    expect(await paneText()).toContain('保存済み');
    expect(await isDisabled('修正を保存')).toBe(true);

    await clickButton('Markdown構文');
    await setTextarea(`${PANE} textarea.ocr-source-area`, `${MARKDOWN}追記した行\n`);
    await waitForText('未保存の修正があります');
    expect(await isDisabled('修正を保存')).toBe(false);
    await stack.screenshot(view.page, 'ocr-4-review-edited');
    await clickButton('修正を保存');
    await waitForText('保存しました');

    expect(stack.rag.draftOf(draft.id).draft_markdown).toBe(`${MARKDOWN}追記した行\n`);
    expect(stack.rag.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(await isDisabled('修正を保存')).toBe(true);
  });

  it('書式付きエディタで入力しても、未保存になり、保存できる', async () => {
    const draft = await openReviewDraft();

    await view.page.click(`${PANE} .md-editor-content`);
    await view.page.keyboard.down('Control');
    await view.page.keyboard.press('End');
    await view.page.keyboard.up('Control');
    await view.page.keyboard.type('書式付きで追記');
    await waitForText('未保存の修正があります');
    await clickButton('修正を保存');
    await waitForText('保存しました');

    expect(stack.rag.draftOf(draft.id).draft_markdown).toContain('書式付きで追記');
    expect(stack.rag.draftOf(draft.id).draft_markdown).toContain('圧縮機高圧異常');
  });

  it('書式付きエディタのツールバーから、区切り線・改ページ・コードブロックを入れて、保存できる。保存した内容は、読み込み直しても、同じ表示になる', async () => {
    const draft = await openReviewDraft();
    const clickTool = async (label: string): Promise<void> => {
      await view.page.click(`${PANE} [role="toolbar"] button[aria-label="${label}"]`);
    };

    // 文書の末尾にカーソルを置いて、順に入れる
    await view.page.click(`${PANE} .md-editor-content`);
    await view.page.keyboard.down('Control');
    await view.page.keyboard.press('End');
    await view.page.keyboard.up('Control');
    await clickTool('Insert thematic break');
    await clickTool('改ページを入れる(PDFで、ここから新しいページになります)');
    await clickTool('Insert Code Block');
    await view.page.waitForSelector(`${PANE} .md-editor-content .cm-content`);
    await view.page.type(`${PANE} .md-editor-content .cm-content`, 'echo hello');
    await stack.screenshot(view.page, 'ocr-4b-review-insert-blocks');

    await waitForText('未保存の修正があります');
    await clickButton('修正を保存');
    await waitForText('保存しました');
    const saved = stack.rag.draftOf(draft.id).draft_markdown;
    expect(saved).toContain(MARKDOWN.trimEnd());
    expect(saved).toMatch(/\n\*\*\*\n/); // 区切り線
    expect(saved).toContain(`\n${PAGE_BREAK_MARKUP}\n`); // 改ページの印(独立した1行)
    expect(saved).toContain('```txt\necho hello\n```'); // コードブロック(既定の言語はテキスト)

    // 構文モードで見ても同じ。書式付きに戻すと、改ページは、印の文字ではなく、「改ページ」の区切りとして表示される
    await clickButton('Markdown構文');
    expect(await view.page.$eval(`${PANE} textarea.ocr-source-area`, (e) => (e as HTMLTextAreaElement).value)).toBe(saved);
    await clickButton('書式付き');
    await view.page.waitForSelector(`${PANE} .md-editor-content .page-break-marker`);
    const editorText = await view.page.$eval(`${PANE} .md-editor-content`, (e) => e.textContent ?? '');
    expect(editorText).not.toContain('page-break-after');
    expect(editorText).toContain('echo hello');
    // 読み込み直しただけでは、本文は変わらない(未保存にならない)
    expect(await paneText()).not.toContain('未保存の修正があります');
  });

  it('「本文の該当箇所へ」で、構文モードに切り替わり、該当箇所が選択される', async () => {
    await openReviewDraft();

    await clickButton('本文の該当箇所へ'); // 一覧は、要確認の1件が先に並ぶ

    await view.page.waitForSelector(`${PANE} textarea.ocr-source-area`);
    const selected = await view.page.$eval(`${PANE} textarea.ocr-source-area`, (element) => {
      const area = element as HTMLTextAreaElement;
      return area.value.slice(area.selectionStart, area.selectionEnd);
    });
    expect(selected).toBe('圧縮機高圧異常');
  });

  it('本文を編集して該当箇所が無くなったら、見つからないことを知らせる', async () => {
    await openReviewDraft();
    await clickButton('Markdown構文');
    await setTextarea(`${PANE} textarea.ocr-source-area`, '全部書き換えた本文');

    await clickButton('本文の該当箇所へ');

    await waitForText('p.2の該当箇所が本文中に見つかりませんでした');
  });

  it('表として解釈できない箇所があると、警告する。直すと消える', async () => {
    await openReviewDraft({ draft_markdown: '| 表示 | 名称 | :--- | : |\n| --- | --- |\n| E001 | 高圧異常 |\n' });

    await waitForText('表として解釈できない箇所が1件あります');

    await clickButton('Markdown構文');
    await setTextarea(`${PANE} textarea.ocr-source-area`, '| 表示 | 名称 |\n| --- | --- |\n| E001 | 高圧異常 |\n');
    await view.page.waitForFunction((pane) => !document.querySelector(pane)?.textContent?.includes('表として解釈できない'), { timeout: 5000 }, PANE);
  });

  it('要確認の箇所が無ければ、そのことを表示する。原本PDFが無い下書きは、PDFのリンクを出さない', async () => {
    await openReviewDraft({ diff_segments: [MATCH, AUTO_CORRECTED], has_pdf: false });

    expect(await paneText()).toContain('AIが確信を持てなかった箇所は、ありませんでした');
    expect(await view.page.$(`${PANE} a.ocr-pdf-link`)).toBeNull();
  });

  it('Markdownを.mdファイルとして保存できる(元のPDF名の拡張子を.mdにする)', async () => {
    await openReviewDraft({ source_file_name: 'R-1チラー.pdf' });

    await clickButton('Markdownを保存(.md)');

    const saved = await downloads();
    expect(saved).toEqual([{ name: 'R-1チラー.md', text: MARKDOWN }]);
  });

  it('未保存の修正があるときに、一覧へ戻ろうとすると確認する', async () => {
    await openReviewDraft();
    await clickButton('Markdown構文');
    await setTextarea(`${PANE} textarea.ocr-source-area`, '変更');

    await clickButton('一覧へ戻る');

    await view.page.waitForSelector(`${PANE} #ocr-history-title`);
    expect(view.dialogs.at(-1)).toBe('未保存の修正があります。保存せずに一覧へ戻りますか?');
  });
});

describe('受け渡し', () => {
  it('「① PDFにして出力へ」で、①のタブが開き、編集画面にMarkdownが入る', async () => {
    await openReviewDraft({ source_file_name: 'R-1.pdf' });

    await clickButton('① PDFにして出力へ');

    await view.page.waitForSelector('#feature-pane-pdf:not([hidden]) .md-editor-content');
    expect(await view.page.$eval('#feature-tab-pdf', (tab) => tab.getAttribute('aria-selected'))).toBe('true');
    expect(await view.page.$eval('#feature-pane-pdf .source-name', (e) => e.textContent)).toBe('R-1.md');
    const editorText = await view.page.$eval('#feature-pane-pdf .md-editor-content', (e) => e.textContent ?? '');
    expect(editorText).toContain('還気温度センサ異常');
    expect(editorText).toContain('圧縮機高圧異常');
    await stack.screenshot(view.page, 'ocr-5-handoff-pdf');
  });

  it('未保存の修正があるときは、先に保存してから渡す', async () => {
    const draft = await openReviewDraft();
    await clickButton('Markdown構文');
    await setTextarea(`${PANE} textarea.ocr-source-area`, '修正した本文です\n');
    await waitForText('未保存の修正があります');

    await clickButton('① PDFにして出力へ');

    await view.page.waitForSelector('#feature-pane-pdf:not([hidden]) .md-editor-content');
    expect(stack.rag.draftOf(draft.id).draft_markdown).toBe('修正した本文です\n');
    expect(await view.page.$eval('#feature-pane-pdf .md-editor-content', (e) => e.textContent ?? '')).toContain('修正した本文です');
  });

  it('保存できなければ、渡さず、理由を表示する', async () => {
    allowHttpErrors = true;
    await openReviewDraft();
    await clickButton('Markdown構文');
    await setTextarea(`${PANE} textarea.ocr-source-area`, '修正');
    stack.rag.failAllWith = 'DBエラー';

    await clickButton('③ RAGに登録へ');

    await waitForText('保存できませんでした: DBエラー');
    expect(await view.page.$eval('#feature-tab-ocr', (tab) => tab.getAttribute('aria-selected'))).toBe('true');
    expect(await view.page.$('#feature-pane-rag')).toBeNull(); // ③のタブへは切り替わっていない
  });

  it('「③ RAGに登録へ」で、③のタブに切り替わる', async () => {
    await openReviewDraft();

    await clickButton('③ RAGに登録へ');

    await view.page.waitForSelector('#feature-pane-rag:not([hidden])');
    expect(await view.page.$eval('#feature-tab-rag', (tab) => tab.getAttribute('aria-selected'))).toBe('true');
  });
});

describe('リロードして復元', () => {
  it('実行中の下書きを開いたままリロードしても、続きの進捗が見られ、完了すると確認・修正に切り替わる', async () => {
    const draft = stack.rag.addDraft({ source_file_name: 'R-1.pdf', status: 'RUNNING', page_count: 5, pages_done: 2 });
    await openOcrTab();
    await waitForText('R-1.pdf');
    await clickButton('開く');
    await waitForText('2 / 5 ページ');

    await openOcrTab(); // 再読み込み(開き直し)

    await waitForText('2 / 5 ページ');
    expect(await view.page.$(`${PANE} #ocr-history-title`)).toBeNull(); // 履歴ではなく、開いていた下書きの画面
    stack.rag.complete(draft.id, MARKDOWN, SEGMENTS, 5);
    await waitForText('OCR結果の確認・修正');
  });

  it('確認・修正の画面を開いたままリロードしても、同じ下書きが開く', async () => {
    await openReviewDraft();

    await openOcrTab();

    await waitForText('OCR結果の確認・修正');
    expect(await paneText()).toContain('要確認: 1件');
  });

  it('覚えていた下書きが見つからなければ、履歴に戻り、そのことを知らせる', async () => {
    allowHttpErrors = true;
    const draft = await openReviewDraft();
    stack.rag.drafts.delete(draft.id);

    await openOcrTab();

    await waitForText('下書きが見つかりませんでした');
    expect(await paneText()).toContain('OCR履歴');
    expect(await view.page.evaluate(() => localStorage.getItem('rag-pdf-studio.ocr.currentDraft'))).toBeNull();
  });
});

describe('失敗と破棄', () => {
  it('OCRが失敗すると、理由を表示する。破棄すると、履歴に戻る', async () => {
    await openOcrTab();
    await chooseFile(writeFile('R-1.pdf', '%PDF-1.4'));
    await clickButton('OCRを開始');
    await waitForText('OCRを実行しています');
    const draft = stack.rag.latestDraft();

    stack.rag.fail(draft.id, 'pdftoppmに失敗しました(PDFから画像を抽出できませんでした)');
    await waitForText('OCRに失敗しました');
    expect(await paneText()).toContain('pdftoppmに失敗しました');
    await stack.screenshot(view.page, 'ocr-6-failed');
    await clickButton('この下書きを破棄');

    await waitForText('下書きを破棄しました。');
    expect(await paneText()).toContain('OCR履歴');
    expect(stack.rag.draftOf(draft.id).status).toBe('DISCARDED');
  });

  it('実行中のOCRを「中止して破棄」できる(確認の文言に、中止のタイミングを書く)', async () => {
    const draft = stack.rag.addDraft({ source_file_name: 'R-1.pdf', status: 'RUNNING', page_count: 4, pages_done: 1 });
    await openOcrTab();
    await waitForText('R-1.pdf');
    await clickButton('開く');
    await waitForText('1 / 4 ページ');

    await clickButton('中止して破棄');

    await waitForText('下書きを破棄しました。');
    expect(view.dialogs.at(-1)).toContain('現在のページの処理が終わった時点で中止されます');
    expect(stack.rag.draftOf(draft.id).status).toBe('DISCARDED');
  });

  it('確認・修正中の下書きを破棄できる(元に戻せないことを確認する)', async () => {
    const draft = await openReviewDraft();

    await clickButton('この下書きを破棄');

    await waitForText('下書きを破棄しました。');
    expect(view.dialogs.at(-1)).toContain('元に戻せません');
    expect(stack.rag.draftOf(draft.id).status).toBe('DISCARDED');
  });

  it('一覧へ戻っても、実行中のOCRは破棄されず、履歴から再び開ける', async () => {
    const draft = stack.rag.addDraft({ source_file_name: 'R-1.pdf', status: 'RUNNING', page_count: 4, pages_done: 1 });
    await openOcrTab();
    await waitForText('R-1.pdf');
    await clickButton('開く');
    await waitForText('1 / 4 ページ');

    await clickButton('一覧へ戻る');

    await waitForText('OCR履歴');
    expect(stack.rag.draftOf(draft.id).status).toBe('RUNNING');
    expect(await paneText()).toContain('実行中 1/4ページ');
  });
});
