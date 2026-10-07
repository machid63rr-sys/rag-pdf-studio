import React, { useEffect, useRef, useState } from 'react';
import { decodeUtf8Strict } from '../../decodeUtf8';
import { registerDocument, type DocumentSummary } from '../../ragApi';
import type { RagHandoff } from '../handoff';
import EquipmentNameInput from './EquipmentNameInput';
import MarkdownContent from './MarkdownContent';
import {
  defaultRegistrationName, describeEquipmentNames, ensureMarkdownFileName, errorMessage, findExistingDocument, formatFileSize, MAX_UPLOAD_BYTES, validateMarkdownFile,
  validatePdfFile, validateRegistrationName, validateTitle,
} from './ragRules';

interface RegisterPanelProps {
  // OCR・RAGサービスが使えない間は、登録できない
  readonly unavailable: boolean;
  // 登録済みの文書(同じ登録名の確認に使う)と、その取得の失敗理由
  readonly documents: readonly DocumentSummary[];
  readonly documentsError: string | null;
  // 登録済みの機器名(入力の候補)
  readonly equipmentCandidates: readonly string[];
  // ② から渡された内容(無ければ null)。id が変わると、フォームに取り込む
  readonly incoming: RagHandoff | null;
  // 登録できたあとの、一覧の更新
  readonly onRegistered: () => void;
  // 「確認(一覧)で見る」
  readonly onShowBrowse: () => void;
}

interface AttachedPdf {
  readonly blob: Blob;
  readonly fileName: string;
}

type PdfFetch = { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string };

/**
 * 登録フォーム。Markdown(ファイル・貼り付け・②からの受け取り)を、機器名・原本PDFと一緒にRAGへ登録する。
 * 同じ登録名で登録し直すと、既存の文書が置き換わる(原本PDFは、新しく付けなければ引き継がれる)。
 */
