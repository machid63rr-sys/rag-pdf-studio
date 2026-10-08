import { describe, expect, it } from 'vitest';
import { ChatStreamFormatError, parseChatStreamEvent, splitNdjsonLines } from './chatStream';

describe('splitNdjsonLines', () => {
  it('改行まで届いた行だけを返し、改行がまだの末尾は、未完成の行として残す', () => {
    expect(splitNdjsonLines('', '{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], pending: '{"c"' });
  });

  it('行の途中で区切られた断片は、次の断片とつないで1行にする', () => {
    const first = splitNdjsonLines('', '{"type":"del');
    expect(first).toEqual({ lines: [], pending: '{"type":"del' });

    const second = splitNdjsonLines(first.pending, 'ta"}\n');

    expect(second).toEqual({ lines: ['{"type":"delta"}'], pending: '' });
  });

  it('改行そのものが、断片の境目にあっても、行を取りこぼさない', () => {
    const first = splitNdjsonLines('', '{"a":1}');
    const second = splitNdjsonLines(first.pending, '\n');

    expect(first.lines).toEqual([]);
    expect(second.lines).toEqual(['{"a":1}']);
  });

  it('空行は、行として数えない', () => {
    expect(splitNdjsonLines('', '\n\n{"a":1}\n  \n')).toEqual({ lines: ['{"a":1}'], pending: '' });
  });

  it('日本語の文字を含む行も、そのまま返す', () => {
    expect(splitNdjsonLines('', '{"text":"ポンプの点検"}\n').lines).toEqual(['{"text":"ポンプの点検"}']);
  });
});

describe('parseChatStreamEvent', () => {
  const reference = { document_title: 'ポンプ', document_id: 'd1', similarity: 0.71, content: '本文', has_pdf: true };

  it('参照マニュアル・回答の断片・完了・エラーを、それぞれ解釈する', () => {
    expect(parseChatStreamEvent(JSON.stringify({ type: 'manual_references', manual_references: [reference] }))).toEqual({ type: 'manual_references', manual_references: [reference] });
    expect(parseChatStreamEvent('{"type":"manual_references","manual_references":null}')).toEqual({ type: 'manual_references', manual_references: null });
    expect(parseChatStreamEvent('{"type":"delta","text":"こんにちは"}')).toEqual({ type: 'delta', text: 'こんにちは' });
    expect(parseChatStreamEvent('{"type":"done","message_id":"m1","created_at":"2026-10-08T00:00:00Z"}')).toEqual({ type: 'done', message_id: 'm1', created_at: '2026-10-08T00:00:00Z' });
    expect(parseChatStreamEvent('{"type":"error","detail":"Ollamaに接続できません"}')).toEqual({ type: 'error', detail: 'Ollamaに接続できません' });
  });

  it('空の断片(text が空文字)も、断片として受け取る', () => {
    expect(parseChatStreamEvent('{"type":"delta","text":""}')).toEqual({ type: 'delta', text: '' });
  });

  it.each([
    ['JSONでない行', 'これはJSONではない', 'JSONではありません'],
    ['配列', '[1,2]', '不明なイベントです'],
    ['null', 'null', 'イベントではありません'],
    ['不明なtype', '{"type":"unknown"}', '不明なイベントです'],
    ['typeが無い', '{"text":"x"}', '不明なイベントです'],
    ['textが文字列でない断片', '{"type":"delta","text":1}', '回答の断片に text がありません'],
    ['message_idが無い完了', '{"type":"done","created_at":"x"}', 'message_id・created_at がありません'],
    ['detailが無いエラー', '{"type":"error"}', 'detail がありません'],
    ['参照が配列でない', '{"type":"manual_references","manual_references":"x"}', '参照マニュアルの形式が違います'],
    ['参照の項目が足りない', '{"type":"manual_references","manual_references":[{"document_title":"a"}]}', '参照マニュアルの形式が違います'],
  ])('%s は、握りつぶさずに、理由つきのエラーにする', (_name, line, reason) => {
    expect(() => parseChatStreamEvent(line)).toThrow(ChatStreamFormatError);
    expect(() => parseChatStreamEvent(line)).toThrow(reason);
  });

  it('エラーの文言には、長すぎる行を切り詰めて含める', () => {
    const line = `x${'あ'.repeat(200)}`;

    try {
      parseChatStreamEvent(line);
      expect.unreachable();
    } catch (cause) {
      expect((cause as Error).message).toContain('…');
      expect((cause as Error).message.length).toBeLessThan(150);
    }
  });
});
