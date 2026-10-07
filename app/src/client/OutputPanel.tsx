import React, { useMemo, useState } from 'react';
import { checkDirectoryPickerSupport } from './browserSupport';
import { downloadBlob } from './download';
import { validateBaseName } from './filename';
import {
  chosenFiles,
  fileNameOf,
  folderOutputLabel,
  NO_SELECTION_HINT,
  selectedExtensions,
  usesBaseName,
  type OutputFile,
} from './outputMode';
import { ensureReadWrite, writeOutputs, type OutputReport } from './writeOutputs';

interface OutputPanelProps {
  // 保存できるファイルの一覧(文書の種類によって異なる)
  files: readonly OutputFile[];
  // 出力ファイル名(拡張子なし)の初期値
  defaultBaseName: string;
  // 現在の内容からPDFを生成する。失敗した場合は、利用者に見せられるメッセージつきで例外にする
  generatePdf: () => Promise<Blob>;
  // 文書が空の場合 true(出力できない)
  empty: boolean;
}

interface Status {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

// 保存するファイルの、名前と内容。PDFの内容はBlob、それ以外は文字列と種類(MIME)
interface Entry {
  readonly name: string;
  readonly data: string | Blob;
  readonly mimeType: string;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// 2つ目以降のダウンロードを、1つ目の開始の直後に発行すると、ブラウザに無視されることがあるため少し間を置く
const NEXT_DOWNLOAD_DELAY_MS = 400;
// ダウンロードは、サブフォルダを作れない。「css/style.css」は「style.css」にする
const downloadNameOf = (name: string): string => name.slice(name.lastIndexOf('/') + 1);

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function describeReport(report: OutputReport, folderName: string): Status {
  if (report.cancelled) {
    return { kind: 'info', text: '上書きが承認されなかったため、出力を中止しました。ファイルは変更していません。' };
  }
  if (report.failed.length === 0) {
    return { kind: 'success', text: `「${folderName}」へ出力しました: ${report.written.join('、')}` };
  }
  const failures = report.failed.map((failure) => `${failure.name} (${failure.message})`).join(' / ');
  const written = report.written.length > 0 ? `出力できたファイル: ${report.written.join('、')}。` : '出力できたファイルはありません。';
  return { kind: 'error', text: `一部またはすべての出力に失敗しました。${written} 失敗: ${failures}` };
}

/** 保存するファイルの選択、出力先フォルダの選択、ファイルの出力 */
const OutputPanel: React.FC<OutputPanelProps> = ({ files, defaultBaseName, generatePdf, empty }) => {
  const directorySupport = useMemo(() => checkDirectoryPickerSupport(window), []);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(files.map((file) => file.id)));
  const [baseName, setBaseName] = useState(defaultBaseName);
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const chosen = chosenFiles(files, selected);
  const anySelected = chosen.length > 0;
  const needsPdf = chosen.some((file) => file.content.type === 'pdf');
  const needsName = usesBaseName(chosen);
  const nameCheck = validateBaseName(baseName);
  const nameUsable = !needsName || nameCheck.ok;
  const fixedNames = chosen.flatMap((file) => (file.fixedName === undefined ? [] : [file.fixedName]));

  const chooseDirectory = async (): Promise<void> => {
    try {
      // 前回選んだフォルダをブラウザが覚えているため、idを固定する
      const handle = await window.showDirectoryPicker({ id: 'md-pdf-editor', mode: 'readwrite' });
      setDirectory(handle);
      setStatus(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        return; // 利用者が選択を取り消した
      }
      setStatus({
        kind: 'error',
        text: `フォルダを選択できませんでした: ${messageOf(cause)} (システムフォルダなどは選べません。別のフォルダ、または新しく作ったフォルダを選んでください)`,
      });
    }
  };

  // 選ばれたファイルの内容をそろえる。PDFは、ここで生成する
  const collectEntries = async (): Promise<Entry[]> => {
    const pdf = needsPdf ? await generatePdf() : null;
    return chosen.map((file) => {
      const name = fileNameOf(file, baseName);
      if (file.content.type === 'pdf') {
        return { name, data: pdf as Blob, mimeType: 'application/pdf' };
      }
      return { name, data: file.content.text, mimeType: file.content.mimeType };
    });
  };