const RegisterPanel: React.FC<RegisterPanelProps> = ({ unavailable, documents, documentsError, equipmentCandidates, incoming, onRegistered, onShowBrowse }) => {
  const [markdown, setMarkdown] = useState('');
  const [registrationName, setRegistrationName] = useState('');
  const [title, setTitle] = useState('');
  const [equipmentNames, setEquipmentNames] = useState<string[]>([]);
  const [pendingEquipment, setPendingEquipment] = useState('');
  const [pdf, setPdf] = useState<AttachedPdf | null>(null);
  const [pdfFetch, setPdfFetch] = useState<PdfFetch>({ kind: 'idle' });
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DocumentSummary | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const markdownInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  // 登録の二重送信を防ぐ(ボタンを無効にする前の、連続したクリックも止める)
  const submittingRef = useRef(false);
  // 最後に取り込んだ ② の受け渡し(同じものを、取り込み直さない)と、原本PDFの取得の世代
  const handledHandoff = useRef<number | null>(null);
  const pdfFetchGeneration = useRef(0);

  const normalizedName = ensureMarkdownFileName(registrationName);
  const existing = normalizedName === '' ? null : findExistingDocument(documents, normalizedName);
  const hasInput = markdown.trim() !== '' || registrationName.trim() !== '' || title.trim() !== '' || equipmentNames.length > 0 || pdf !== null;
  const disabled = unavailable || submitting;

  // 入力が変わったら、前回の登録結果の表示は消す
  const edited = (): void => {
    setResult(null);
    setFormError(null);
  };

  const loadMarkdownFile = async (file: File): Promise<void> => {
    setFileError(null);
    const problem = validateMarkdownFile(file);
    if (problem !== null) {
      setFileError(problem);
      return;
    }
    let text: string;
    try {
      text = decodeUtf8Strict(await file.arrayBuffer());
    } catch (cause) {
      setFileError(`${file.name}: ${errorMessage(cause)}`);
      return;
    }
    if (text.trim() === '') {
      setFileError(`${file.name}: 本文が空です。`);
      return;
    }
    if (markdown.trim() !== '' && !window.confirm('入力中のMarkdown本文を、選んだファイルの内容で置き換えますか?')) {
      return;
    }
    edited();
    setHandoffNotice(null);
    setMarkdown(text);
    setRegistrationName(defaultRegistrationName(file.name));
  };

  const attachPdf = (file: File): void => {
    setPdfError(null);
    const problem = validatePdfFile(file);
    if (problem !== null) {
      setPdfError(problem);
      return;
    }
    // 取得中の②の原本PDFより、いま選んだPDFを優先する
    pdfFetchGeneration.current += 1;
    setPdfFetch({ kind: 'idle' });
    edited();
    setPdf({ blob: file, fileName: file.name });
  };

  const removePdf = (): void => {
    pdfFetchGeneration.current += 1;
    setPdfFetch({ kind: 'idle' });
    setPdfError(null);
    edited();
    setPdf(null);
  };

  // ② から渡された内容を取り込む
  useEffect(() => {
    if (incoming === null || handledHandoff.current === incoming.id) {
      return;
    }
    handledHandoff.current = incoming.id;
    if (hasInput && !window.confirm('③ に入力中の内容があります。② のOCR結果で置き換えますか?')) {
      return;
    }
    setResult(null);
    setFormError(null);
    setFileError(null);
    setPdfError(null);
    setMarkdown(incoming.markdown);
    setRegistrationName(defaultRegistrationName(incoming.fileName));
    setTitle('');
    setEquipmentNames([]);
    setPendingEquipment('');
    setPdf(null);
    pdfFetchGeneration.current += 1;
    const generation = pdfFetchGeneration.current;
    if (incoming.pdf === null) {
      setPdfFetch({ kind: 'idle' });
      setHandoffNotice('② のOCR結果を取り込みました(原本PDFはありません)。');
      return;
    }
    setPdfFetch({ kind: 'loading' });
    setHandoffNotice('② のOCR結果を取り込みました。原本PDFを取得しています…');
    const { url, fileName } = incoming.pdf;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`サーバーがエラーを返しました(${response.status})`);
        }
        const blob = await response.blob();
        if (generation !== pdfFetchGeneration.current) {
          return;
        }
        const problem = validatePdfFile({ name: fileName, size: blob.size });
        if (problem !== null) {
          throw new Error(problem);
        }
        setPdf({ blob, fileName });
        setPdfFetch({ kind: 'idle' });
        setHandoffNotice('② のOCR結果を取り込みました(原本PDFつき)。');
      } catch (cause) {
        if (generation !== pdfFetchGeneration.current) {
          return;
        }
        setPdfFetch({ kind: 'failed', message: `原本PDFを取得できませんでした: ${errorMessage(cause)}。原本PDFなしで登録するか、PDFを選び直してください。` });
        setHandoffNotice('② のOCR結果を取り込みました(原本PDFは取得できませんでした)。');
      }
    })();
    // 受け渡しの id が変わったときだけ取り込む(入力の変化では、取り込み直さない)
  }, [incoming?.id]);

  const submit = async (): Promise<void> => {
    if (submittingRef.current) {
      return;
    }
    setResult(null);
    const name = ensureMarkdownFileName(registrationName);
    const problem =
      validateRegistrationName(name) ??
      (markdown.trim() === '' ? 'Markdown本文が空です。ファイルを読み込むか、本文を貼り付けてください。' : null) ??
      (new Blob([markdown]).size > MAX_UPLOAD_BYTES ? 'Markdown本文が大きすぎます(上限 100MB)。' : null) ??
      (pendingEquipment.trim() !== '' ? '入力中の機器名が追加されていません。「追加」を押すか、入力を消してください。' : null) ??
      validateTitle(title);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const registered = await registerDocument({
        markdown, fileName: name, title, equipmentNames, ...(pdf === null ? {} : { pdf: { blob: pdf.blob, fileName: pdf.fileName } }),
      });
      setResult(registered);
      setMarkdown('');
      setRegistrationName('');
      setTitle('');
      setEquipmentNames([]);
      setPendingEquipment('');
      setPdf(null);
      setPdfFetch({ kind: 'idle' });
      setHandoffNotice(null);
      setFileError(null);
      setPdfError(null);
      onRegistered();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const loadingPdf = pdfFetch.kind === 'loading';

  return (
    <div className="rag-register">
      <p className="notice notice-info">OCRした結果は、② で確認・修正したものを登録してください。</p>

      {result !== null && (
        <section className="notice notice-success rag-success" role="status" aria-label="登録結果">
          <p>
            <strong>「{result.title}」を登録しました。</strong>
          </p>
          <ul className="rag-success-details">
            <li>登録名: {result.source_file_name}</li>
            <li>チャンク数: {result.chunk_count}</li>
            <li>機器名: {describeEquipmentNames(result.equipment_names)}</li>
            <li>原本PDF: {result.has_pdf ? 'あり' : 'なし'}</li>
          </ul>
          <button type="button" className="button" onClick={onShowBrowse}>
            確認(一覧)で見る
          </button>
        </section>
      )}

      {handoffNotice !== null && (
        <p className="notice notice-info rag-handoff-notice" role="status">
          {handoffNotice}
        </p>
      )}

      <section
        className={`drop-zone rag-drop${dragging ? ' drop-zone-active' : ''}`}
        aria-label="Markdownファイルの読み込み"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled) {
            return;
          }
          const files = [...event.dataTransfer.files];
          if (files.length > 1) {
            setFileError('ファイルは1つだけ指定してください。');
          } else if (files[0] !== undefined) {
            void loadMarkdownFile(files[0]);
          }
        }}
      >
        <p>Markdown(.md / .markdown / .txt)のファイルを、ここへドラッグ&ドロップ</p>
        <p className="drop-buttons">
          <button type="button" className="button button-primary" disabled={disabled} onClick={() => markdownInput.current?.click()}>
            Markdownファイルを選択
          </button>
        </p>
        <input
          ref={markdownInput}
          id="rag-markdown-file"
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          hidden
          aria-label="Markdownファイルを選択"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) {
              void loadMarkdownFile(file);
            }
          }}
        />
      </section>
      {fileError !== null && (
        <p role="alert" className="notice notice-error rag-file-error">
          {fileError}
        </p>
      )}

      <div className="rag-form">
        <div className="rag-field">
          <label htmlFor="rag-markdown">Markdown本文(ファイルを読み込むか、貼り付ける)</label>
          <textarea
            id="rag-markdown"
            className="source-area rag-markdown-input"
            value={markdown}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => {
              edited();
              setHandoffNotice(null);
              setMarkdown(event.target.value);
            }}
          />
        </div>

        <details
          className="rag-preview"
          onToggle={(event) => setPreviewOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>プレビュー(書式つきで確認する)</summary>
          {previewOpen && (markdown.trim() === '' ? <p className="hint">本文を入力すると、ここに表示されます。</p> : <MarkdownContent>{markdown}</MarkdownContent>)}
        </details>

        <div className="rag-field">
          <label htmlFor="rag-registration-name">登録名(ファイル名)</label>
          <input
            id="rag-registration-name"
            type="text"
            className="text-input rag-wide-input"
            value={registrationName}
            disabled={disabled}
            placeholder="例: R-1.md"
            onChange={(event) => {
              edited();
              setRegistrationName(event.target.value);
            }}
          />
          <p className="field-hint">
            拡張子(.md / .markdown / .txt)が無ければ .md を付けます。同じ登録名で登録し直すと、既存の文書が置き換わります。
            {normalizedName !== '' && normalizedName !== registrationName.trim() && <> 「{normalizedName}」として登録します。</>}
          </p>
          {existing !== null && (
            <p role="status" className="notice notice-warning rag-replace-warning">
              「{existing.source_file_name}」は既に登録されています。登録すると置き換わります(現在 {existing.chunk_count} チャンク)。原本PDFは、新しく付けなければ引き継がれます。
            </p>
          )}
          {existing === null && documentsError !== null && !unavailable && (
            <p className="field-hint">登録済みの一覧を取得できないため、同じ登録名があるかを確認できません: {documentsError}</p>
          )}
        </div>

        <div className="rag-field">
          <label htmlFor="rag-title">題名(任意)</label>
          <input
            id="rag-title"
            type="text"
            className="text-input rag-wide-input"
            value={title}
            disabled={disabled}
            placeholder="空の場合は、登録名(拡張子なし)になります"
            onChange={(event) => {
              edited();
              setTitle(event.target.value);
            }}
          />
        </div>

        <div className="rag-field">
          <label htmlFor="rag-equipment-input">機器名(複数可)</label>
          <EquipmentNameInput
            id="rag-equipment-input"
            names={equipmentNames}
            candidates={equipmentCandidates}
            pending={pendingEquipment}
            disabled={disabled}
            onNamesChange={(names) => {
              edited();
              setEquipmentNames(names);
            }}
            onPendingChange={setPendingEquipment}
          />
        </div>

        <div className="rag-field">
          <span className="rag-label">原本PDF(任意。検索結果から開けます)</span>
          <div className="rag-pdf-row">
            <button type="button" className="button" disabled={disabled} onClick={() => pdfInput.current?.click()}>
              PDFを選択
            </button>
            <input
              ref={pdfInput}
              id="rag-pdf-file"
              type="file"
              accept=".pdf,application/pdf"
              hidden
              aria-label="原本PDFを選択"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined) {
                  attachPdf(file);
                }
              }}
            />
            {loadingPdf && <span className="rag-pdf-status">② の原本PDFを取得しています…</span>}
            {pdf !== null && (
              <span className="rag-pdf-status">
                <strong>{pdf.fileName}</strong>({formatFileSize(pdf.blob.size)})
                <button type="button" className="button button-small" disabled={disabled} onClick={removePdf}>
                  外す
                </button>
              </span>
            )}
            {pdf === null && !loadingPdf && <span className="rag-pdf-status hint">未選択(既存の文書を置き換える場合は、既存の原本PDFが引き継がれます)</span>}
          </div>
          {pdfFetch.kind === 'failed' && (
            <p role="alert" className="notice notice-warning">
              {pdfFetch.message}
            </p>
          )}
          {pdfError !== null && (
            <p role="alert" className="field-error">
              {pdfError}
            </p>
          )}
        </div>

        {formError !== null && (
          <p role="alert" className="notice notice-error rag-form-error">
            {formError}
          </p>
        )}

        <div className="actions">
          <button id="rag-register-submit" type="button" className="button button-primary" disabled={disabled || loadingPdf} onClick={() => void submit()}>
            {submitting ? '登録中…' : '登録'}
          </button>
          {loadingPdf && <span className="hint">原本PDFの取得が終わるまで、登録できません。</span>}
        </div>
      </div>
    </div>
  );
};

export default RegisterPanel;
