import React, { useCallback, useMemo, useState } from 'react';
import type { MarkdownDocument } from './documents';
import { isImagePath } from './assets';
import type { DraftContent } from './draft';
import DraftStatus from './DraftStatus';
import { draftStorage } from './draftStorage';
import EmbedStatus from './EmbedStatus';
import type { EmbedNotice } from './embedImage';
import { defaultBaseName } from './filename';
import type { PageSettings } from '../shared/pageSettings';
import { lintMarkdown } from './lint';
import { collectMarkdownAssets } from './markdownAssets';
import type { OutputFile } from './outputMode';
import OutputPanel from './OutputPanel';
import PageSettingsPanel from './PageSettingsPanel';
import { loadPageSettings, savePageSettings } from './pageSettingsStorage';
import { requestPdf } from './pdfClient';
import RichMarkdownEditor from './RichMarkdownEditor';
import SourceArea from './SourceArea';
import { useDraftAutosave } from './useDraftAutosave';
import { usePageLayout } from './usePageLayout';
import WarningList from './WarningList';

interface EditViewProps {
  document: MarkdownDocument;
  onClose: () => void;
}

type EditorMode = 'rich' | 'source';

/** 保存できるファイル(Markdown・PDF) */
const outputFilesOf = (markdown: string): OutputFile[] => [
  {
    id: 'markdown',
    label: 'Markdown (.md)',
    shortLabel: 'MD',
    extension: 'md',
    content: { type: 'text', text: markdown, mimeType: 'text/markdown' },
  },
  { id: 'pdf', label: 'PDF (.pdf)', shortLabel: 'PDF', extension: 'pdf', content: { type: 'pdf' } },
];

