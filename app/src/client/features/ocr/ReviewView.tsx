import React, { useEffect, useMemo, useRef, useState } from 'react';
import { downloadBlob } from '../../download';
import { ocrDraftPdfUrl, updateOcrDraft, type DiffSegment, type OcrDraft } from '../../ragApi';
import { findBrokenTables } from '../../tableCheck';
import type { MarkdownHandoff, RagHandoff } from '../handoff';
import { findSegmentRange } from './draftLocator';
import { markdownFileNameOf } from './ocrLogic';
import OcrMarkdownEditor from './OcrMarkdownEditor';

type EditorMode = 'rich' | 'source';

const EDITOR_MODE_LABEL: Readonly<Record<EditorMode, string>> = {
  rich: '書式付き',
  source: 'Markdown構文',
};

// 表として解釈できない箇所の警告に列挙する件数の上限(超過分は件数だけ示す)
const MAX_LISTED_BROKEN_TABLES = 5;

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface SegmentItemProps {
  readonly segment: DiffSegment;
  // 原本PDFのURL(無ければ、PDFを開くリンクを出さない)
  readonly pdfUrl: string | null;
  readonly onLocate: (segment: DiffSegment) => void;
}

/** OCR結果の1箇所。主文候補・比較候補・採用テキスト・判定理由と、本文・原本PDFの該当箇所へ移るボタン */
const SegmentItem: React.FC<SegmentItemProps> = ({ segment, pdfUrl, onLocate }) => (
  <li className={`ocr-segment ocr-segment-${segment.status}`}>
    <div className="ocr-segment-header">
      <span className="ocr-segment-page">p.{segment.page}</span>
      <button type="button" className="button button-small" onClick={() => onLocate(segment)}>
        本文の該当箇所へ
      </button>
      {pdfUrl !== null && (
        <a className="button button-small ocr-pdf-link" href={`${pdfUrl}#page=${segment.page}`} target="_blank" rel="noopener noreferrer">
          PDFのp.{segment.page}を開く
        </a>
      )}
    </div>
    <dl className="ocr-segment-candidates">
      <dt>主文候補(vision LLM)</dt>
      <dd>{segment.glm_text || '(空)'}</dd>
      <dt>比較候補(GLM-OCR)</dt>
      <dd>{segment.glm_alt_text || '(空)'}</dd>
      <dt>採用テキスト</dt>
      <dd>{segment.final_text || '(空)'}</dd>
    </dl>
    {segment.reason !== null && segment.reason !== '' && <p className="ocr-segment-reason">判定理由: {segment.reason}</p>}
  </li>
);

interface ReviewViewProps {
  // OCRが完了した(DRAFT)下書き
  readonly draft: OcrDraft;
  readonly onBack: () => void;
  readonly onDiscard: () => void;
  readonly onSendToPdfEditor: (handoff: Omit<MarkdownHandoff, 'id'>) => void;
  readonly onSendToRag: (handoff: Omit<RagHandoff, 'id'>) => void;
}

/**
 * OCR結果の確認・修正の画面。「AIが確信を持てなかった箇所(要確認)」の一覧から、本文・原本PDFの
 * 該当箇所へ移って確認する。本文は直接編集でき、保存した内容を、MDファイル・①(PDF出力)・③(RAG登録)へ渡せる。
 */
