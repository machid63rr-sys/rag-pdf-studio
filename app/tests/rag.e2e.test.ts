import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementHandle, HTTPRequest } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startE2eStack, type E2ePage, type E2eStack } from './support/e2eHarness.js';

/*
 * 機能③「RAG(登録・確認)」の結合テスト。ビルド済みクライアントを実サーバ・実Chromiumで動かし、
 * ocr-ragは偽物(FakeRagServer)につなぐ。登録・一覧・検索・サービスが使えない場合を、画面から操作して確認する。
 * ②から渡された内容の取り込みは、②の画面と組み合わせたテストで確認する。
 */
let stack: E2eStack;
let view: E2ePage;
let tmp: string;

const PDF_BYTES = Buffer.from('%PDF-1.4\n%e2e original pdf\n');
const SAMPLE_MD = ['# ポンプ(サンプル)', '', '日常の点検の説明です。', '', '## 不具合の原因と対策', '', '| 不具合 | 原因 |', '|---|---|', '| 異常な振動 | 軸受の摩耗 |'].join('\n');

beforeAll(async () => {
  stack = await startE2eStack();
  tmp = mkdtempSync(join(tmpdir(), 'rag-e2e-'));
});

afterAll(async () => {
  await stack.stop();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  // 偽サーバを、毎回、初期状態に戻す
  const rag = stack.rag;
  rag.documents.length = 0;
  rag.drafts.clear();
  rag.requests.length = 0;
  rag.ready = { ok: true };
  rag.failAllWith = null;
  rag.searchResults = null;
  rag.lastSearchBody = null;
  view = await stack.newPage();
});

afterEach(async () => {
  await view.page.close();
});

// HTTPのエラー(わざと起こしたもの)は、ブラウザがコンソールに「Failed to load resource」を出すため、除いて確認する
const unexpectedConsoleErrors = (): string[] => view.consoleErrors.filter((message) => !message.includes('Failed to load resource'));

const makeFile = (name: string, data: Buffer | string): string => {
  const path = join(tmp, name);
  writeFileSync(path, data);
  return path;
};

async function openRag(): Promise<void> {
  await view.page.goto(stack.baseUrl);
  await view.page.waitForSelector('#feature-tab-rag');
  await view.page.click('#feature-tab-rag');
  await view.page.waitForSelector('#rag-register-submit');
}

async function openBrowseTab(): Promise<void> {
  await view.page.click('#rag-tab-browse');
  await view.page.waitForSelector('#rag-panel-browse:not([hidden])');
}

const textOf = (selector: string): Promise<string> => view.page.$eval(selector, (element) => element.textContent ?? '');

const valueOf = (selector: string): Promise<string> => view.page.$eval(selector, (element) => (element as HTMLInputElement).value);

const isDisabled = (selector: string): Promise<boolean> => view.page.$eval(selector, (element) => (element as HTMLButtonElement).disabled);

const exists = async (selector: string): Promise<boolean> => (await view.page.$(selector)) !== null;

async function waitForText(selector: string, expected: string): Promise<void> {
  await view.page.waitForFunction((sel, text) => (document.querySelector(sel)?.textContent ?? '').includes(text), {}, selector, expected);
}

// textareaへ長い文字列を入れるには、1文字ずつ入力せず値を直接設定してinputイベントを発火させる
async function setMarkdown(markdown: string): Promise<void> {
  await view.page.$eval(
    '#rag-markdown',
    (element, value) => {
      const area = element as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    },
    markdown,
  );
}

async function uploadTo(selector: string, path: string): Promise<void> {
  const input = (await view.page.$(selector)) as ElementHandle<HTMLInputElement> | null;
  if (input === null) {
    throw new Error(`${selector} が見つかりません`);
  }
  await input.uploadFile(path);
}

// 入力欄の内容を消してから、入力する
async function typeInto(selector: string, text: string): Promise<void> {
  await view.page.click(selector, { count: 3 });
  await view.page.keyboard.press('Backspace');
  await view.page.type(selector, text);
}

const POST_DOCUMENTS = (): number => stack.rag.requests.filter((r) => r.method === 'POST' && r.path === '/documents').length;
const POST_SEARCH = (): number => stack.rag.requests.filter((r) => r.method === 'POST' && r.path === '/search').length;

