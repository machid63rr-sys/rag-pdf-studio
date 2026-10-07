import React from 'react';
import type { OcrDraft } from '../../ragApi';
import { progressOf } from './ocrLogic';

interface RunningViewProps {
  readonly draft: OcrDraft;
  // 状態を取得できなかった理由(再試行している間、表示する)。取得できていれば null
  readonly problem: string | null;
  readonly onBack: () => void;
  readonly onDiscard: () => void;
}

/** OCRの実行中(待機中を含む)の画面。進捗を示す。画面を離れても、OCRは続く */
const RunningView: React.FC<RunningViewProps> = ({ draft, problem, onBack, onDiscard }) => {
  const progress = progressOf(draft);
  return (
    <main className="ocr-running">
      <h1>OCRを実行しています</h1>
      <p className="source-name">{draft.source_file_name}</p>

      <div className="ocr-progress">
        <div
          role="progressbar"
          aria-label="OCRの進捗"
          aria-valuemin={progress.known ? 0 : undefined}
          aria-valuemax={progress.known ? progress.total : undefined}
          aria-valuenow={progress.known ? progress.done : undefined}
          aria-valuetext={progress.label}
          className={`ocr-progress-bar${progress.known ? '' : ' ocr-progress-indeterminate'}`}
        >
          <div className="ocr-progress-fill" style={progress.known ? { width: `${progress.percent}%` } : undefined} />
        </div>
        <p className="ocr-progress-label">{progress.label}</p>
      </div>

      <p className="hint">
        1ページ数分かかります。この画面を閉じても、OCRは続きます(「OCR履歴」から、いつでも続きを開けます)。
        終わると、この画面が、確認・修正の画面に切り替わります。
      </p>
      {problem !== null && (
        <p role="alert" className="notice notice-warning">
          状態を取得できません(再試行しています): {problem}
        </p>
      )}

      <div className="actions">
        <button type="button" className="button" onClick={onBack}>
          一覧へ戻る
        </button>
        <button type="button" className="button" onClick={onDiscard}>
          中止して破棄
        </button>
      </div>
    </main>
  );
};

export default RunningView;