const ReviewView: React.FC<ReviewViewProps> = ({ draft, onBack, onDiscard, onSendToPdfEditor, onSendToRag }) => {
  // 編集中の本文と、最後に保存した本文(違えば「未保存」)
  const [edited, setEdited] = useState(draft.draft_markdown);
  const [saved, setSaved] = useState(draft.draft_markdown);
  const [mode, setMode] = useState<EditorMode>('rich');
  // 書式付きエディタに渡す初期値。エディタの再マウント時にだけ現在の本文へ更新する(入力中に渡し直さない)
  const [editorSeed, setEditorSeed] = useState(draft.draft_markdown);
  const [editorKey, setEditorKey] = useState(0);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [locateMessage, setLocateMessage] = useState<string | null>(null);
  // 書式付きモード中に「本文の該当箇所へ」が押された場合、構文モードへ切り替えた後に位置合わせする
  const [pendingLocate, setPendingLocate] = useState<DiffSegment | null>(null);
  const [busy, setBusy] = useState<'saving' | 'sending' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = edited !== saved;
  const pdfUrl = draft.has_pdf ? ocrDraftPdfUrl(draft.id) : null;
  const markdownFileName = markdownFileNameOf(draft.source_file_name);

  const reviewSegments = useMemo(() => draft.diff_segments.filter((s) => s.status === 'needs_review').sort((a, b) => a.page - b.page), [draft.diff_segments]);
  const autoSegments = useMemo(() => draft.diff_segments.filter((s) => s.status === 'auto_corrected').sort((a, b) => a.page - b.page), [draft.diff_segments]);
  // OCRの表が表として解釈できない形だと、書式付きでもパイプ付きの生テキストで表示され、エラーにもならない。
  // 編集で直したら消えるよう、編集中の本文から毎回検出する
  const brokenTables = useMemo(() => findBrokenTables(edited), [edited]);

  // 未保存の修正があるまま、ページを離れる(再読み込み・タブを閉じる)ときに、確認する
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // 本文(textarea)中の該当箇所を選択状態にして、表示位置まで移動する
  const locateInTextarea = (segment: DiffSegment): void => {
    const range = findSegmentRange(edited, segment);
    const textarea = textareaRef.current;
    if (range === null || textarea === null) {
      setLocateMessage(`p.${segment.page}の該当箇所が本文中に見つかりませんでした(本文を編集した可能性があります)。`);
      return;
    }
    setLocateMessage(null);
    // blur→選択→focusの順にすると、ブラウザが選択位置までtextareaをスクロールしてくれる
    textarea.blur();
    textarea.setSelectionRange(range.start, range.end);
    textarea.focus();
  };

  const locate = (segment: DiffSegment): void => {
    if (mode === 'source') {
      locateInTextarea(segment);
      return;
    }
    setPendingLocate(segment);
    setEditorMessage(null);
    setMode('source');
  };

  // 構文モードへ切り替わってtextareaが描画された後に、保留していた位置合わせを実行する
  useEffect(() => {
    if (mode === 'source' && pendingLocate !== null) {
      locateInTextarea(pendingLocate);
      setPendingLocate(null);
    }
    // 実行条件は、モード切替と保留の有無だけ(locateInTextareaは毎回作り直される)
  }, [mode, pendingLocate]);

  const switchMode = (next: EditorMode): void => {
    if (next === mode) {
      return;
    }
    setEditorMessage(null);
    if (next === 'rich') {
      setEditorSeed(edited);
      setEditorKey((key) => key + 1);
    }
    setMode(next);
  };

  const handleParseError = (message: string): void => {
    setMode('source');
    setEditorMessage(`書式付き表示でこの本文を解釈できなかったため、Markdown構文モードに切り替えました(${message})`);
  };

  const handleChange = (markdown: string): void => {
    setEdited(markdown);
    setJustSaved(false);
  };

  // 指定の本文を保存する。成功したかを返す(失敗の理由は、画面に出す)
  const persist = async (markdown: string): Promise<boolean> => {
    setActionError(null);
    try {
      const updated = await updateOcrDraft(draft.id, markdown);
      setSaved(updated.draft_markdown);
      setJustSaved(true);
      return true;
    } catch (cause) {
      setActionError(`保存できませんでした: ${messageOf(cause)}`);
      return false;
    }
  };

  const handleSave = async (): Promise<void> => {
    setBusy('saving');
    await persist(edited);
    setBusy(null);
  };

  // 別の機能へ渡す。未保存の修正があれば、先に保存する(保存できなければ、渡さない)
  const handOver = async (send: (markdown: string) => void): Promise<void> => {
    const markdown = edited;
    setBusy('sending');
    const ok = markdown === saved || (await persist(markdown));
    setBusy(null);
    if (ok) {
      send(markdown);
    }
  };

  const handleDownload = (): void => {
    downloadBlob(new Blob([edited], { type: 'text/markdown;charset=utf-8' }), markdownFileName);
  };

  const handleBack = (): void => {
    if (dirty && !window.confirm('未保存の修正があります。保存せずに一覧へ戻りますか?')) {
      return;
    }
    onBack();
  };

  const saveStatus = dirty ? '未保存の修正があります' : justSaved ? '保存しました' : '保存済み';

  return (
    <main className="ocr-review">
      <header className="ocr-review-header">
        <div>
          <h1>OCR結果の確認・修正</h1>
          <p className="source-name">
            {draft.source_file_name}({draft.page_count}ページ)
          </p>
        </div>
        <button type="button" className="button" onClick={handleBack}>
          一覧へ戻る
        </button>
      </header>
      <p className="hint">
        AIが画像を読み取った結果です。誤読が残っていることがあるため、「確認が必要な箇所」を原本PDFと見比べて、本文を直してください。
        直したあと、「修正を保存」を押すと、結果を残せます。
      </p>

      <div className="ocr-review-body">
        <section className="ocr-review-side" aria-labelledby="ocr-segments-title">
          <h2 id="ocr-segments-title">確認が必要な箇所</h2>
          {reviewSegments.length === 0 ? (
            <p className="notice notice-success">AIが確信を持てなかった箇所は、ありませんでした。</p>
          ) : (
            <details open className="ocr-segments">
              <summary>要確認: {reviewSegments.length}件</summary>
              <p className="hint">画像を見ても判定できなかった箇所です。ボタンで、本文の該当箇所や、PDFのページへ移れます。</p>
              <ul className="ocr-segment-list">
                {reviewSegments.map((segment) => (
                  <SegmentItem key={`${segment.page}-${segment.segment_id}`} segment={segment} pdfUrl={pdfUrl} onLocate={locate} />
                ))}
              </ul>
            </details>
          )}
          {locateMessage !== null && (
            <p role="alert" className="notice notice-warning">
              {locateMessage}
            </p>
          )}
          {autoSegments.length > 0 && (
            <details className="ocr-segments">
              <summary>自動修正された箇所: {autoSegments.length}件(クリックで表示)</summary>
              <p className="hint">2つのOCRの結果が食い違い、AIが画像を見て、自動で直した箇所です。</p>
              <ul className="ocr-segment-list">
                {autoSegments.map((segment) => (
                  <SegmentItem key={`${segment.page}-${segment.segment_id}`} segment={segment} pdfUrl={pdfUrl} onLocate={locate} />
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="ocr-review-editor" aria-labelledby="ocr-editor-title">
          <div className="ocr-editor-header">
            <h2 id="ocr-editor-title">本文</h2>
            <div className="ocr-mode-toggle" role="group" aria-label="編集の方法">
              {(Object.keys(EDITOR_MODE_LABEL) as EditorMode[]).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`button button-small${mode === candidate ? ' button-primary' : ''}`}
                  aria-pressed={mode === candidate}
                  onClick={() => switchMode(candidate)}
                >
                  {EDITOR_MODE_LABEL[candidate]}
                </button>
              ))}
            </div>
          </div>
          {editorMessage !== null && (
            <p role="alert" className="notice notice-warning">
              {editorMessage}
            </p>
          )}
          {brokenTables.length > 0 && (
            <div role="alert" className="notice notice-warning">
              <p>
                表として解釈できない箇所が{brokenTables.length}件あります(画面では表にならず、「|」付きの文字のまま表示されます)。
                「Markdown構文」に切り替えて、見出し行と区切り行(| --- | --- |)の列数を揃えてください。
              </p>
              <ul>
                {brokenTables.slice(0, MAX_LISTED_BROKEN_TABLES).map((table) => (
                  <li key={table.line}>
                    {table.line}行目: {table.excerpt}
                  </li>
                ))}
                {brokenTables.length > MAX_LISTED_BROKEN_TABLES && <li>ほか{brokenTables.length - MAX_LISTED_BROKEN_TABLES}件</li>}
              </ul>
            </div>
          )}
          {mode === 'rich' ? (
            <OcrMarkdownEditor key={editorKey} initialMarkdown={editorSeed} onChange={handleChange} onParseError={handleParseError} />
          ) : (
            <textarea
              ref={textareaRef}
              className="source-area ocr-source-area"
              aria-label="Markdown本文"
              value={edited}
              spellCheck={false}
              onChange={(event) => handleChange(event.target.value)}
            />
          )}
        </section>
      </div>

      <section className="output-panel" aria-labelledby="ocr-actions-title">
        <h2 id="ocr-actions-title">保存と出力</h2>
        <p className={`ocr-save-status${dirty ? ' ocr-save-dirty' : ''}`} role="status">
          {saveStatus}
        </p>
        {actionError !== null && (
          <p role="alert" className="notice notice-error">
            {actionError}
          </p>
        )}
        <div className="actions">
          <button type="button" className="button button-primary" disabled={!dirty || busy !== null} onClick={() => void handleSave()}>
            {busy === 'saving' ? '保存しています…' : '修正を保存'}
          </button>
          <button type="button" className="button" disabled={busy !== null} onClick={handleDownload}>
            Markdownを保存(.md)
          </button>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => void handOver((markdown) => onSendToPdfEditor({ fileName: markdownFileName, markdown }))}
          >
            ① PDFにして出力へ
          </button>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() =>
              void handOver((markdown) =>
                onSendToRag({
                  fileName: markdownFileName,
                  markdown,
                  pdf: draft.has_pdf ? { url: ocrDraftPdfUrl(draft.id), fileName: draft.source_file_name } : null,
                }),
              )
            }
          >
            ③ RAGに登録へ
          </button>
          <button type="button" className="button" disabled={busy !== null} onClick={onDiscard}>
            この下書きを破棄
          </button>
        </div>
      </section>
    </main>
  );
};

export default ReviewView;
