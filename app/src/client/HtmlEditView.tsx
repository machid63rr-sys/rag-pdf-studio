import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { PageSettings } from '../shared/pageSettings';
import type { DraftContent } from './draft';
import DraftStatus from './DraftStatus';
import { draftStorage } from './draftStorage';
import type { HtmlDocument, Stylesheet } from './documents';
import EmbedStatus from './EmbedStatus';
import type { EmbedNotice } from './embedImage';
import { defaultBaseName } from './filename';
import { composeDocument, composeHtml, type ComposeContext } from './htmlCompose';
import { patchHtmlSource } from './htmlPatch';
import HtmlPreview, { type HtmlPreviewHandle } from './HtmlPreview';
import { lintHtml } from './lintHtml';
import type { OutputFile } from './outputMode';
import OutputPanel from './OutputPanel';
import PageSettingsPanel from './PageSettingsPanel';
import { loadPageSettings, savePageSettings } from './pageSettingsStorage';
import { requestPdf } from './pdfClient';
import SourceArea from './SourceArea';
import { useDraftAutosave } from './useDraftAutosave';
import WarningList from './WarningList';

interface HtmlEditViewProps {
  document: HtmlDocument;
  onClose: () => void;
}

// 'preview' | 'html' | 'css:<取り込んだ一式の中のパス>'
type Tab = string;
const PREVIEW_TAB = 'preview';
const HTML_TAB = 'html';
const cssTab = (path: string): Tab => `css:${path}`;

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 保存できるファイル(HTML・CSS・PDF)。CSSは、HTMLの<link>が指している位置(HTMLのフォルダからの相対パス)で保存する */
const outputFilesOf = (html: string, stylesheets: readonly Stylesheet[]): OutputFile[] => [
  { id: 'html', label: 'HTML (.html)', shortLabel: 'HTML', extension: 'html', content: { type: 'text', text: html, mimeType: 'text/html' } },
  ...stylesheets.map(
    (stylesheet): OutputFile => ({
      id: `css:${stylesheet.path}`,
      label: `CSS (${stylesheet.outputPath})`,
      shortLabel: 'CSS',
      extension: 'css',
      fixedName: stylesheet.outputPath,
      content: { type: 'text', text: stylesheet.text, mimeType: 'text/css' },
    }),
  ),
  { id: 'pdf', label: 'PDF (.pdf)', shortLabel: 'PDF', extension: 'pdf', content: { type: 'pdf' } },
];

/**
 * HTML(とCSS・画像)を編集して出力する画面。
 * - プレビュー: 表示を見ながら直接編集する。編集した箇所だけが、元のHTMLへ反映される
 * - HTML / CSS: ソースを直接編集する。隣のプレビューに、編集内容がすぐ反映される
 */