/** プレビュー(書式付き編集)とMarkdown(ソース)を切り替えて編集し、出力する画面 */
const EditView: React.FC<EditViewProps> = ({ document, onClose }) => {
  // 現在のMarkdown(出力の対象)。編集のたびに更新される
  const [markdown, setMarkdown] = useState(document.markdown);
  // 書式付きエディタに渡す初期値。エディタの再マウント時にだけ現在のMarkdownへ更新する(入力中に渡し直さない)
  const [editorSeed, setEditorSeed] = useState(document.markdown);
  const [editorKey, setEditorKey] = useState(0);
  const [mode, setMode] = useState<EditorMode>('rich');
  const [parseError, setParseError] = useState<string | null>(null);
  // 画像のドロップ・貼り付けによる埋め込みの結果
  const [embedNotice, setEmbedNotice] = useState<EmbedNotice | null>(null);
  // PDFのページ設定(用紙・向き・余白・ページ番号)。前回の設定で始まり、変えると覚えておく
  const [pageSettings, setPageSettings] = useState<PageSettings>(() => document.pageSettings ?? loadPageSettings());
  const changePageSettings = useCallback((next: PageSettings) => {
    setPageSettings(next);
    savePageSettings(next);
  }, []);

  const { assets, baseDir } = document;
  // 取り込んだ画像として表示できる参照か(相対パスの画像が、取り込んだファイルの中にあるか)
  const canDisplayImage = useCallback(
    (reference: string): boolean => {
      const path = assets.resolve(reference, baseDir);
      return path !== undefined && isImagePath(path);
    },
    [assets, baseDir],
  );
  // エディタ内の画像を、取り込んだファイルから表示する(画像の参照そのものは、Markdownのまま変わらない)
  const resolveImage = useCallback(
    async (source: string): Promise<string> => {
      const path = assets.resolve(source, baseDir);
      if (path === undefined) {
        return source;
      }
      await assets.ensure([path]);
      return assets.previewUrl(path) ?? source;
    },
    [assets, baseDir],
  );
  const warnings = useMemo(() => lintMarkdown(markdown, canDisplayImage), [markdown, canDisplayImage]);
  // PDFのページの区切り位置(「プレビュー」で、書式付きの表示に重ねる)。測れない(解釈エラー)ときや、Markdownタブでは、測らない
  const pageLayout = usePageLayout(markdown, mode === 'rich' && parseError === null, baseDir, assets, pageSettings);
  const outputFiles = useMemo(() => outputFilesOf(markdown), [markdown]);

  const handleParseError = useCallback((message: string) => {
    setParseError(message);
    setMode('source');
  }, []);

  const switchMode = (next: EditorMode): void => {
    if (next === mode) {
      return;
    }
    setEmbedNotice(null);
    if (next === 'rich') {
      setParseError(null);
      setEditorSeed(markdown);
      setEditorKey((key) => key + 1);
    }
    setMode(next);
  };

  // 取り込んだ(または復元した)ときから変わっているか。下書きから復元した文書は、元のファイルが無いため、常に「変更あり」
  const changed = document.restored === true || markdown !== document.markdown;
  // 変わっていれば、自動保存する下書き(変わっていなければ null)
  const draftContent = useMemo<DraftContent | null>(
    () => (changed ? { kind: 'markdown', sourceName: document.sourceName, baseDir, markdown, pageSettings } : null),
    [changed, document.sourceName, baseDir, markdown, pageSettings],
  );
  const saveState = useDraftAutosave(draftStorage, draftContent);

  const close = async (): Promise<void> => {
    if (!changed) {
      onClose();
    } else if (window.confirm('編集内容は破棄されます。別のMarkdownを読み込みますか?')) {
      // 破棄を選んだ編集内容の下書きは、残さない(次に開いたとき、再開を案内しないため)
      await draftStorage.clear();
      onClose();
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Markdown / HTML → PDF エディタ</h1>
        <button type="button" className="button" onClick={() => void close()}>
          別のファイルを読み込む
        </button>
      </header>

      <main className="edit-view">
        <p className="source-name">
          {document.sourceName === null ? '貼り付けたMarkdown' : document.sourceName}
        </p>

        {document.restored === true && (
          <p className="notice notice-info">
            自動保存した下書きから復元しました。取り込んだ画像のファイルは復元されないため、画像が表示されない場合は、元のファイル(フォルダ)を取り込み直してください。
          </p>
        )}
        <DraftStatus state={saveState} changed={changed} />

        <WarningList warnings={warnings} />

        {parseError !== null && (
          <div role="alert" className="notice notice-error">
            <p>
              このMarkdownには、書式付きエディタで扱えない記法(脚注・参照形式のリンクなど)が含まれています。
              「Markdown」タブで編集してください。PDFは通常どおり出力できます。
            </p>
            <details>
              <summary>詳細</summary>
              <pre className="error-detail">{parseError}</pre>
            </details>
          </div>
        )}

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rich'}
            className={`tab${mode === 'rich' ? ' tab-active' : ''}`}
            onClick={() => switchMode('rich')}
          >
            プレビュー(書式付きで編集)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            className={`tab${mode === 'source' ? ' tab-active' : ''}`}
            onClick={() => switchMode('source')}
          >
            Markdown
          </button>
        </div>

        <div className="editor-pane" role="tabpanel">
          {mode === 'rich' ? (
            <RichMarkdownEditor
              key={editorKey}
              initialMarkdown={editorSeed}
              onChange={setMarkdown}
              onParseError={handleParseError}
              resolveImage={resolveImage}
              onEmbedNotice={setEmbedNotice}
              pageLayout={pageLayout}
              markdown={markdown}
            />
          ) : (
            <SourceArea value={markdown} onChange={setMarkdown} ariaLabel="Markdown" snippet="markdown" onNotice={setEmbedNotice} />
          )}
        </div>
        <EmbedStatus notice={embedNotice} />
        <p className="hint">
          画像ファイル(PNG・JPEG・GIF・WebP・SVG。1枚10MBまで)をドラッグ&ドロップすると、カーソルの位置に、画像のデータを埋め込みます(Markdownの中に、画像のデータが文字として入るため、文書が大きくなります)。
          「プレビュー」で一度でも編集すると、Markdown全体の書き方が正規化されます(箇条書きの記号、表の桁揃えなど。内容は保たれます)。
          PDFはサーバ側のフォントで描画されるため、プレビューと字形や折り返しが少し異なることがあります(ページの区切りは、PDFと同じ条件で測った位置を、赤い点線で表示しています)。
          ツールバーの「改ページ」で、カーソルの位置から新しいページにできます。
        </p>

        <PageSettingsPanel value={pageSettings} onChange={changePageSettings} layoutEditable />

        <OutputPanel
          files={outputFiles}
          defaultBaseName={defaultBaseName(document.sourceName)}
          generatePdf={async () =>
            requestPdf({ kind: 'markdown', text: markdown, baseDir, assets: await collectMarkdownAssets(markdown, baseDir, assets), pageSettings })
          }
          empty={markdown.trim() === ''}
        />
      </main>
    </div>
  );
};

export default EditView;
