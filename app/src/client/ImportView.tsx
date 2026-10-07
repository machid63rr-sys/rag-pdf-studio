import React, { useRef, useState } from 'react';
import { AssetStore, type BundleFile } from './assets';
import { draftName, type Draft } from './draft';
import type { ImportedDocument } from './documents';
import { importBundle } from './importFiles';
import { collectDropped, fromDirectoryInput, type EntryLike } from './readFolder';

interface ImportViewProps {
  onImport: (document: ImportedDocument) => void;
  // 自動保存してある、前回の下書き(無ければ null)と、それを再開する・捨てる操作
  draft: Draft | null;
  onResume: () => void;
  onDiscard: () => void;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

type PasteKind = 'markdown' | 'html';
const PASTE_LABEL: Readonly<Record<PasteKind, string>> = { markdown: 'Markdown', html: 'HTML' };

// 個別に選べるファイル。HTMLにはCSS・画像を、Markdownには画像を添えられる
const ACCEPT = '.md,.markdown,.mdown,.txt,.html,.htm,.css,.png,.jpg,.jpeg,.gif,.webp,.svg,text/markdown,text/plain,text/html,text/css,image/*';

// フォルダの中に文書が複数ある場合の、開くファイルの選択待ち
interface Choosing {
  readonly files: readonly BundleFile[];
  readonly candidates: readonly string[];
}

// 「フォルダを選択」のための属性。標準の型定義に無いため、まとめて渡す
const DIRECTORY_INPUT_ATTRIBUTES = { webkitdirectory: '' } as object;

/** 取り込み画面。フォルダ・ファイルの選択、ドラッグ&ドロップ、貼り付けに対応する */
const ImportView: React.FC<ImportViewProps> = ({ onImport, draft, onResume, onDiscard }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState('');
  const [pasteKind, setPasteKind] = useState<PasteKind>('markdown');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<Choosing | null>(null);

  // structured: フォルダごと取り込んだ(フォルダ構成が分かる)場合 true
  const runImport = async (files: readonly BundleFile[], structured: boolean, chosen?: string): Promise<void> => {
    try {
      const outcome = await importBundle(files, chosen === undefined ? { structured } : { structured, chosen });
      if (outcome.kind === 'error') {
        setChoosing(null);
        setError(outcome.message);
      } else if (outcome.kind === 'choose') {
        setError(null);
        setChoosing({ files, candidates: outcome.candidates });
      } else {
        setError(null);
        setChoosing(null);
        onImport(outcome.document);
      }
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const importFiles = (files: readonly File[]): Promise<void> =>
    runImport(
      files.map((file) => ({ path: file.name, file })),
      false,
    );

  const importDroppedFolder = async (entries: readonly EntryLike[]): Promise<void> => {
    try {
      await runImport(await collectDropped(entries), true);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const importPasted = (): void => {
    if (pasted.trim() === '') {
      setError(`貼り付けた${PASTE_LABEL[pasteKind]}が空です。`);
      return;
    }
    setError(null);
    const common = { sourceName: null, baseDir: '', assets: new AssetStore([], false) };
    onImport(
      pasteKind === 'html'
        ? { kind: 'html', html: pasted, stylesheets: [], ...common }
        : { kind: 'markdown', markdown: pasted, ...common },
    );
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Markdown / HTML → PDF エディタ</h1>
      </header>
      <main className="import-view">
        {draft !== null && (
          <section className="draft-section" aria-label="前回の編集内容">
            <p>
              <strong>前回の編集内容が残っています</strong>(「{draftName(draft)}」・{new Date(draft.savedAt).toLocaleString('ja-JP')} に自動保存)。
              新しいファイルを開いて編集を始めると、この下書きは、新しい内容に置き換わります。
            </p>
            <p className="drop-buttons">
              <button type="button" className="button button-primary" onClick={onResume}>
                続きから再開
              </button>
              <button type="button" className="button" onClick={onDiscard}>
                破棄
              </button>
            </p>
          </section>
        )}
        <section
          className={`drop-zone${dragging ? ' drop-zone-active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            // ドロップされたものは、イベントの処理が終わると読めなくなるため、ここですべて取り出しておく
            const entries = [...event.dataTransfer.items].flatMap((item) => {
              const entry = item.kind === 'file' ? item.webkitGetAsEntry() : null;
              return entry === null ? [] : [entry];
            });
            const files = [...event.dataTransfer.files];
            if (entries.some((entry) => entry.isDirectory)) {
              void importDroppedFolder(entries);
            } else if (files.length > 0) {
              void importFiles(files);
            }
          }}
        >
          <p>Markdown(.md / .markdown / .txt)またはHTML(.html / .htm)の<strong>フォルダ</strong>、またはファイルを、ここへドラッグ&ドロップ</p>
          <p className="drop-note">
            フォルダごと取り込むと、HTML・Markdownから参照している画像やCSSを、フォルダ内の位置のとおりに自動で読み込みます。
            ファイルを個別に選ぶ場合は、CSS・画像も一緒に複数選択してください(ファイル名で突き合わせます)。
          </p>
          <p className="drop-buttons">
            <button type="button" className="button button-primary" onClick={() => folderInput.current?.click()}>
              フォルダを選択
            </button>
            <button type="button" className="button" onClick={() => fileInput.current?.click()}>
              ファイルを選択
            </button>
          </p>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0) {
                void importFiles(files);
              }
            }}
          />
          <input
            ref={folderInput}
            type="file"
            aria-label="フォルダを選択"
            {...DIRECTORY_INPUT_ATTRIBUTES}
            hidden
            onChange={(event) => {
              const picked = event.target.files;
              try {
                const files = picked === null ? [] : fromDirectoryInput(picked);
                event.target.value = '';
                if (files.length > 0) {
                  void runImport(files, true);
                }
              } catch (cause) {
                event.target.value = '';
                setError(messageOf(cause));
              }
            }}
          />
        </section>

        {choosing !== null && (
          <section className="choose-section" aria-label="開くファイルの選択">
            <p>フォルダの中に、MarkdownまたはHTMLのファイルが{choosing.candidates.length}個あります。開くファイルを選んでください。</p>
            <ul className="choose-list">
              {choosing.candidates.map((path) => (
                <li key={path}>
                  <button type="button" className="button" onClick={() => void runImport(choosing.files, true, path)}>
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="paste-section">
          <label htmlFor="paste-area">または、貼り付ける</label>
          <fieldset className="paste-kind">
            <legend className="visually-hidden">貼り付ける内容の種類</legend>
            {(['markdown', 'html'] as const).map((kind) => (
              <label key={kind}>
                <input type="radio" name="paste-kind" checked={pasteKind === kind} onChange={() => setPasteKind(kind)} /> {PASTE_LABEL[kind]}
              </label>
            ))}
          </fieldset>
          <textarea
            id="paste-area"
            className="source-area paste-area"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            spellCheck={false}
          />
          <button type="button" className="button" onClick={importPasted}>
            貼り付けた内容を読み込む
          </button>
        </section>

        {error !== null && (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        )}
      </main>
    </div>
  );
};

export default ImportView;