const HtmlEditView: React.FC<HtmlEditViewProps> = ({ document, onClose }) => {
  const { assets, baseDir } = document;
  const context = useMemo<ComposeContext>(() => ({ assets, baseDir }), [assets, baseDir]);
  const [html, setHtml] = useState(document.html);
  const [stylesheets, setStylesheets] = useState<readonly Stylesheet[]>(document.stylesheets);
  const [tab, setTab] = useState<Tab>(PREVIEW_TAB);
  // プレビューを開いた時点のHTML。プレビュー上の編集は、これとの差分として元のHTMLへ反映する
  // (編集のたびにプレビューを作り直すと、カーソルが外れるため、開いている間は変えない)。
  // null: 画像を読み込んでいる最中(画像がそろってからプレビューを作る。後から画像が増えて、作り直しにならないように)
  const [seed, setSeed] = useState<{ html: string; id: number } | null>(null);
  const seedCount = useRef(0);
  // 画像を読み込むたびに増やし、隣のプレビューを作り直す
  const [imagesVersion, setImagesVersion] = useState(0);
  const [patchError, setPatchError] = useState<string | null>(null);
  // 画像のドロップによる埋め込みの結果
  const [embedNotice, setEmbedNotice] = useState<EmbedNotice | null>(null);
  // PDFのページ設定。HTMLでは、用紙・向き・余白は文書のCSS(@page)が決めるため、ページ番号の有無だけが使われる(HTMLは書き換えない)
  const [pageSettings, setPageSettings] = useState<PageSettings>(() => document.pageSettings ?? loadPageSettings());
  const changePageSettings = useCallback((next: PageSettings) => {
    setPageSettings(next);
    savePageSettings(next);
  }, []);
  const preview = useRef<HtmlPreviewHandle>(null);

  // HTML・CSSが参照している、取り込んだ画像を読み込む(読み込めた画像が増えたら、表示を更新する)
  const loadImages = useCallback(
    async (source: string, sheets: readonly Stylesheet[]): Promise<void> => {
      const before = assets.loadedCount;
      await assets.ensure(composeDocument(source, sheets, context, { preview: false }).imagePaths);
      if (assets.loadedCount !== before) {
        setImagesVersion((version) => version + 1);
      }
    },
    [assets, context],
  );

  const openPreview = useCallback(
    (source: string, sheets: readonly Stylesheet[]): void => {
      setSeed(null);
      void loadImages(source, sheets).then(() => {
        seedCount.current += 1;
        setSeed({ html: source, id: seedCount.current });
      });
    },
    [loadImages],
  );

  useEffect(() => {
    openPreview(document.html, document.stylesheets);
    // 最初の表示のときだけ(以降は、タブを切り替えるときに開く)
  }, []);

  const warnings = useMemo(() => lintHtml(html, stylesheets, context), [html, stylesheets, context]);
  const outputFiles = useMemo(() => outputFilesOf(html, stylesheets), [html, stylesheets]);

  // 編集可能なプレビュー(開いた時点のHTMLを表示する)
  const editableDoc = useMemo(
    () => (seed === null ? null : composeHtml(seed.html, stylesheets, context, { preview: true })),
    [seed, stylesheets, context],
  );

  // HTML・CSSタブの隣に出す、読み取り専用のプレビュー(入力のたびに作り直すと重いため、少し遅らせて反映する)
  const deferredHtml = useDeferredValue(html);
  const deferredStylesheets = useDeferredValue(stylesheets);
  useEffect(() => {
    if (tab !== PREVIEW_TAB) {
      void loadImages(deferredHtml, deferredStylesheets);
    }
  }, [tab, deferredHtml, deferredStylesheets, loadImages]);
  const sideDoc = useMemo(
    () => composeHtml(deferredHtml, deferredStylesheets, context, { preview: true }),
    // imagesVersion: 画像の読み込みが終わったら、作り直す
    [deferredHtml, deferredStylesheets, context, imagesVersion],
  );

  const handlePreviewEdit = (liveHtml: string): void => {
    if (seed === null) {
      return;
    }
    try {
      setHtml(patchHtmlSource(seed.html, liveHtml).html);
      setPatchError(null);
    } catch (cause) {
      setPatchError(`プレビューでの編集をHTMLへ反映できませんでした(${messageOf(cause)})。「HTML」タブで編集してください。`);
    }
  };

  const switchTab = (next: Tab): void => {
    if (next === tab) {
      return;
    }
    setEmbedNotice(null);
    if (tab === PREVIEW_TAB) {
      preview.current?.flush();
    }
    if (next === PREVIEW_TAB) {
      // 最新のHTMLからプレビューを作り直す
      openPreview(html, stylesheets);
      setPatchError(null);
    }
    setTab(next);
  };

  // 取り込んだ(または復元した)ときから変わっているか。下書きから復元した文書は、元のファイルが無いため、常に「変更あり」
  const changed =
    document.restored === true || html !== document.html || stylesheets.some((sheet, index) => sheet.text !== document.stylesheets[index]?.text);
  // 変わっていれば、自動保存する下書き(HTMLと、CSSの編集内容。変わっていなければ null)
  const draftContent = useMemo<DraftContent | null>(
    () =>
      changed
        ? {
            kind: 'html',
            sourceName: document.sourceName,
            baseDir,
            html,
            stylesheets: stylesheets.map(({ path, outputPath, text }) => ({ path, outputPath, text })),
            pageSettings,
          }
        : null,
    [changed, document.sourceName, baseDir, html, stylesheets, pageSettings],
  );
  const saveState = useDraftAutosave(draftStorage, draftContent);

  const close = async (): Promise<void> => {
    if (!changed) {
      onClose();
    } else if (window.confirm('編集内容は破棄されます。別のファイルを読み込みますか?')) {
      // 破棄を選んだ編集内容の下書きは、残さない(次に開いたとき、再開を案内しないため)
      await draftStorage.clear();
      onClose();
    }
  };

  const editStylesheet = (path: string, text: string): void =>
    setStylesheets((current) => current.map((sheet) => (sheet.path === path ? { ...sheet, text } : sheet)));

  const currentStylesheet = stylesheets.find((sheet) => cssTab(sheet.path) === tab);
  const tabs: { id: Tab; label: string }[] = [
    { id: PREVIEW_TAB, label: 'プレビュー(直接編集)' },
    { id: HTML_TAB, label: 'HTML' },
    ...stylesheets.map((sheet) => ({ id: cssTab(sheet.path), label: `CSS: ${sheet.path}` })),
  ];

  return (
    <div className="app app-wide">
      <header className="app-header">
        <h1>Markdown / HTML → PDF エディタ</h1>
        <button type="button" className="button" onClick={() => void close()}>
          別のファイルを読み込む
        </button>
      </header>

      <main className="edit-view">
        <p className="source-name">{document.sourceName === null ? '貼り付けたHTML' : document.sourceName}</p>

        {document.restored === true && (
          <p className="notice notice-info">
            自動保存した下書きから復元しました(HTML・CSSの編集内容、ページ設定)。取り込んだ画像のファイルは復元されないため、画像が表示されない場合は、元のファイル(フォルダ)を取り込み直してください。
          </p>
        )}
        <DraftStatus state={saveState} changed={changed} />

        <WarningList warnings={warnings} />

        {patchError !== null && (
          <p role="alert" className="notice notice-error">
            {patchError}
          </p>
        )}

        <div className="tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`tab${tab === item.id ? ' tab-active' : ''}`}
              onClick={() => switchTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="editor-pane" role="tabpanel">
          {tab === PREVIEW_TAB ? (
            seed === null || editableDoc === null ? (
              <p className="notice notice-info">画像を読み込んでいます…</p>
            ) : (
              <HtmlPreview key={seed.id} ref={preview} srcDoc={editableDoc} editable onEdit={handlePreviewEdit} onEmbedNotice={setEmbedNotice} />
            )
          ) : (
            <div className="source-split">
              <SourceArea
                ariaLabel={currentStylesheet === undefined ? 'HTML' : `CSS: ${currentStylesheet.path}`}
                value={currentStylesheet === undefined ? html : currentStylesheet.text}
                onChange={(value) => (currentStylesheet === undefined ? setHtml(value) : editStylesheet(currentStylesheet.path, value))}
                snippet={currentStylesheet === undefined ? 'html' : 'css'}
                onNotice={setEmbedNotice}
              />
              <HtmlPreview srcDoc={sideDoc} editable={false} />
            </div>
          )}
        </div>
        <EmbedStatus notice={embedNotice} />
        <p className="hint">
          画像ファイル(PNG・JPEG・GIF・WebP・SVG。1枚10MBまで)をドラッグ&ドロップすると、画像のデータを埋め込みます(プレビューではドロップした位置に、HTML・CSSのタブではカーソルの位置に、画像を書き込みます。HTML・CSSの中に画像のデータが文字として入るため、文書が大きくなります)。
          プレビューで編集すると、編集した箇所のHTMLだけが書き換わります(編集していない部分は、取り込んだままです)。
          プレビューはスクリプトを実行せず、外部のファイルも読み込みません(PDFと同じ)。PDFはサーバ側のフォントで描画されるため、
          プレビューと字形や改ページ位置が少し異なることがあります。
        </p>

        <PageSettingsPanel value={pageSettings} onChange={changePageSettings} layoutEditable={false} />

        <OutputPanel
          files={outputFiles}
          defaultBaseName={defaultBaseName(document.sourceName)}
          generatePdf={async () => {
            await loadImages(html, stylesheets);
            return requestPdf({ kind: 'html', text: composeHtml(html, stylesheets, context, { preview: false }), pageSettings });
          }}
          empty={html.trim() === ''}
        />
      </main>
    </div>
  );
};

export default HtmlEditView;
