import React, { useEffect, useRef, useState } from 'react';
import { discardOcrDraft, getOcrDraft, RagApiError, type OcrDraft } from '../../ragApi';
import type { OcrFeatureProps } from '../handoff';
import FailedView from './FailedView';
import { isActiveStatus } from './ocrLogic';
import { startPolling } from './polling';
import ReviewView from './ReviewView';
import RunningView from './RunningView';

// OCRが実行中の間、状態(進捗)を取得する間隔
const DRAFT_POLL_INTERVAL_MS = 3000;

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface DraftScreenProps extends OcrFeatureProps {
  readonly id: string;
  // OCR・RAGサービスが使えないときの案内(画面の上部に出す)
  readonly banner: React.ReactNode;
  // 履歴(開始画面)へ戻る。下書きが無い・破棄したときは、案内の文言を渡す
  readonly onLeave: (message?: string) => void;
}

/**
 * 1つの下書きを開いている画面。下書きの状態に応じて、実行中・失敗・確認と修正のどれかを出す。
 * 実行中の間は、状態を見に行き続け、結果が出たら、確認と修正の画面に切り替わる。
 */
const DraftScreen: React.FC<DraftScreenProps> = ({ id, banner, onLeave, onSendToPdfEditor, onSendToRag }) => {
  const [draft, setDraft] = useState<OcrDraft | null>(null);
  // 状態を取得できなかった理由(再試行している間、表示する)
  const [problem, setProblem] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 取得の処理は、id が変わったときだけ作り直すため、最新の戻り先は、refを通して使う
  const leave = useRef(onLeave);
  leave.current = onLeave;

  useEffect(
    () =>
      startPolling<OcrDraft>({
        intervalMs: DRAFT_POLL_INTERVAL_MS,
        fetch: (signal) => getOcrDraft(id, signal),
        onValue: (fetched) => {
          if (fetched.status === 'DISCARDED') {
            leave.current('この下書きは、破棄されています。');
            return 'stop';
          }
          setDraft(fetched);
          setProblem(null);
          return isActiveStatus(fetched.status) ? 'continue' : 'stop';
        },
        onError: (cause) => {
          if (cause instanceof RagApiError && cause.status === 404) {
            leave.current('下書きが見つかりませんでした(削除された可能性があります)。');
            return 'stop';
          }
          setProblem(messageOf(cause));
          return 'continue';
        },
      }),
    [id],
  );

  const discard = async (): Promise<void> => {
    if (draft === null) {
      return;
    }
    const message = isActiveStatus(draft.status)
      ? 'OCRを中止して、この下書きを破棄します。現在のページの処理が終わった時点で中止されます。よろしいですか?'
      : 'この下書き(OCR結果と、修正した内容)を破棄します。元に戻せません。よろしいですか?';
    if (!window.confirm(message)) {
      return;
    }
    setActionError(null);
    try {
      await discardOcrDraft(id);
      leave.current('下書きを破棄しました。');
    } catch (cause) {
      setActionError(`破棄できませんでした: ${messageOf(cause)}`);
    }
  };

  const back = (): void => onLeave();

  return (
    <div className={`app${draft?.status === 'DRAFT' ? ' app-wide' : ''} ocr-draft-screen`}>
      {banner}
      {actionError !== null && (
        <p role="alert" className="notice notice-error">
          {actionError}
        </p>
      )}
      {draft === null ? (
        <main>
          <p role="status" className="hint">
            {problem === null ? '下書きを読み込んでいます…' : `下書きを取得できません(再試行しています): ${problem}`}
          </p>
          <div className="actions">
            <button type="button" className="button" onClick={back}>
              一覧へ戻る
            </button>
          </div>
        </main>
      ) : draft.status === 'DRAFT' ? (
        <ReviewView
          key={draft.id}
          draft={draft}
          onBack={back}
          onDiscard={() => void discard()}
          onSendToPdfEditor={onSendToPdfEditor}
          onSendToRag={onSendToRag}
        />
      ) : draft.status === 'FAILED' ? (
        <FailedView draft={draft} onBack={back} onDiscard={() => void discard()} />
      ) : (
        <RunningView draft={draft} problem={problem} onBack={back} onDiscard={() => void discard()} />
      )}
    </div>
  );
};

export default DraftScreen;