describe('登録', () => {
  it('Markdownファイルを選び、題名・タグ名(複数)・原本PDFをつけて登録できる', async () => {
    await openRag();
    await uploadTo('#rag-markdown-file', makeFile('AHU-1.md', SAMPLE_MD));
    await view.page.waitForFunction(() => (document.querySelector('#rag-markdown') as HTMLTextAreaElement).value !== '');

    // 読み込むと、本文と、登録名(ファイル名)が入る
    expect(await valueOf('#rag-markdown')).toBe(SAMPLE_MD);
    expect(await valueOf('#rag-registration-name')).toBe('AHU-1.md');

    await typeInto('#rag-title', '空調機 AHU-1');
    await view.page.type('#rag-equipment-input', 'AHU-1');
    await view.page.keyboard.press('Enter');
    await view.page.type('#rag-equipment-input', 'AHU-2,');
    await uploadTo('#rag-pdf-file', makeFile('AHU-1.pdf', PDF_BYTES));
    await waitForText('.rag-pdf-row', 'AHU-1.pdf');
    await stack.screenshot(view.page, 'rag-register-filled');

    // 追加したタグ名が、チップで並ぶ
    expect(await view.page.$$eval('.rag-equipment .rag-chip', (chips) => chips.map((chip) => chip.textContent?.replace('×', '').trim()))).toEqual(['AHU-1', 'AHU-2']);

    await view.page.click('#rag-register-submit');
    await view.page.waitForSelector('.rag-success');
    await stack.screenshot(view.page, 'rag-register-success');

    const success = await textOf('.rag-success');
    expect(success).toContain('「空調機 AHU-1」を登録しました');
    expect(success).toContain('登録名: AHU-1.md');
    expect(success).toContain('チャンク数: 2');
    expect(success).toContain('タグ名: AHU-1、AHU-2');
    expect(success).toContain('原本PDF: あり');

    // 偽サーバが受け取った内容
    expect(stack.rag.documents).toHaveLength(1);
    const registered = stack.rag.documents[0];
    expect(registered?.source_file_name).toBe('AHU-1.md');
    expect(registered?.title).toBe('空調機 AHU-1');
    expect(registered?.equipment_names).toEqual(['AHU-1', 'AHU-2']);
    expect(registered?.pdf?.equals(PDF_BYTES)).toBe(true);

    // フォームは初期化される
    expect(await valueOf('#rag-markdown')).toBe('');
    expect(await valueOf('#rag-registration-name')).toBe('');
    expect(await exists('.rag-equipment .rag-chip')).toBe(false);

    // 「確認(一覧)で見る」で、一覧に反映されている
    await view.page.click('.rag-success .button');
    await view.page.waitForSelector('#rag-panel-browse:not([hidden])');
    await view.page.waitForSelector('#rag-documents-table tbody tr');
    const row = await textOf('#rag-documents-table tbody tr');
    expect(row).toContain('空調機 AHU-1');
    expect(row).toContain('AHU-1.md');
    expect(row).toContain('AHU-2');
    expect(row).toContain('開く');
    expect(unexpectedConsoleErrors()).toEqual([]);
  });

  it('貼り付けで登録できる。登録名に拡張子が無ければ .md を補い、タグ名なしは「共通(タグなし)」', async () => {
    await openRag();
    await setMarkdown('# 貼り付けた資料\n\n本文です。');
    await view.page.type('#rag-registration-name', 'メモ');

    // 補う名前が、入力欄の下に表示される(入力欄の値は、書き換えない)
    await waitForText('#rag-registration-name + .field-hint', '「メモ.md」として登録します');
    expect(await valueOf('#rag-registration-name')).toBe('メモ');
    expect(await textOf('.rag-equipment')).toContain('共通(タグなし)の資料として扱います');

    await view.page.click('#rag-register-submit');
    await view.page.waitForSelector('.rag-success');

    const success = await textOf('.rag-success');
    expect(success).toContain('「メモ」を登録しました');
    expect(success).toContain('登録名: メモ.md');
    expect(success).toContain('タグ名: 共通(タグなし)');
    expect(success).toContain('原本PDF: なし');
    expect(stack.rag.documents[0]?.source_file_name).toBe('メモ.md');
    expect(stack.rag.documents[0]?.equipment_names).toEqual([]);
  });

  it('同じ登録名が登録済みなら「置き換わります」と警告し、登録し直すと置き換わる', async () => {
    stack.rag.addDocument({ title: 'R-1', source_file_name: 'R-1.md', markdown: '# a\n\n本文\n\n## b\n\n本文', equipment_names: ['R-1'], has_pdf: true, pdf: PDF_BYTES });
    await openRag();
    await view.page.waitForFunction(() => document.querySelector('#rag-equipment-input-candidates option') !== null);
    await setMarkdown('# 新しい内容\n\n置き換え後の本文');

    await view.page.type('#rag-registration-name', 'R-1');
    await view.page.waitForSelector('.rag-replace-warning');
    const warning = await textOf('.rag-replace-warning');
    expect(warning).toContain('「R-1.md」は既に登録されています');
    expect(warning).toContain('置き換わります');
    expect(warning).toContain('現在 2 チャンク');
    await stack.screenshot(view.page, 'rag-register-replace-warning');

    // 別の名前にすると、警告は消える
    await typeInto('#rag-registration-name', 'R-2');
    await view.page.waitForFunction(() => document.querySelector('.rag-replace-warning') === null);
    await typeInto('#rag-registration-name', 'R-1');
    await view.page.waitForSelector('.rag-replace-warning');

    await view.page.click('#rag-register-submit');
    await view.page.waitForSelector('.rag-success');

    expect(stack.rag.documents).toHaveLength(1);
    expect(stack.rag.documents[0]?.chunk_count).toBe(1);
    // 原本PDFを付けなかったので、既存のものが引き継がれる
    expect(stack.rag.documents[0]?.has_pdf).toBe(true);
  });

  it('Markdownのプレビューは、書式つきで表示し、生のHTMLは実行も描画もしない', async () => {
    await openRag();
    await setMarkdown(`${SAMPLE_MD}\n\n<b>危険</b><script>window.__pwned = 1</script>`);

    await view.page.click('.rag-preview summary');
    await view.page.waitForSelector('.rag-preview .rag-markdown table');

    expect(await view.page.$eval('.rag-preview .rag-markdown h1', (h) => h.textContent)).toBe('ポンプ(サンプル)');
    // HTMLタグは、文字として表示されるだけ
    expect(await exists('.rag-preview .rag-markdown b')).toBe(false);
    expect(await textOf('.rag-preview .rag-markdown')).toContain('<b>危険</b>');
    expect(await view.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  it('入力中の本文があるときにファイルを読み込むと、置き換えてよいか確認する', async () => {
    await openRag();
    await setMarkdown('入力中の本文');

    await uploadTo('#rag-markdown-file', makeFile('new.md', '# 新しい\n\nファイルの内容'));
    await view.page.waitForFunction(() => (document.querySelector('#rag-markdown') as HTMLTextAreaElement).value.includes('ファイルの内容'));

    expect(view.dialogs).toEqual(['入力中のMarkdown本文を、選んだファイルの内容で置き換えますか?']);
    expect(await valueOf('#rag-registration-name')).toBe('new.md');
  });
});

describe('登録の入力の検証', () => {
  it('UTF-8以外のファイルは、文字化けさせずに、理由を表示して読み込まない', async () => {
    await openRag();

    await uploadTo('#rag-markdown-file', makeFile('sjis.md', Buffer.from([0x82, 0xa0, 0x82, 0xa2])));
    await view.page.waitForSelector('.rag-file-error');

    expect(await textOf('.rag-file-error')).toContain('sjis.md: UTF-8として読み込めませんでした');
    expect(await valueOf('#rag-markdown')).toBe('');
    await stack.screenshot(view.page, 'rag-register-file-error');
  });

  it('空のファイル・空白だけのファイル・Markdown以外の拡張子は、理由を表示して読み込まない', async () => {
    await openRag();

    await uploadTo('#rag-markdown-file', makeFile('empty.md', ''));
    await waitForText('.rag-file-error', 'empty.md: ファイルが空です');

    await uploadTo('#rag-markdown-file', makeFile('blank.md', '  \n\n  '));
    await waitForText('.rag-file-error', 'blank.md: 本文が空です');

    await uploadTo('#rag-markdown-file', makeFile('manual.docx', 'x'));
    await waitForText('.rag-file-error', 'Markdown(.md / .markdown / .txt)のファイルを選んでください');

    expect(await valueOf('#rag-markdown')).toBe('');
    expect(stack.rag.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('原本PDFは、PDF以外を断る。選んだPDFは外せる', async () => {
    await openRag();

    await uploadTo('#rag-pdf-file', makeFile('notes.txt', 'x'));
    await waitForText('.rag-pdf-row + .field-error', '原本PDF(.pdf)のファイルを選んでください');

    await uploadTo('#rag-pdf-file', makeFile('ok.pdf', PDF_BYTES));
    await waitForText('.rag-pdf-row', 'ok.pdf');
    expect(await exists('.rag-pdf-row + .field-error')).toBe(false);

    await view.page.click('.rag-pdf-row .button-small');
    await waitForText('.rag-pdf-row', '未選択');
  });

  it('登録名・本文が空、タグ名の追加し忘れ・重複は、送信せずに理由を表示する', async () => {
    await openRag();

    await view.page.click('#rag-register-submit');
    await waitForText('.rag-form-error', '登録名を入力してください。');

    await view.page.type('#rag-registration-name', 'R-1');
    await view.page.click('#rag-register-submit');
    await waitForText('.rag-form-error', 'Markdown本文が空です');

    await setMarkdown('本文');
    await view.page.type('#rag-equipment-input', 'ESP-1');
    await view.page.click('#rag-register-submit');
    await waitForText('.rag-form-error', '入力中のタグ名が追加されていません');

    // 入力欄に戻って追加し、同じ名前をもう一度追加しようとすると、断る
    await view.page.click('#rag-equipment-input');
    await view.page.keyboard.press('Enter');
    await view.page.type('#rag-equipment-input', 'ESP-1');
    await view.page.keyboard.press('Enter');
    await waitForText('.rag-equipment .field-error', '「ESP-1」は既に追加されています');
    expect(await view.page.$$eval('.rag-equipment .rag-chip', (chips) => chips.length)).toBe(1);

    expect(POST_DOCUMENTS()).toBe(0);
  });

  it('タグ名のチップは、×で外せる', async () => {
    await openRag();
    await view.page.type('#rag-equipment-input', 'ESP-1,ESP-2,');

    await view.page.click('.rag-chip-remove[aria-label="ESP-1を外す"]');

    expect(await view.page.$$eval('.rag-equipment .rag-chip', (chips) => chips.map((chip) => chip.textContent?.replace('×', '').trim()))).toEqual(['ESP-2']);
  });
});

describe('登録の失敗と二重送信', () => {
  it('サーバーのエラーは、原因を表示し、入力は残す。登録は1件も増えない', async () => {
    await openRag();
    await setMarkdown('本文');
    await view.page.type('#rag-registration-name', 'R-1');
    stack.rag.failAllWith = 'データベースに接続できません';

    await view.page.click('#rag-register-submit');
    await view.page.waitForSelector('.rag-form-error');

    expect(await textOf('.rag-form-error')).toContain('データベースに接続できません');
    expect(await valueOf('#rag-markdown')).toBe('本文');
    expect(await valueOf('#rag-registration-name')).toBe('R-1');
    expect(await isDisabled('#rag-register-submit')).toBe(false);
    expect(stack.rag.documents).toHaveLength(0);
    expect(unexpectedConsoleErrors()).toEqual([]);
  });

  it('登録ボタンを素早く2回押しても、登録は1回だけ送られる', async () => {
    await openRag();
    await setMarkdown('本文');
    await view.page.type('#rag-registration-name', 'R-1');

    await view.page.evaluate(() => {
      const button = document.querySelector('#rag-register-submit') as HTMLButtonElement;
      button.click();
      button.click();
    });
    await view.page.waitForSelector('.rag-success');

    expect(POST_DOCUMENTS()).toBe(1);
    expect(stack.rag.documents).toHaveLength(1);
  });
});

describe('確認: 一覧', () => {
  it('登録済みの文書を表示し、原本PDFがあるものだけ「開く」リンクを出す', async () => {
    const withPdf = stack.rag.addDocument({ title: 'ESP-1', source_file_name: 'ESP-1.md', markdown: '# 点検\n\n本文', equipment_names: ['ESP-1', 'ESP-2'], has_pdf: true, pdf: PDF_BYTES });
    stack.rag.addDocument({ title: '安全基準', source_file_name: '安全基準.md', markdown: '# 安全\n\n本文\n\n## 二\n\n本文\n\n## 三\n\n本文', equipment_names: [] });
    await openRag();
    await openBrowseTab();
    await view.page.waitForSelector('#rag-documents-table tbody tr');
    await stack.screenshot(view.page, 'rag-browse-list');

    expect(await textOf('#rag-documents-heading')).toBe('登録済みの文書(2件)');
    const rows = await view.page.$$eval('#rag-documents-table tbody tr', (trs) =>
      trs.map((tr) => ({ text: tr.textContent ?? '', links: [...tr.querySelectorAll('a')].map((a) => a.getAttribute('href')) })),
    );
    // 新しい登録が上
    expect(rows[0]?.text).toContain('安全基準');
    expect(rows[0]?.text).toContain('共通(タグなし)');
    expect(rows[0]?.links).toEqual([]);
    expect(rows[1]?.text).toContain('ESP-1');
    expect(rows[1]?.text).toContain('ESP-2');
    expect(rows[1]?.links).toEqual([`/api/rag/documents/${withPdf.id}/pdf`]);

    // リンクの先が、原本PDFを返す
    const response = await view.page.evaluate(async (href) => {
      const r = await fetch(href);
      return { status: r.status, type: r.headers.get('content-type') };
    }, `/api/rag/documents/${withPdf.id}/pdf`);
    expect(response).toEqual({ status: 200, type: 'application/pdf' });
  });

  it('文書が無いときは、案内を表示する', async () => {
    await openRag();
    await openBrowseTab();

    await waitForText('#rag-panel-browse', 'まだ文書が登録されていません');
    expect(await exists('#rag-documents-table')).toBe(false);
  });

  it('「更新」で、画面を開いた後に登録された文書が一覧に出る', async () => {
    await openRag();
    await openBrowseTab();
    await waitForText('#rag-panel-browse', 'まだ文書が登録されていません');

    stack.rag.addDocument({ title: '後から登録', markdown: '# a\n\n本文' });
    await view.page.click('#rag-refresh-documents');

    await view.page.waitForSelector('#rag-documents-table tbody tr');
    expect(await textOf('#rag-documents-table')).toContain('後から登録');
  });

  it('一覧を取得できないときは、原因を表示する', async () => {
    await openRag();
    stack.rag.failAllWith = '取得に失敗しました';
    await openBrowseTab();
    await view.page.click('#rag-refresh-documents');

    await waitForText('#rag-panel-browse [role="alert"]', '登録済みの文書を取得できませんでした: 取得に失敗しました');
  });
});

describe('確認: 簡易検索', () => {
  beforeEach(() => {
    stack.rag.addDocument({ title: 'ポンプ(サンプル)', source_file_name: 'pump.md', markdown: SAMPLE_MD, equipment_names: ['ESP-1'], has_pdf: true, pdf: PDF_BYTES });
    stack.rag.addDocument({ title: 'チラー', source_file_name: 'chiller.md', markdown: '# チラー\n\n冷水の説明です', equipment_names: ['R-1'] });
  });

  async function openSearch(): Promise<void> {
    await openRag();
    await openBrowseTab();
    await view.page.waitForSelector('#rag-documents-table tbody tr');
  }

  async function search(query: string): Promise<void> {
    await typeInto('#rag-search-query', query);
    await view.page.click('#rag-search-submit');
  }

  it('質問文で検索し、順位・文書名・類似度・本文(表は表として)・原本PDFのリンクを表示する', async () => {
    await openSearch();

    await search('異常な振動');
    await view.page.waitForSelector('.rag-result');
    await stack.screenshot(view.page, 'rag-search-results');

    const first = await view.page.$eval('.rag-result', (li) => ({
      rank: li.querySelector('.rag-rank')?.textContent,
      title: li.querySelector('.rag-result-title')?.textContent,
      similarity: li.querySelector('.rag-similarity-value')?.textContent,
      label: li.querySelector('.rag-similarity')?.getAttribute('aria-label'),
      hasTable: li.querySelector('.rag-markdown table') !== null,
      low: li.querySelector('.rag-low-badge') !== null,
      pdfHref: li.querySelector('.rag-result-pdf')?.getAttribute('href') ?? null,
    }));
    expect(first).toMatchObject({ rank: '1', title: 'ポンプ(サンプル)', similarity: '0.80', label: '類似度 0.80', hasTable: true, low: false });
    expect(first.pdfHref).toContain('/api/rag/documents/');
    expect(await textOf('.rag-results-heading')).toBe('「異常な振動」の検索結果(3件)');
    expect(stack.rag.lastSearchBody).toEqual({ query: '異常な振動', top_k: 5 });
    expect(unexpectedConsoleErrors()).toEqual([]);
  });

  it('類似度が0.5未満の結果には「関連度が低い」を表示し、全件が低いときは、警告を出す', async () => {
    await openSearch();

    // 質問の語を含まない本文は、偽サーバが0.3を返す
    await search('まったく関係のない話');
    await view.page.waitForSelector('.rag-all-low');

    expect(await textOf('.rag-all-low')).toContain('該当する記載が見つからない可能性があります');
    expect(await view.page.$$eval('.rag-low-badge', (badges) => badges.map((b) => b.textContent))).toEqual(['関連度が低い', '関連度が低い', '関連度が低い']);
    await stack.screenshot(view.page, 'rag-search-all-low');
  });

  it('高い結果と低い結果が混ざるときは、低い結果にだけ印をつけ、全体の警告は出さない', async () => {
    stack.rag.searchResults = [
      { content: '高い本文', document_title: 'A', document_id: 'a', similarity: 0.82 },
      { content: '低い本文', document_title: 'B', document_id: 'b', similarity: 0.41 },
    ];
    await openSearch();

    await search('なにか');
    await view.page.waitForSelector('.rag-result');

    expect(await view.page.$$eval('.rag-result', (items) => items.map((li) => [li.querySelector('.rag-result-title')?.textContent, li.querySelector('.rag-low-badge') !== null]))).toEqual([
      ['A', false],
      ['B', true],
    ]);
    expect(await exists('.rag-all-low')).toBe(false);
  });

  it('結果が0件のときは、案内を表示する', async () => {
    stack.rag.searchResults = [];
    await openSearch();

    await search('なにか');

    await view.page.waitForSelector('.rag-no-results');
    expect(await textOf('.rag-no-results')).toContain('「なにか」に該当する登録内容は見つかりませんでした');
    expect(await exists('.rag-result')).toBe(false);
  });

  it('タグ名の絞り込みと表示件数が、検索のリクエストに反映される', async () => {
    await openSearch();

    expect(await view.page.$$eval('#rag-search-equipment option', (options) => options.map((o) => o.textContent))).toEqual(['すべて', 'ESP-1', 'R-1']);
    await view.page.select('#rag-search-equipment', 'ESP-1');
    await view.page.select('#rag-search-top-k', '10');
    await search('振動');
    await view.page.waitForSelector('.rag-result');

    expect(stack.rag.lastSearchBody).toEqual({ query: '振動', equipment_name: 'ESP-1', top_k: 10 });
    // 偽サーバは、タグ名に合う文書と、タグ名なしの文書だけを返す
    expect(await view.page.$$eval('.rag-result-title', (titles) => titles.map((t) => t.textContent))).toEqual(['ポンプ(サンプル)', 'ポンプ(サンプル)']);

    await view.page.select('#rag-search-equipment', '');
    await search('振動');
    await view.page.waitForFunction(() => document.querySelectorAll('.rag-result').length === 3);
    expect(stack.rag.lastSearchBody).toEqual({ query: '振動', top_k: 10 });
  });

  it('質問文が空のときは、検索せずに入力を促す', async () => {
    await openSearch();

    await view.page.click('#rag-search-submit');

    await waitForText('#rag-panel-browse .field-error', '質問文を入力してください。');
    expect(POST_SEARCH()).toBe(0);
  });

  it('日本語入力の変換を確定するEnterでは検索せず、通常のEnterでは検索する', async () => {
    await openSearch();
    await view.page.type('#rag-search-query', '振動');

    // 変換中のEnter(isComposing・keyCode 229)
    await view.page.$eval('#rag-search-query', (input) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(POST_SEARCH()).toBe(0);

    await view.page.keyboard.press('Enter');
    await view.page.waitForSelector('.rag-result');
    expect(POST_SEARCH()).toBe(1);
  });

  it('古い検索の応答は、新しい検索の結果を上書きしない', async () => {
    await openSearch();
    // 1回目の検索の応答を止めておき、2回目の検索の結果が出たあとで返す
    await view.page.setRequestInterception(true);
    let held: HTTPRequest | null = null;
    view.page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/rag/search') && held === null) {
        held = request;
        return;
      }
      void request.continue();
    });

    await search('1回目');
    await view.page.waitForFunction(() => document.querySelector('#rag-search-submit')?.textContent === '検索中…');
    // 検索中に、質問を変えてEnterで、新しい検索を始める
    await typeInto('#rag-search-query', '2回目');
    await view.page.keyboard.press('Enter');
    await view.page.waitForFunction(() => document.querySelector('.rag-results-heading')?.textContent?.includes('2回目') === true);

    // 遅れて返ってきた1回目の応答は、画面に反映されない(1回目の通信は、すでに中止されている)
    try {
      await (held as HTTPRequest | null)?.respond({ status: 200, contentType: 'application/json', body: JSON.stringify([{ content: '1回目の結果', document_title: '古い結果', document_id: 'x', similarity: 0.9 }]) });
    } catch {
      // 中止済みの通信への応答は、失敗してよい
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await textOf('.rag-results-heading')).toContain('2回目');
    expect(await view.page.$$eval('.rag-result-title', (titles) => titles.map((t) => t.textContent))).not.toContain('古い結果');
  });
});

describe('OCR・RAGサービスが使えないとき', () => {
  it('案内を表示し、登録・検索の操作を無効にし、一覧を取得しにいかない。使えるようになったら「再確認」で戻る', async () => {
    stack.rag.ready = { ok: false, detail: 'Ollamaに未取得のモデルがあります: glm-ocr', missingModels: ['glm-ocr'] };
    await openRag();
    await view.page.waitForSelector('.readiness-banner');
    await stack.screenshot(view.page, 'rag-not-ready');

    const banner = await textOf('.readiness-banner');
    expect(banner).toContain('この機能は、いまは使えません');
    expect(banner).toContain('Ollamaに未取得のモデルがあります: glm-ocr');
    expect(banner).toContain('モデルの取得(約10GB)に時間がかかります');
    expect(await isDisabled('#rag-register-submit')).toBe(true);
    expect(await view.page.$eval('#rag-markdown', (el) => (el as HTMLTextAreaElement).disabled)).toBe(true);
    expect(await view.page.$eval('.rag-drop .button', (el) => (el as HTMLButtonElement).disabled)).toBe(true);
    await openBrowseTab();
    expect(await isDisabled('#rag-search-submit')).toBe(true);
    expect(await view.page.$eval('#rag-search-query', (el) => (el as HTMLInputElement).disabled)).toBe(true);
    expect(stack.rag.requests.some((r) => r.path === '/documents' || r.path === '/equipment-names')).toBe(false);

    // 使えるようになったら、再確認で、案内が消えて操作できる
    stack.rag.ready = { ok: true };
    stack.rag.addDocument({ title: '復旧後', markdown: '# a\n\n本文' });
    await view.page.click('.readiness-banner .button');
    await view.page.waitForFunction(() => document.querySelector('.readiness-banner') === null);
    await view.page.waitForSelector('#rag-documents-table tbody tr');

    expect(await isDisabled('#rag-search-submit')).toBe(false);
    await view.page.click('#rag-tab-register');
    expect(await isDisabled('#rag-register-submit')).toBe(false);
  });

  it('サービスが未設定(OCR_RAG_URL無し)のときも、理由を表示する', async () => {
    // 未設定のサーバが返す応答(サーバ側の配線は src/server/app.test.ts で確認済み)を、そのまま返す
    await view.page.setRequestInterception(true);
    view.page.on('request', (request) => {
      if (request.url().includes('/api/rag/')) {
        void request.respond({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'rag_not_configured', message: 'OCR・RAGサービスが設定されていません(環境変数 OCR_RAG_URL)。' } }),
        });
      } else {
        void request.continue();
      }
    });

    await openRag();
    await view.page.waitForSelector('.readiness-banner');

    expect(await textOf('.readiness-banner')).toContain('環境変数 OCR_RAG_URL');
    expect(await isDisabled('#rag-register-submit')).toBe(true);
  });
});

describe('画面全体', () => {
  it('登録・確認を行き来しても、入力内容が消えない', async () => {
    await openRag();
    await setMarkdown('入力中の本文');
    await view.page.type('#rag-registration-name', 'R-1');

    await openBrowseTab();
    await view.page.type('#rag-search-query', '検索中の質問');
    await view.page.click('#rag-tab-register');
    await view.page.waitForSelector('#rag-panel-register:not([hidden])');

    expect(await valueOf('#rag-markdown')).toBe('入力中の本文');
    expect(await valueOf('#rag-registration-name')).toBe('R-1');
    await view.page.click('#rag-tab-browse');
    expect(await valueOf('#rag-search-query')).toBe('検索中の質問');
    expect(unexpectedConsoleErrors()).toEqual([]);
  });
});
