/*
 * チャットの回答ストリーム(改行区切りのJSON、1行が1イベント)を読む、画面に依存しない規則。
 * ネットワークからは、行の途中で区切られた断片が届く。行の組み立てと、イベントの検証を、ここで行う。
 */
import type { ChatStreamEvent, ManualReference } from './ragApi.js';

/** ストリームの内容が、取り決めと違うとき。画面に出せる文言を、messageに持つ */
export class ChatStreamFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStreamFormatError';
  }
}

export interface SplitLines {
  // 改行まで届いた、完成した行(空行は含めない)
  readonly lines: readonly string[];
  // 改行がまだ届いていない、行の途中まで。次の断片の先頭につなげる
  readonly pending: string;
}

/** それまでの未完成の行(pending)に、新しく届いた断片をつなげ、完成した行と、残りの未完成の行に分ける */
export function splitNdjsonLines(pending: string, chunk: string): SplitLines {
  const parts = (pending + chunk).split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim() !== ''), pending: rest };
}

const PREVIEW_LENGTH = 60;

function malformed(reason: string, line: string): ChatStreamFormatError {
  const shown = line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line;
  return new ChatStreamFormatError(`サーバーからの回答を解釈できませんでした(${reason}): ${shown}`);
}

function isReference(value: unknown): value is ManualReference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  return (
    typeof reference['document_title'] === 'string' &&
    typeof reference['document_id'] === 'string' &&
    typeof reference['similarity'] === 'number' &&
    typeof reference['content'] === 'string' &&
    typeof reference['has_pdf'] === 'boolean'
  );
}

/** 1行を、チャットのイベントとして解釈する。JSONでない・取り決めと違う行は、握りつぶさずにエラーにする */
export function parseChatStreamEvent(line: string): ChatStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw malformed('JSONではありません', line);
  }
  if (typeof value !== 'object' || value === null) {
    throw malformed('イベントではありません', line);
  }
  const event = value as Record<string, unknown>;
  switch (event['type']) {
    case 'manual_references': {
      const references = event['manual_references'];
      if (references === null) {
        return { type: 'manual_references', manual_references: null };
      }
      if (!Array.isArray(references) || !references.every(isReference)) {
        throw malformed('参照マニュアルの形式が違います', line);
      }
      return { type: 'manual_references', manual_references: references };
    }
    case 'delta':
      if (typeof event['text'] !== 'string') {
        throw malformed('回答の断片に text がありません', line);
      }
      return { type: 'delta', text: event['text'] };
    case 'done':
      if (typeof event['message_id'] !== 'string' || typeof event['created_at'] !== 'string') {
        throw malformed('完了の通知に message_id・created_at がありません', line);
      }
      return { type: 'done', message_id: event['message_id'], created_at: event['created_at'] };
    case 'error':
      if (typeof event['detail'] !== 'string') {
        throw malformed('エラーの通知に detail がありません', line);
      }
      return { type: 'error', detail: event['detail'] };
    default:
      throw malformed('不明なイベントです', line);
  }
}
