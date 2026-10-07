import React, { useEffect, useRef, useState } from 'react';
import { discardOcrDraft, listOcrDrafts, startOcr, type OcrDraftSummary } from '../../ragApi';
import { formatDateTime, isActiveStatus, statusLabel, validatePdfFile } from './ocrLogic';
import { startPolling } from './polling';

// OCRが実行中の間、履歴を更新する間隔
const HISTORY_POLL_INTERVAL_MS = 5000;

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface StartScreenProps {
  // OCR・RAGサービスが使えないときの案内(画面の上部に出す)
  readonly banner: React.ReactNode;
  // false の間は、OCRを開始できない(サービスが使えない)
  readonly canStart: boolean;
  // 履歴へ戻ったときの案内(下書きが見つからなかった、など)
  readonly notice: string | null;
  // 下書き(実行中・完了・失敗)を開く
  readonly onOpen: (id: string) => void;
}

/** 開始・履歴の画面。PDFを選んでOCRを始める。過去のOCR(実行中・確認待ち・失敗)の一覧から、続きを開ける */
const StartScreen: React.FC<StartScreenProps> = ({ banner, canStart, notice, onOpen }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [history, setHistory] = useState<readonly OcrDraftSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRound, setHistoryRound] = useState(0);
  const [discardError, setDiscardError] = useState<string | null>(null);

  // 履歴。OCRが実行中・待機中のものがある間は、更新し続ける
  useEffect(
    () =>
      startPolling<OcrDraftSummary[]>({
        intervalMs: HISTORY_POLL_INTERVAL_MS,
        fetch: (signal) => listOcrDrafts(signal),
        onValue: (rows) => {
          setHistory(rows);
          setHistoryError(null);
          return rows.some((row) => isActiveStatus(row.status)) ? 'continue' : 'stop';
        },
        onError: (cause) => {
          setHistoryError(messageOf(cause));
          return 'continue';
        },
      }),
    [historyRound],
  );

  const chooseFile = (candidate: File | null): void => {
    setStartError(null);
    if (candidate === null) {
      setFile(null);
      setFileError(null);
      return;
    }
    const check = validatePdfFile(candidate);
    if (check.ok) {
      setFile(candidate);
      setFileError(null);
    } else {
      setFile(null);
      setFileError(check.message);
    }
  };

  const start = async (): Promise<void> => {
    if (file === null || starting) {
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const draft = await startOcr(file, password);
      onOpen(draft.id);
    } catch (cause) {
      setStartError(messageOf(cause));
      setStarting(false);
    }
  };

  const discard = async (row: OcrDraftSummary): Promise<void> => {
    const message = isActiveStatus(row.status)
      ? `「${row.source_file_name}」のOCRを中止して、破棄します。現在のページの処理が終わった時点で中止されます。よろしいですか?`
      : `「${row.source_file_name}」のOCR結果を破棄します。元に戻せません。よろしいですか?`;
    if (!window.confirm(message)) {
      return;
    }
    setDiscardError(null);
    try {
      await discardOcrDraft(row.id);
      setHistoryRound((round) => round + 1);
    } catch (cause) {
      setDiscardError(`破棄できませんでした: ${messageOf(cause)}`);
    }
  };

  return (
    <div className="app ocr-start">
      {banner}
      <header className="app-header">
        <h1>PDF → OCR → Markdown</h1>
      </header>
      {notice !== null && (
        <p role="status" className="notice notice-info">
          {notice}
        </p>
      )}

      <main className="ocr-start-main">
        <section
          className={`drop-zone${dragging ? ' drop-zone-active' : ''}`}
          aria-label="OCRするPDFの選択"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = [...event.dataTransfer.files];
            if (dropped.length > 1) {
              setFile(null);
              setFileError('一度にOCRできるPDFは1つです。1つだけ選んでください。');
            } else {
              chooseFile(dropped[0] ?? null);
            }
          }}
        >
          <p>OCRするPDFファイルを、ここへドラッグ&ドロップ</p>
          <p className="drop-note">
            AI(vision LLM)が画像を読み取り、別のOCR(GLM-OCR)と結果が食い違った箇所は、画像を見て自動で判定します。
            1ページ数分かかります。OCRはバックグラウンドで実行されるため、途中で画面を閉じても続きます。
          </p>
          <p className="drop-buttons">
            <button type="button" className="button button-primary" onClick={() => fileInput.current?.click()}>
              PDFを選択
            </button>
          </p>
          <input
            ref={fileInput}
            id="ocr-file-input"
            type="file"
            accept="application/pdf,.pdf"
            aria-label="OCRするPDFファイル"
            hidden
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null;
              event.target.value = '';
              chooseFile(picked);
            }}
          />
          {file !== null && (
            <p className="ocr-selected-file">
              選択中: <strong>{file.name}</strong>({(file.size / (1024 * 1024)).toFixed(1)}MB)
            </p>
          )}
        </section>
        {fileError !== null && (
          <p role="alert" className="notice notice-error">
            {fileError}
          </p>
        )}

        <div className="field">
          <label htmlFor="ocr-password">パスワード(暗号化PDFの場合のみ)</label>
          <input
            id="ocr-password"
            type="password"
            className="text-input"
            autoComplete="off"
            value={password}
            placeholder="暗号化されていなければ、空欄のまま"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="actions">
          <button type="button" className="button button-primary" disabled={file === null || !canStart || starting} onClick={() => void start()}>
            {starting ? '送信しています…' : 'OCRを開始'}
          </button>
        </div>
        {!canStart && <p className="hint">OCR・RAGサービスが使えないため、OCRを開始できません(上の案内を確認してください)。</p>}
        {startError !== null && (
          <p role="alert" className="notice notice-error">
            {startError}
          </p>
        )}

        <section aria-labelledby="ocr-history-title" className="ocr-history">
          <div className="ocr-history-header">
            <h2 id="ocr-history-title">OCR履歴</h2>
            <button type="button" className="button button-small" onClick={() => setHistoryRound((round) => round + 1)}>
              更新
            </button>
          </div>
          {historyError !== null && (
            <p role="alert" className="notice notice-warning">
              履歴を取得できません(再試行しています): {historyError}
            </p>
          )}
          {discardError !== null && (
            <p role="alert" className="notice notice-error">
              {discardError}
            </p>
          )}
          {history === null ? (
            historyError === null && <p className="hint">読み込んでいます…</p>
          ) : history.length === 0 ? (
            <p className="hint">OCRの履歴はありません。</p>
          ) : (
            <ul className="ocr-history-list">
              {history.map((row) => (
                <li key={row.id} className="ocr-history-item">
                  <div className="ocr-history-main">
                    <span className="ocr-history-name">{row.source_file_name}</span>
                    <span className={`ocr-status-chip ocr-status-${row.status.toLowerCase()}`}>{statusLabel(row)}</span>
                    <span className="ocr-history-time">{formatDateTime(row.created_at)}</span>
                    {row.status === 'FAILED' && row.error_message !== null && <span className="ocr-history-error">{row.error_message}</span>}
                  </div>
                  <div className="ocr-history-actions">
                    <button type="button" className="button button-small" onClick={() => onOpen(row.id)}>
                      開く
                    </button>
                    <button type="button" className="button button-small" onClick={() => void discard(row)}>
                      破棄
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
};

export default StartScreen;
