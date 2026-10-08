/*
 * ④ AIチャットの、画面に依存しない規則(入力の判定・表示の整形・回答の組み立て)。
 * 画面に出す文言は、利用者がそのまま読める日本語にする。
 */
import type { ChatMessage, ChatSession, ManualReference } from '../../ragApi';
import { shouldSubmitOnEnter, type EnterKeyEvent } from '../rag/ragRules';

// 参照マニュアルの抜粋は、これを超える長さなら、先頭だけを見せて「続きを読む」で全文を開く
export const EXCERPT_PREVIEW_CHARS = 100;

// メッセージ一覧が、最下部からこの距離(px)以内にあるあいだは、新しい断片に合わせて自動で追従する
export const AUTO_SCROLL_THRESHOLD_PX = 40;

export const STOPPED_NOTE = '（回答の生成を停止しました）';

export const INTERRUPTED_MESSAGE = '回答が途中で終了しました。もう一度質問してください。';

export interface ChatEnterKeyEvent extends EnterKeyEvent {
  readonly shiftKey: boolean;
}

/** Enterキーで、質問を送信してよいか。Shift+Enterは改行、日本語入力の変換を確定するEnterは送信しない */
export const shouldSendOnEnter = (event: ChatEnterKeyEvent): boolean => !event.shiftKey && shouldSubmitOnEnter(event);

/** メッセージ一覧が、最下部の近くにあるか(あれば、新しい断片に合わせて追従してよい) */
export const isNearBottom = (metrics: { readonly scrollHeight: number; readonly scrollTop: number; readonly clientHeight: number }): boolean =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < AUTO_SCROLL_THRESHOLD_PX;

/** 履歴に出す会話の名前(最初の質問の先頭)。質問がまだ無い会話には、仮の名前を付ける */
export const sessionTitle = (session: Pick<ChatSession, 'title'>): string => (session.title === null || session.title.trim() === '' ? '(無題のチャット)' : session.title);

/** 会話が絞り込んでいるタグ名の表示(絞り込まなければ「絞り込みなし」) */
export const describeSessionEquipment = (equipmentName: string | null): string => equipmentName ?? '絞り込みなし';

/** 履歴に出す、会話を始めた日(ブラウザの時間帯)。読み取れない日時は、そのまま表示する */
export function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('ja-JP');
}

export interface ExcerptPreview {
  readonly text: string;
  // 先頭だけに切り詰めたか(切り詰めたものは、Markdownの途中で切れうるため、書式なしの文字として表示する)
  readonly truncated: boolean;
}

/** 参照マニュアルの抜粋の、折りたたんだときの表示。サロゲートペア(絵文字など)を、途中で切らない */
export function excerptPreview(content: string): ExcerptPreview {
  const characters = Array.from(content);
  if (characters.length <= EXCERPT_PREVIEW_CHARS) {
    return { text: content, truncated: false };
  }
  return { text: `${characters.slice(0, EXCERPT_PREVIEW_CHARS).join('')}…`, truncated: true };
}

// ---- 回答の組み立て(ストリームで届く内容を、メッセージ一覧に反映する) ----

const mapMessage = (messages: readonly ChatMessage[], id: string, change: (message: ChatMessage) => ChatMessage): ChatMessage[] =>
  messages.map((message) => (message.message_id === id ? change(message) : message));

/** 送信した質問と、回答を書き込んでいく空の吹き出しを、一覧の末尾に足す */
export function withPendingTurn(messages: readonly ChatMessage[], turn: { readonly userId: string; readonly assistantId: string; readonly question: string; readonly now: string }): ChatMessage[] {
  return [
    ...messages,
    { message_id: turn.userId, role: 'user', content: turn.question, manual_references: null, created_at: turn.now },
    { message_id: turn.assistantId, role: 'assistant', content: '', manual_references: null, created_at: turn.now },
  ];
}

/** 届いた回答の断片を、吹き出しの末尾に足す */
export const appendDelta = (messages: readonly ChatMessage[], assistantId: string, text: string): ChatMessage[] => mapMessage(messages, assistantId, (message) => ({ ...message, content: message.content + text }));

/** 回答の完了(done)を反映する。サーバーが付けたIDと時刻に差し替え、保持しておいた参照マニュアルをここで初めて付ける */
export const completeAnswer = (messages: readonly ChatMessage[], assistantId: string, done: { readonly message_id: string; readonly created_at: string }, references: readonly ManualReference[] | null): ChatMessage[] =>
  mapMessage(messages, assistantId, (message) => ({ ...message, message_id: done.message_id, created_at: done.created_at, manual_references: references }));

/** 利用者が生成を止めたとき、それまでの断片の末尾に、停止したことを足す(サーバーは、この回答を保存しない) */
export const markStopped = (messages: readonly ChatMessage[], assistantId: string): ChatMessage[] =>
  mapMessage(messages, assistantId, (message) => ({ ...message, content: message.content === '' ? STOPPED_NOTE : `${message.content}\n\n${STOPPED_NOTE}` }));

/** 回答が1文字も届かないまま失敗したとき、空の吹き出しを取り除く(質問は残す) */
export const dropEmptyAnswer = (messages: readonly ChatMessage[], assistantId: string): ChatMessage[] => messages.filter((message) => !(message.message_id === assistantId && message.content === ''));
