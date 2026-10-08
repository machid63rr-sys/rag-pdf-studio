import { describe, expect, it } from 'vitest';
import type { ChatMessage, ManualReference } from '../../ragApi';
import {
  appendDelta, completeAnswer, describeSessionEquipment, dropEmptyAnswer, EXCERPT_PREVIEW_CHARS, excerptPreview, formatSessionDate, isNearBottom, markStopped, sessionTitle, shouldSendOnEnter, STOPPED_NOTE, withPendingTurn,
} from './chatRules';

const reference: ManualReference = { document_title: 'ポンプ', document_id: 'd1', similarity: 0.7, content: '本文', has_pdf: true };

const base: ChatMessage[] = [{ message_id: 'm0', role: 'user', content: '前の質問', manual_references: null, created_at: '2026-10-08T00:00:00Z' }];

const turn = { userId: 'pending-user', assistantId: 'pending-assistant', question: '異常な振動の原因は?', now: '2026-10-08T01:00:00Z' };

describe('shouldSendOnEnter', () => {
  const key = (overrides: Partial<{ key: string; isComposing: boolean; keyCode: number; shiftKey: boolean }>) => ({ key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false, ...overrides });

  it('Enterだけなら送信する', () => {
    expect(shouldSendOnEnter(key({}))).toBe(true);
  });

  it('Shift+Enterは、改行にするので送信しない', () => {
    expect(shouldSendOnEnter(key({ shiftKey: true }))).toBe(false);
  });

  it('日本語入力の変換を確定するEnter(isComposing・keyCode 229)は、送信しない', () => {
    expect(shouldSendOnEnter(key({ isComposing: true }))).toBe(false);
    expect(shouldSendOnEnter(key({ keyCode: 229 }))).toBe(false);
  });

  it('Enter以外のキーは、送信しない', () => {
    expect(shouldSendOnEnter(key({ key: 'a', keyCode: 65 }))).toBe(false);
  });
});

describe('isNearBottom', () => {
  it('最下部から40px未満なら、追従してよい', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 461 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 540, clientHeight: 460 })).toBe(true);
  });

  it('最下部から40px以上離れたら(読み返しているとき)、追従しない', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 460 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 400 })).toBe(false);
  });
});

describe('会話の表示', () => {
  it('タイトルが無い(質問がまだ無い)会話には、仮の名前を付ける', () => {
    expect(sessionTitle({ title: 'ポンプの異常振動について' })).toBe('ポンプの異常振動について');
    expect(sessionTitle({ title: null })).toBe('(無題のチャット)');
    expect(sessionTitle({ title: '  ' })).toBe('(無題のチャット)');
  });

  it('タグ名で絞り込んでいない会話は「絞り込みなし」と表示する', () => {
    expect(describeSessionEquipment('ESP-1')).toBe('ESP-1');
    expect(describeSessionEquipment(null)).toBe('絞り込みなし');
  });
});

describe('formatSessionDate', () => {
  it('日時を、日本語の日付にする', () => {
    expect(formatSessionDate('2026-10-08T12:00:00Z')).toMatch(/^2026\/10\/(8|9)$/);
  });

  it('読み取れない日時は、そのまま表示する', () => {
    expect(formatSessionDate('不明')).toBe('不明');
  });
});

describe('excerptPreview', () => {
  it('100文字以下の抜粋は、そのまま全文を返す', () => {
    const content = 'あ'.repeat(EXCERPT_PREVIEW_CHARS);

    expect(excerptPreview(content)).toEqual({ text: content, truncated: false });
  });

  it('100文字を超える抜粋は、先頭100文字に「…」を付けて切り詰める', () => {
    const preview = excerptPreview('あ'.repeat(EXCERPT_PREVIEW_CHARS + 1));

    expect(preview).toEqual({ text: `${'あ'.repeat(EXCERPT_PREVIEW_CHARS)}…`, truncated: true });
  });

  it('絵文字(サロゲートペア)を、途中で切らない', () => {
    const preview = excerptPreview(`${'あ'.repeat(EXCERPT_PREVIEW_CHARS - 1)}😀😀😀`);

    expect(preview.text).toBe(`${'あ'.repeat(EXCERPT_PREVIEW_CHARS - 1)}😀…`);
    expect(preview.truncated).toBe(true);
  });
});

describe('回答の組み立て', () => {
  it('質問と空の吹き出しを、末尾に足す。元の一覧は変えない', () => {
    const next = withPendingTurn(base, turn);

    expect(base).toHaveLength(1);
    expect(next.map((m) => [m.message_id, m.role, m.content])).toEqual([
      ['m0', 'user', '前の質問'],
      ['pending-user', 'user', '異常な振動の原因は?'],
      ['pending-assistant', 'assistant', ''],
    ]);
  });

  it('断片は、回答の吹き出しの末尾に、届いた順に足す', () => {
    let messages = withPendingTurn(base, turn);

    messages = appendDelta(messages, 'pending-assistant', '軸受の');
    messages = appendDelta(messages, 'pending-assistant', '摩耗です。');

    expect(messages[2]?.content).toBe('軸受の摩耗です。');
    expect(messages[1]?.content).toBe('異常な振動の原因は?');
  });

  it('完了すると、サーバーのIDと時刻に差し替わり、参照マニュアルが付く(それまでは付かない)', () => {
    const streaming = appendDelta(withPendingTurn(base, turn), 'pending-assistant', '回答');
    expect(streaming[2]?.manual_references).toBeNull();

    const done = completeAnswer(streaming, 'pending-assistant', { message_id: 'm2', created_at: '2026-10-08T01:00:05Z' }, [reference]);

    expect(done[2]).toMatchObject({ message_id: 'm2', created_at: '2026-10-08T01:00:05Z', content: '回答', manual_references: [reference] });
  });

  it('参照マニュアルが無い回答は、参照を null のままにする', () => {
    const done = completeAnswer(withPendingTurn(base, turn), 'pending-assistant', { message_id: 'm2', created_at: 'x' }, null);

    expect(done[2]?.manual_references).toBeNull();
  });

  it('停止すると、それまでの断片の末尾に、停止したことを足す', () => {
    const messages = appendDelta(withPendingTurn(base, turn), 'pending-assistant', '途中まで');

    expect(markStopped(messages, 'pending-assistant')[2]?.content).toBe(`途中まで\n\n${STOPPED_NOTE}`);
  });

  it('1文字も届く前に停止したときは、停止したことだけを表示する', () => {
    expect(markStopped(withPendingTurn(base, turn), 'pending-assistant')[2]?.content).toBe(STOPPED_NOTE);
  });

  it('回答が空のまま失敗したときだけ、空の吹き出しを取り除く(質問は残す)', () => {
    const empty = withPendingTurn(base, turn);
    expect(dropEmptyAnswer(empty, 'pending-assistant').map((m) => m.message_id)).toEqual(['m0', 'pending-user']);

    const partial = appendDelta(empty, 'pending-assistant', '途中');
    expect(dropEmptyAnswer(partial, 'pending-assistant')).toHaveLength(3);
  });

  it('対象のIDが無ければ、一覧をそのまま返す', () => {
    expect(appendDelta(base, 'unknown', 'x')).toEqual(base);
  });
});
