import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ManualReference } from '../src/client/ragApi.js';
import { startE2eStack, type E2ePage, type E2eStack } from './support/e2eHarness.js';

/*
 * 機能④「AIチャット」の結合テスト。ビルド済みクライアントを実サーバ・実Chromiumで動かし、
 * ocr-ragは偽物(FakeRagServer)につなぐ。偽サーバは、回答を断片ごとに流し、途中で止めておける
 * (回答が少しずつ表示されること・停止・サーバーの失敗を、画面から確認するため)。
 */
let stack: E2eStack;
let view: E2ePage;

beforeAll(async () => {
  stack = await startE2eStack();
});

afterAll(async () => {
  await stack.stop();
});

beforeEach(async () => {
  // 偽サーバを、毎回、初期状態に戻す
  const rag = stack.rag;
  rag.documents.length = 0;
  rag.drafts.clear();
  rag.requests.length = 0;
  rag.ready = { ok: true };
  rag.failAllWith = null;
  rag.resetChat();
  view = await stack.newPage();
});

afterEach(async () => {
  await view.page.close();
});

// HTTPのエラー(わざと起こしたもの)は、ブラウザがコンソールに「Failed to load resource」を出すため、除いて確認する
const unexpectedConsoleErrors = (): string[] => view.consoleErrors.filter((message) => !message.includes('Failed to load resource'));

const textOf = (selector: string): Promise<string> => view.page.$eval(selector, (element) => element.textContent ?? '');

const valueOf = (selector: string): Promise<string> => view.page.$eval(selector, (element) => (element as HTMLInputElement).value);

const isDisabled = (selector: string): Promise<boolean> => view.page.$eval(selector, (element) => (element as HTMLButtonElement).disabled);

const exists = async (selector: string): Promise<boolean> => (await view.page.$(selector)) !== null;

const count = (selector: string): Promise<number> => view.page.$$eval(selector, (elements) => elements.length);

async function waitForText(selector: string, expected: string): Promise<void> {
  await view.page.waitForFunction((sel, text) => (document.querySelector(sel)?.textContent ?? '').includes(text), {}, selector, expected);
}

async function waitForExactText(selector: string, expected: string): Promise<void> {
  await view.page.waitForFunction((sel, text) => document.querySelector(sel)?.textContent === text, {}, selector, expected);
}

// 偽サーバ側の状態が、期待どおりになるまで待つ
async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function openChat(): Promise<void> {
  await view.page.goto(stack.baseUrl);
  await view.page.waitForSelector('#feature-tab-chat');
  await view.page.click('#feature-tab-chat');
  await view.page.waitForSelector('#chat-question');
}

// 回答の生成が終わった(送信できる状態に戻り、停止ボタンが消えた)のを待つ
async function waitForIdle(): Promise<void> {
  await view.page.waitForSelector('#chat-send:not([disabled])');
  await view.page.waitForFunction(() => document.querySelector('#chat-stop') === null);
}

async function ask(question: string): Promise<void> {
  await view.page.type('#chat-question', question);
  await view.page.click('#chat-send');
}

const reference = (overrides: Partial<ManualReference> = {}): ManualReference => ({
  document_title: 'ポンプ(サンプル)',
  document_id: 'doc-1',
  similarity: 0.8,
  content: '**軸受の摩耗**: 異常な振動の原因になります。',
  has_pdf: true,
  ...overrides,
});

const savedMessages = (references: ManualReference[] | null): ChatMessage[] => [
  { message_id: 'm1', role: 'user', content: '異常な振動の原因は?', manual_references: null, created_at: '2026-10-07T01:00:00Z' },
  { message_id: 'm2', role: 'assistant', content: '軸受の摩耗が考えられます。', manual_references: references, created_at: '2026-10-07T01:00:05Z' },
];