  // 選んだフォルダへ、チェックされたファイルを書き込む
  const outputToFolder = async (): Promise<void> => {
    if (directory === null || !nameUsable) {
      return;
    }
    setBusy(true);
    setStatus(needsPdf ? { kind: 'info', text: 'PDFを生成しています…' } : null);
    try {
      // 書き込み権限の再確認はクリック直後(ユーザー操作の有効期間内)に行う。PDF生成には数秒かかるため、その前に済ませる
      await ensureReadWrite(directory);
      const report = await writeOutputs({
        directory,
        files: await collectEntries(),
        confirmOverwrite: (names) => window.confirm(`次のファイルは既に存在します。上書きしますか?\n\n${names.join('\n')}`),
      });
      setStatus(describeReport(report, directory.name));
    } catch (cause) {
      setStatus({ kind: 'error', text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  // フォルダを選べない場合(システムフォルダの制限・非対応ブラウザなど)のための保存方法。保存先はブラウザの設定に従う
  const download = async (): Promise<void> => {
    if (!nameUsable) {
      return;
    }
    setBusy(true);
    setStatus({ kind: 'info', text: needsPdf ? 'PDFを生成しています…' : 'ダウンロードしています…' });
    try {
      const entries = await collectEntries();
      for (const [index, entry] of entries.entries()) {
        if (index > 0) {
          await delay(NEXT_DOWNLOAD_DELAY_MS);
        }
        const blob = entry.data instanceof Blob ? entry.data : new Blob([entry.data], { type: `${entry.mimeType};charset=utf-8` });
        downloadBlob(blob, downloadNameOf(entry.name));
      }
      const names = entries.map((entry) => downloadNameOf(entry.name));
      const flattened = entries.some((entry) => entry.name.includes('/'));
      setStatus({
        kind: 'success',
        text:
          `ダウンロードを開始しました: ${names.join('、')} (保存先はブラウザのダウンロード設定に従います${names.length > 1 ? '。複数ファイルのダウンロードを確認された場合は、許可してください' : ''})` +
          (flattened ? ' ダウンロードでは、サブフォルダを作れないため、CSSはファイル名だけで保存されます。HTMLが指している位置(例: css/style.css)に保存するには、「出力先フォルダを選択」を使ってください。' : ''),
      });
    } catch (cause) {
      setStatus({ kind: 'error', text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  // ポップアップとして拒否されないよう、新しいタブはクリック直後に開き、PDFができてから表示を切り替える
  const previewPdf = async (): Promise<void> => {
    const tab = window.open('about:blank', '_blank');
    if (tab === null) {
      setStatus({ kind: 'error', text: 'ポップアップがブロックされました。このページのポップアップを許可してください。' });
      return;
    }
    tab.document.title = 'PDFを生成しています…';
    tab.document.body.textContent = 'PDFを生成しています…';
    setBusy(true);
    setStatus({ kind: 'info', text: 'PDFを生成しています…' });
    try {
      const url = URL.createObjectURL(await generatePdf());
      tab.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
      setStatus(null);
    } catch (cause) {
      tab.close();
      setStatus({ kind: 'error', text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setSelected((current) => {
      const next = new Set(current);
      if (event.target.checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });

  return (
    <section className="output-panel" aria-label="出力">
      <h2>出力</h2>

      <fieldset className="field file-select">
        <legend>保存するファイル</legend>
        {files.map((file) => (
          <label key={file.id}>
            <input type="checkbox" checked={selected.has(file.id)} onChange={toggle(file.id)} disabled={busy} /> {file.label}
          </label>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor="base-name">ファイル名(拡張子なし)</label>
        <input
          id="base-name"
          className="text-input"
          value={baseName}
          onChange={(event) => setBaseName(event.target.value)}
          disabled={!needsName || busy}
          aria-invalid={needsName && !nameCheck.ok}
          spellCheck={false}
        />
        <span className="field-suffix">{selectedExtensions(chosen)}</span>
        {needsName && !nameCheck.ok && <p className="field-error">{nameCheck.message}</p>}
        {!anySelected && <p className="field-hint">{NO_SELECTION_HINT}</p>}
        {fixedNames.length > 0 && (
          <p className="field-hint">
            CSSファイルは、HTMLから参照されている名前(例: {fixedNames[0]})のまま保存します。ファイル名の指定は、CSS以外のファイルに使います。
          </p>
        )}
      </div>

      <div className="field">
        <button
          type="button"
          className="button"
          disabled={!anySelected || !directorySupport.supported || busy}
          onClick={() => void chooseDirectory()}
        >
          出力先フォルダを選択
        </button>
        <span className="field-value">{directory === null ? '(未選択)' : directory.name}</span>
        {anySelected &&
          (directorySupport.supported ? (
            <p className="field-hint">
              「ドキュメント」「ダウンロード」「デスクトップ」などのフォルダそのものは、ブラウザの制限で選べません。
              その中に新しいフォルダを作って選ぶか、下の「ダウンロードで保存」を使ってください。
            </p>
          ) : (
            <p className="field-error">{directorySupport.reason} 代わりに、下の「ダウンロードで保存」を使えます。</p>
          ))}
      </div>

      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!anySelected || !directorySupport.supported || directory === null || !nameUsable || empty || busy}
          onClick={() => void outputToFolder()}
        >
          {anySelected ? folderOutputLabel(chosen) : '選んだフォルダへ出力'}
        </button>
        <button
          type="button"
          className="button"
          disabled={!anySelected || !nameUsable || empty || busy}
          onClick={() => void download()}
        >
          ダウンロードで保存
        </button>
        <button type="button" className="button" disabled={empty || busy} onClick={() => void previewPdf()}>
          PDFを生成して確認(新しいタブ)
        </button>
      </div>

      {status !== null && (
        <p role={status.kind === 'error' ? 'alert' : 'status'} className={`notice notice-${status.kind}`}>
          {status.text}
        </p>
      )}
    </section>
  );
};

export default OutputPanel;
