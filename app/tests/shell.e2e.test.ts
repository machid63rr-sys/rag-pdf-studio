import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startE2eStack, type E2ePage, type E2eStack } from './support/e2eHarness.js';

/* 画面全体の枠(4つの機能のタブ)の結合テスト。各機能の中身は、機能ごとのテストで検証する */
let stack: E2eStack;
let view: E2ePage;

beforeAll(async () => {
  stack = await startE2eStack();
});

afterAll(async () => {
  await stack.stop();
});

beforeEach(async () => {
  view = await stack.newPage();
  await view.page.goto(stack.baseUrl);
  await view.page.waitForSelector('#paste-area');
});

const selectedTab = (): Promise<string[]> =>
  view.page.$$eval('.shell-tabs [role="tab"]', (tabs) => tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.id));

const paneState = (id: string): Promise<'absent' | 'hidden' | 'visible'> =>
  view.page.evaluate((paneId) => {
    const pane = document.getElementById(paneId);
    if (pane === null) {
      return 'absent';
    }
    return pane.hidden ? 'hidden' : 'visible';
  }, id);

describe('機能の切り替えタブ', () => {
  it('最初は「① MD/HTML → PDF」が開き、②③④はまだ作られていない', async () => {
    expect(await selectedTab()).toEqual(['feature-tab-pdf']);
    expect(await paneState('feature-pane-pdf')).toBe('visible');
    expect(await paneState('feature-pane-ocr')).toBe('absent');
    expect(await paneState('feature-pane-rag')).toBe('absent');
    expect(await paneState('feature-pane-chat')).toBe('absent');
    expect(await view.page.$$eval('.shell-tabs [role="tab"]', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['① MD/HTML → PDF', '② PDF → OCR → MD', '③ RAG(登録・確認)', '④ AIチャット']);
  });

  it('タブを押すと、その機能が開き、前の機能は隠れる', async () => {
    await view.page.click('#feature-tab-ocr');

    expect(await selectedTab()).toEqual(['feature-tab-ocr']);
    expect(await paneState('feature-pane-ocr')).toBe('visible');
    expect(await paneState('feature-pane-pdf')).toBe('hidden');

    await view.page.click('#feature-tab-rag');

    expect(await selectedTab()).toEqual(['feature-tab-rag']);
    expect(await paneState('feature-pane-rag')).toBe('visible');
    expect(await paneState('feature-pane-ocr')).toBe('hidden');
    await stack.screenshot(view.page, 'shell-rag-tab');

    await view.page.click('#feature-tab-chat');

    expect(await selectedTab()).toEqual(['feature-tab-chat']);
    expect(await paneState('feature-pane-chat')).toBe('visible');
    expect(await paneState('feature-pane-rag')).toBe('hidden');
    await stack.screenshot(view.page, 'shell-chat-tab');
  });

  it('タブを切り替えても、前の機能の入力内容は消えない', async () => {
    await view.page.type('#paste-area', '編集中の文章');

    await view.page.click('#feature-tab-ocr');
    await view.page.click('#feature-tab-pdf');

    expect(await view.page.$eval('#paste-area', (area) => (area as HTMLTextAreaElement).value)).toBe('編集中の文章');
    expect(view.consoleErrors).toEqual([]);
  });
});