const bubbleText = (role: 'user' | 'assistant'): Promise<string[]> => view.page.$$eval(`.chat-bubble-${role} .chat-bubble-content`, (elements) => elements.map((element) => element.textContent ?? ''));

describe('質問と回答', () => {
  it('回答が届いた分から順に表示され、完了すると、参照マニュアルが回答の下に出る', async () => {
    stack.rag.chatReply = { references: [reference()], chunks: ['軸受の', '摩耗が考えられます。'], holdAfterChunks: 1 };
    await openChat();

    await ask('異常な振動の原因は?');

    // 1つ目の断片だけが届いた状態
    await waitForExactText('.chat-bubble-assistant .chat-bubble-content', '軸受の');
    expect(stack.rag.chatHeld).toBe(true);
    expect(await bubbleText('user')).toEqual(['異常な振動の原因は?']);
    expect(await textOf('#chat-pending')).toContain('回答を生成しています');
    expect(await isDisabled('#chat-question')).toBe(true);
    // 送信は無効にして残し(ダブルクリックで、送信直後に止めてしまわない)、停止は別のボタンにする
    expect(await isDisabled('#chat-send')).toBe(true);
    expect(await textOf('#chat-stop')).toContain('停止');
    // 参照マニュアルは、回答の完了まで出さない(回答より先に届いていても)
    expect(await exists('.chat-refs')).toBe(false);
    await stack.screenshot(view.page, 'chat-streaming');

    stack.rag.releaseChat();
    await view.page.waitForSelector('.chat-refs');
    await waitForIdle();
    await stack.screenshot(view.page, 'chat-answer');

    expect(await bubbleText('assistant')).toEqual(['軸受の摩耗が考えられます。']);
    expect(await exists('.chat-bubble-assistant > .chat-bubble-content + .chat-refs')).toBe(true);
    expect(await textOf('.chat-refs-title')).toContain('参照マニュアル(1件)');
    expect(await exists('#chat-pending')).toBe(false);

    // 入力欄は空に戻り、続けて質問できる
    expect(await isDisabled('#chat-question')).toBe(false);
    expect(await valueOf('#chat-question')).toBe('');
    expect(await view.page.evaluate(() => document.activeElement?.id)).toBe('chat-question');

    // 会話が作られ、履歴に、最初の質問が題名として出る
    await view.page.waitForSelector('.chat-session');
    expect(await textOf('.chat-session-title')).toBe('異常な振動の原因は?');
    expect(await textOf('.chat-session-meta')).toContain('全機器');
    expect(stack.rag.lastCreateSessionBody).toEqual({ equipment_name: null });
    expect(stack.rag.chatQuestions).toEqual([{ sessionId: stack.rag.chatSessions[0]?.session_id, question: '異常な振動の原因は?' }]);
    expect(unexpectedConsoleErrors()).toEqual([]);
  });

  it('続けて質問すると、同じ会話に続き、会話は増えない', async () => {
    stack.rag.chatReply = { references: null, chunks: ['1回目の回答'] };
    await openChat();
    await ask('1つ目の質問');
    await waitForIdle();

    stack.rag.chatReply = { references: null, chunks: ['2回目の回答'] };
    await ask('2つ目の質問');
    await waitForText('#chat-messages', '2回目の回答');
    await waitForIdle();

    expect(await bubbleText('user')).toEqual(['1つ目の質問', '2つ目の質問']);
    expect(await bubbleText('assistant')).toEqual(['1回目の回答', '2回目の回答']);
    expect(stack.rag.chatSessions).toHaveLength(1);
    expect(stack.rag.chatQuestions.map((q) => q.sessionId)).toEqual([stack.rag.chatSessions[0]?.session_id, stack.rag.chatSessions[0]?.session_id]);
    expect(await count('.chat-session')).toBe(1);
  });

  it('根拠にできる抜粋が無い回答には、参照マニュアルを出さない', async () => {
    stack.rag.chatReply = { references: null, chunks: ['マニュアルには、その記載がありません。'] };
    await openChat();

    await ask('社食のメニューは?');
    await waitForIdle();

    expect(await bubbleText('assistant')).toEqual(['マニュアルには、その記載がありません。']);
    expect(await exists('.chat-refs')).toBe(false);
  });

  it('回答は書式を付けない文字として表示し、改行はそのまま残す(HTMLも実行しない)', async () => {
    stack.rag.chatReply = { references: null, chunks: ['【原因】\n・軸受の摩耗\n', '**太字にはしない** <b>危険</b><script>window.__pwned = 1</script>'] };
    await openChat();

    await ask('原因は?');
    await waitForIdle();

    expect(await bubbleText('assistant')).toEqual(['【原因】\n・軸受の摩耗\n**太字にはしない** <b>危険</b><script>window.__pwned = 1</script>']);
    expect(await exists('.chat-bubble-assistant strong, .chat-bubble-assistant b')).toBe(false);
    expect(await view.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  it('Enterで送信し、Shift+Enterは改行にする。日本語入力の変換を確定するEnterでは送信しない', async () => {
    await openChat();
    await view.page.type('#chat-question', '1行目');

    await view.page.keyboard.down('Shift');
    await view.page.keyboard.press('Enter');
    await view.page.keyboard.up('Shift');
    await view.page.type('#chat-question', '2行目');
    expect(await valueOf('#chat-question')).toBe('1行目\n2行目');

    // 変換中のEnter(isComposing・keyCode 229)
    await view.page.$eval('#chat-question', (input) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    await sleep(300);
    expect(stack.rag.chatQuestions).toEqual([]);
    expect(stack.rag.requests.some((r) => r.method === 'POST' && r.path === '/chat/sessions')).toBe(false);

    await view.page.keyboard.press('Enter');
    await view.page.waitForSelector('.chat-bubble-assistant');

    expect(stack.rag.chatQuestions.map((q) => q.question)).toEqual(['1行目\n2行目']);
  });

  it('Enterを素早く2回押しても、質問は1回だけ送られる', async () => {
    await openChat();
    await view.page.type('#chat-question', '質問です');

    await view.page.keyboard.press('Enter');
    await view.page.keyboard.press('Enter');
    await waitForIdle();

    expect(stack.rag.chatQuestions).toHaveLength(1);
    expect(stack.rag.chatSessions).toHaveLength(1);
  });

  it('質問が空のときは、送らずに入力を促す', async () => {
    await openChat();

    await view.page.click('#chat-send');
    await waitForText('.field-error', '質問文を入力してください。');
    await view.page.type('#chat-question', '   ');
    await view.page.click('#chat-send');

    expect(await textOf('.field-error')).toBe('質問文を入力してください。');
    expect(stack.rag.requests.some((r) => r.path.startsWith('/chat/') && r.method === 'POST')).toBe(false);

    // 入力し始めると、案内は消える
    await view.page.type('#chat-question', 'あ');
    await view.page.waitForFunction(() => document.querySelector('.field-error') === null);
  });
});

describe('参照マニュアル', () => {
  it('類似度・「関連度が低い」の印・原本PDFのリンクを、参照ごとに出し分ける', async () => {
    stack.rag.chatReply = {
      references: [reference({ document_id: 'doc-pdf', document_title: '原本あり', similarity: 0.8, has_pdf: true }), reference({ document_id: 'doc-nopdf', document_title: '原本なし', similarity: 0.3, has_pdf: false })],
      chunks: ['回答です。'],
    };
    await openChat();

    await ask('質問');
    await view.page.waitForSelector('.chat-ref');
    await stack.screenshot(view.page, 'chat-references');

    const refs = await view.page.$$eval('.chat-ref', (items) =>
      items.map((item) => ({
        title: item.querySelector('.chat-ref-title')?.textContent,
        similarity: item.querySelector('.chat-ref-similarity-value')?.textContent,
        label: item.querySelector('.chat-ref-similarity')?.getAttribute('aria-label'),
        low: item.querySelector('.chat-ref-low-badge')?.textContent ?? null,
        pdfHref: item.querySelector('a.chat-ref-pdf')?.getAttribute('href') ?? null,
        pdfTarget: item.querySelector('a.chat-ref-pdf')?.getAttribute('target') ?? null,
        pdfRel: item.querySelector('a.chat-ref-pdf')?.getAttribute('rel') ?? null,
      })),
    );
    expect(refs).toEqual([
      { title: '『原本あり』', similarity: '0.80', label: '類似度 0.80', low: null, pdfHref: '/api/rag/documents/doc-pdf/pdf', pdfTarget: '_blank', pdfRel: 'noopener noreferrer' },
      { title: '『原本なし』', similarity: '0.30', label: '類似度 0.30', low: '関連度が低い', pdfHref: null, pdfTarget: null, pdfRel: null },
    ]);
  });

  it('短い抜粋は書式つきで全文を出し、100文字を超える抜粋は先頭だけを書式なしで見せて、「続きを読む」で全文を開く', async () => {
    const long = `## 異常な振動\n\n| 不具合 | 原因 |\n|---|---|\n| 異常な振動 | 軸受の摩耗 |\n\n${'詳しい点検の手順です。'.repeat(15)}`;
    stack.rag.chatReply = { references: [reference({ document_id: 'short', content: '**軸受の摩耗**: 異常な振動の原因になります。' }), reference({ document_id: 'long', content: long })], chunks: ['回答です。'] };
    await openChat();

    await ask('質問');
    await view.page.waitForSelector('.chat-ref');

    // 短い抜粋: そのまま、Markdownとして表示する(折りたたみは出さない)
    expect(await view.page.$eval('.chat-ref:nth-child(1) .rag-markdown strong', (element) => element.textContent)).toBe('軸受の摩耗');
    expect(await exists('.chat-ref:nth-child(1) .chat-ref-toggle')).toBe(false);

    // 長い抜粋: 先頭100文字+「…」を、書式なしの文字で表示する(表や見出しにはしない)
    const preview = Array.from(long).slice(0, 100).join('');
    expect(await textOf('.chat-ref:nth-child(2) .chat-ref-preview')).toBe(`${preview}…`);
    expect(await exists('.chat-ref:nth-child(2) .rag-markdown')).toBe(false);
    expect(await textOf('.chat-ref:nth-child(2) .chat-ref-toggle')).toBe('続きを読む▾');

    await view.page.click('.chat-ref:nth-child(2) .chat-ref-toggle');
    await view.page.waitForSelector('.chat-ref:nth-child(2) .rag-markdown table');
    expect(await view.page.$eval('.chat-ref:nth-child(2) .chat-ref-toggle', (element) => [element.textContent, element.getAttribute('aria-expanded')])).toEqual(['折りたたむ▴', 'true']);
    expect(await exists('.chat-ref:nth-child(2) .chat-ref-preview')).toBe(false);

    await view.page.click('.chat-ref:nth-child(2) .chat-ref-toggle');
    await view.page.waitForSelector('.chat-ref:nth-child(2) .chat-ref-preview');
    expect(await exists('.chat-ref:nth-child(2) .rag-markdown')).toBe(false);
  });
});

describe('機器名の絞り込み', () => {
  it('新しい会話の最初の質問のときだけ、機器名で絞り込める。選んだ機器名で会話が作られ、履歴に出る', async () => {
    stack.rag.addDocument({ title: 'ポンプ', markdown: '# ポンプ\n\n説明', equipment_names: ['ESP-1'] });
    stack.rag.addDocument({ title: 'チラー', markdown: '# チラー\n\n説明', equipment_names: ['R-1'] });
    await openChat();
    await view.page.waitForFunction(() => document.querySelectorAll('#chat-equipment option').length > 1);

    expect(await view.page.$$eval('#chat-equipment option', (options) => options.map((option) => option.textContent))).toEqual(['すべて', 'ESP-1', 'R-1']);
    expect(await valueOf('#chat-equipment')).toBe('');

    await view.page.select('#chat-equipment', 'ESP-1');
    await ask('点検の手順は?');
    await waitForIdle();

    expect(stack.rag.lastCreateSessionBody).toEqual({ equipment_name: 'ESP-1' });
    // 最初の質問を送ったあとは、絞り込みを変えられない
    expect(await exists('#chat-equipment')).toBe(false);
    await view.page.waitForSelector('.chat-session');
    expect(await textOf('.chat-session-meta')).toContain('ESP-1');

    // 新規チャットでは、絞り込みは「すべて」に戻る
    await view.page.click('#chat-new');
    await view.page.waitForSelector('#chat-equipment');
    expect(await valueOf('#chat-equipment')).toBe('');
  });
});

describe('会話の履歴', () => {
  it('履歴から会話を開くと、過去の質問・回答・参照マニュアルが表示され、新規チャットに戻れる', async () => {
    stack.rag.addChatSession({ title: '異常な振動の原因は?', equipment_name: 'ESP-1', messages: savedMessages([reference({ document_id: 'saved-doc', has_pdf: false })]) });
    await openChat();
    await view.page.waitForSelector('.chat-session');
    // 会話を開く前は、新しい会話の画面
    expect(await exists('#chat-equipment')).toBe(true);
    expect(await count('.chat-bubble')).toBe(0);

    await view.page.click('.chat-session-main');
    await view.page.waitForSelector('.chat-bubble-assistant .chat-refs');
    await stack.screenshot(view.page, 'chat-history-opened');

    expect(await bubbleText('user')).toEqual(['異常な振動の原因は?']);
    expect(await bubbleText('assistant')).toEqual(['軸受の摩耗が考えられます。']);
    expect(await textOf('.chat-ref-title')).toBe('『ポンプ(サンプル)』');
    expect(await exists('a.chat-ref-pdf')).toBe(false);
    expect(await view.page.$eval('.chat-session-main', (element) => element.getAttribute('aria-current'))).toBe('true');
    expect(await textOf('.chat-session-meta')).toContain('ESP-1');
    expect(await exists('#chat-equipment')).toBe(false);

    // 続けて質問すると、この会話に続く
    stack.rag.chatReply = { references: null, chunks: ['続きの回答'] };
    await ask('他の原因は?');
    await waitForText('#chat-messages', '続きの回答');
    expect(stack.rag.chatQuestions[0]?.sessionId).toBe(stack.rag.chatSessions[0]?.session_id);
    expect(stack.rag.chatSessions).toHaveLength(1);
    expect(await count('.chat-bubble')).toBe(4);

    await waitForIdle();
    await view.page.click('#chat-new');
    await view.page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length === 0);
    expect(await exists('#chat-equipment')).toBe(true);
    expect(unexpectedConsoleErrors()).toEqual([]);
  });

  it('履歴は、新しい会話が上に並び、題名が無い会話には仮の名前が付く。会話が無いときは案内を出す', async () => {
    await openChat();
    expect(await textOf('#chat-sessions-empty')).toContain('まだ会話はありません');

    // 画面を開き直して、履歴を取得し直す
    stack.rag.addChatSession({ title: '古い会話' });
    stack.rag.addChatSession({ title: null });
    await view.page.goto(stack.baseUrl);
    await view.page.click('#feature-tab-chat');
    await view.page.waitForSelector('.chat-session');

    expect(await view.page.$$eval('.chat-session-title', (titles) => titles.map((title) => title.textContent))).toEqual(['(無題のチャット)', '古い会話']);
  });

  it('削除は、その項目の中で確認する。キャンセルすれば残り、削除すると消える。開いていた会話なら、新規チャットに戻る', async () => {
    stack.rag.addChatSession({ title: '残す会話', messages: savedMessages(null) });
    stack.rag.addChatSession({ title: '消す会話', messages: savedMessages(null) });
    await openChat();
    await view.page.waitForSelector('.chat-session');
    await view.page.click('.chat-session:nth-child(1) .chat-session-main');
    await view.page.waitForSelector('.chat-bubble');

    // 確認が出る。題名は消えず、他の項目には確認が出ない
    await view.page.click('.chat-session:nth-child(1) .chat-session-delete');
    await view.page.waitForSelector('.chat-session-confirm-text');
    expect(await textOf('.chat-session:nth-child(1)')).toContain('消す会話');
    expect(await textOf('.chat-session:nth-child(1)')).toContain('このチャットを削除しますか?');
    expect(await count('.chat-session-confirm-text')).toBe(1);
    await stack.screenshot(view.page, 'chat-delete-confirm');

    // キャンセルすると、何も変わらない
    await view.page.click('.chat-session-cancel');
    await view.page.waitForFunction(() => document.querySelector('.chat-session-confirm-text') === null);
    expect(stack.rag.chatSessions).toHaveLength(2);

    await view.page.click('.chat-session:nth-child(1) .chat-session-delete');
    await view.page.click('.chat-session-confirm-delete');
    await view.page.waitForFunction(() => document.querySelectorAll('.chat-session').length === 1);

    expect(stack.rag.chatSessions.map((s) => s.title)).toEqual(['残す会話']);
    expect(await textOf('.chat-session-title')).toBe('残す会話');
    // 開いていた会話を消したので、新規チャットに戻る
    expect(await count('.chat-bubble')).toBe(0);
    expect(await exists('#chat-equipment')).toBe(true);
    // window.confirm は使わない
    expect(view.dialogs).toEqual([]);
  });

  it('履歴を取得できないときは、原因を表示する', async () => {
    stack.rag.failAllWith = 'データベースに接続できません';

    await view.page.goto(stack.baseUrl);
    await view.page.click('#feature-tab-chat');
    await view.page.waitForSelector('.notice-error');

    expect(await textOf('.notice-error')).toContain('会話の履歴を取得できませんでした: データベースに接続できません');
  });
});

describe('生成の停止', () => {
  const heldReply = { references: [reference()], chunks: ['最初の断片', '続きの断片'], holdAfterChunks: 1 };

  async function expectStopped(): Promise<void> {
    await waitForIdle();
    expect(await bubbleText('assistant')).toEqual(['最初の断片\n\n（回答の生成を停止しました）']);
    // 停止した回答は、参照マニュアルを付けない。入力欄は、続けて質問できる状態に戻る
    expect(await exists('.chat-refs')).toBe(false);
    expect(await isDisabled('#chat-question')).toBe(false);
    // サーバーは、切断を知り、回答を保存しない(質問だけが残る)
    await eventually(() => stack.rag.chatAborted === 1, 'サーバーが、ブラウザの切断を検知しませんでした');
    expect(stack.rag.chatSessions[0]?.messages.map((m) => m.role)).toEqual(['user']);
  }

  it('「■ 停止」で、生成を止められる', async () => {
    stack.rag.chatReply = heldReply;
    await openChat();
    await ask('質問');
    await waitForExactText('.chat-bubble-assistant .chat-bubble-content', '最初の断片');

    await view.page.click('#chat-stop');

    await expectStopped();
    expect(unexpectedConsoleErrors()).toEqual([]);
  });

  it('ESCキーでも、入力欄にフォーカスが無くても、生成を止められる', async () => {
    stack.rag.chatReply = heldReply;
    await openChat();
    await ask('質問');
    await waitForExactText('.chat-bubble-assistant .chat-bubble-content', '最初の断片');

    await view.page.keyboard.press('Escape');

    await expectStopped();
  });

  it('他のタブを見ているときのESCでは、止めない', async () => {
    stack.rag.chatReply = heldReply;
    await openChat();
    await ask('質問');
    await waitForExactText('.chat-bubble-assistant .chat-bubble-content', '最初の断片');

    await view.page.click('#feature-tab-pdf');
    await view.page.keyboard.press('Escape');
    await sleep(300);
    expect(stack.rag.chatAborted).toBe(0);
    expect(stack.rag.chatHeld).toBe(true);

    // チャットに戻って続きが届くと、そのまま完了する(別のタブにいる間も、受信は続いている)
    await view.page.click('#feature-tab-chat');
    stack.rag.releaseChat();
    await view.page.waitForSelector('.chat-refs');
    expect(await bubbleText('assistant')).toEqual(['最初の断片続きの断片']);
  });
});

describe('失敗', () => {
  it('回答の途中で生成が失敗したら、届いた分を残して、原因を表示する。会話は続けられる', async () => {
    stack.rag.chatReply = { references: [reference()], chunks: ['途中まで'], error: 'Ollamaに接続できません' };
    await openChat();

    await ask('質問');
    await view.page.waitForSelector('#chat-error');
    await waitForIdle();

    expect(await textOf('#chat-error')).toBe('回答の生成に失敗しました: Ollamaに接続できません');
    expect(await bubbleText('assistant')).toEqual(['途中まで']);
    // 完了していない回答には、参照マニュアルを付けない
    expect(await exists('.chat-refs')).toBe(false);
    expect(await isDisabled('#chat-question')).toBe(false);
    await stack.screenshot(view.page, 'chat-error');

    // 次の質問を送ると、エラーの表示は消える
    stack.rag.chatReply = { references: null, chunks: ['今度は成功'] };
    await ask('もう一度');
    await view.page.waitForFunction(() => document.querySelector('#chat-error') === null);
    await waitForText('#chat-messages', '今度は成功');
  });

  it('回答が1文字も届かないまま失敗したら、空の吹き出しは残さず、質問だけを残す', async () => {
    stack.rag.chatReply = { references: null, chunks: [], error: 'モデルが見つかりません' };
    await openChat();

    await ask('質問');
    await view.page.waitForSelector('#chat-error');

    expect(await textOf('#chat-error')).toContain('モデルが見つかりません');
    expect(await bubbleText('user')).toEqual(['質問']);
    expect(await count('.chat-bubble-assistant')).toBe(0);
  });

  it('完了もエラーも届かずに、ストリームが終わったら、途中で終わったことを表示する', async () => {
    stack.rag.chatReply = { references: [reference()], chunks: ['途中まで'], endWithoutDone: true };
    await openChat();

    await ask('質問');
    await view.page.waitForSelector('#chat-error');

    expect(await textOf('#chat-error')).toContain('回答が途中で終了しました');
    expect(await bubbleText('assistant')).toEqual(['途中まで']);
    expect(await exists('.chat-refs')).toBe(false);
    expect(await isDisabled('#chat-question')).toBe(false);
  });

  it('質問を受け付けてもらえないとき(ストリームの開始前の失敗)は、原因を表示する', async () => {
    stack.rag.chatMessageError = { status: 502, detail: 'Ollamaへの接続・呼び出しに失敗しました' };
    await openChat();

    await ask('質問');
    await view.page.waitForSelector('#chat-error');

    expect(await textOf('#chat-error')).toBe('回答の生成に失敗しました: Ollamaへの接続・呼び出しに失敗しました');
    expect(await bubbleText('user')).toEqual(['質問']);
    expect(await count('.chat-bubble-assistant')).toBe(0);
    expect(await isDisabled('#chat-question')).toBe(false);
  });

  it('会話を作れないときは、原因を表示し、入力した質問を残す', async () => {
    await openChat();
    stack.rag.failAllWith = 'データベースに接続できません';

    await ask('消えてほしくない質問');
    await view.page.waitForSelector('#chat-error');

    expect(await textOf('#chat-error')).toBe('新しいチャットを作れませんでした: データベースに接続できません');
    expect(await valueOf('#chat-question')).toBe('消えてほしくない質問');
    expect(await count('.chat-bubble')).toBe(0);
    expect(await isDisabled('#chat-question')).toBe(false);
  });
});

describe('表示', () => {
  it('回答が長く、最下部の近くにいる間は、新しい断片に合わせて追従し、上へ読み返しているときは、戻さない', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `${i + 1}行目の点検手順です。\n`);
    stack.rag.chatReply = { references: null, chunks: lines, holdAfterChunks: 40 };
    await openChat();

    await ask('手順を教えて');
    await eventually(() => stack.rag.chatHeld, '回答が途中で止まりませんでした');
    await view.page.waitForFunction(() => (document.querySelector('#chat-messages')?.textContent ?? '').includes('40行目'));
    const metrics = (): Promise<{ top: number; max: number }> =>
      view.page.$eval('#chat-messages', (element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));

    // 最下部にいる間は、追従する(はみ出している)
    const followed = await metrics();
    expect(followed.max).toBeGreaterThan(100);
    expect(followed.max - followed.top).toBeLessThan(40);

    // 上へ読み返すと、続きが届いても、最下部へ戻さない
    await view.page.$eval('#chat-messages', (element) => {
      element.scrollTop = 0;
    });
    await sleep(200);
    stack.rag.releaseChat();
    await waitForIdle();
    expect((await metrics()).top).toBeLessThan(40);
  });

  it('サービスが使えないときは、案内を表示し、操作を無効にし、会話の履歴を取得しにいかない。使えるようになったら「再確認」で戻る', async () => {
    stack.rag.ready = { ok: false, detail: 'Ollamaに未取得のモデルがあります: qwen3.5:9b', missingModels: ['qwen3.5:9b'] };
    stack.rag.addChatSession({ title: '復旧後に見える会話' });
    await view.page.goto(stack.baseUrl);
    await view.page.click('#feature-tab-chat');
    await view.page.waitForSelector('.readiness-banner');
    await stack.screenshot(view.page, 'chat-not-ready');

    expect(await textOf('.readiness-banner')).toContain('Ollamaに未取得のモデルがあります: qwen3.5:9b');
    expect(await isDisabled('#chat-question')).toBe(true);
    expect(await isDisabled('#chat-send')).toBe(true);
    expect(await isDisabled('#chat-new')).toBe(true);
    expect(await isDisabled('#chat-equipment')).toBe(true);
    expect(stack.rag.requests.some((r) => r.path.startsWith('/chat') || r.path === '/documents' || r.path === '/equipment-names')).toBe(false);

    stack.rag.ready = { ok: true };
    await view.page.click('.readiness-banner .button');
    await view.page.waitForFunction(() => document.querySelector('.readiness-banner') === null);
    await view.page.waitForSelector('.chat-session');

    expect(await textOf('.chat-session-title')).toBe('復旧後に見える会話');
    expect(await isDisabled('#chat-question')).toBe(false);
    expect(await isDisabled('#chat-send')).toBe(false);
  });

  it('他のタブへ移って戻っても、入力中の質問と、会話の内容が消えない', async () => {
    stack.rag.chatReply = { references: [reference()], chunks: ['回答です。'] };
    await openChat();
    await ask('最初の質問');
    await view.page.waitForSelector('.chat-refs');
    await view.page.type('#chat-question', '入力途中の質問');

    await view.page.click('#feature-tab-rag');
    await view.page.click('#feature-tab-chat');

    expect(await valueOf('#chat-question')).toBe('入力途中の質問');
    expect(await bubbleText('assistant')).toEqual(['回答です。']);
    expect(await exists('.chat-refs')).toBe(true);
  });
});
