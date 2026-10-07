import React from 'react';
import type { OcrDraft } from '../../ragApi';

interface FailedViewProps {
  readonly draft: OcrDraft;
  readonly onBack: () => void;
  readonly onDiscard: () => void;
}

/** OCRが失敗した画面。失敗の理由を示す(やり直しは、PDFを選び直して新しくOCRする) */
const FailedView: React.FC<FailedViewProps> = ({ draft, onBack, onDiscard }) => (
  <main className="ocr-failed">
    <h1>OCRに失敗しました</h1>
    <p className="source-name">{draft.source_file_name}</p>
    <p role="alert" className="notice notice-error">
      {draft.error_message ?? '失敗の理由は記録されていません。'}
    </p>
    <p className="hint">PDFを選び直して、もう一度OCRしてください。</p>
    <div className="actions">
      <button type="button" className="button" onClick={onBack}>
        一覧へ戻る
      </button>
      <button type="button" className="button" onClick={onDiscard}>
        この下書きを破棄
      </button>
    </div>
  </main>
);

export default FailedView;
