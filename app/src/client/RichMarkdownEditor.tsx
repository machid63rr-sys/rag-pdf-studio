import React, { useRef } from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  tablePlugin,
  imagePlugin,
  frontmatterPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  UndoRedo,
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ListsToggle,
  InsertTable,
  InsertCodeBlock,
  InsertThematicBreak,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { isMermaidLanguage } from '../shared/mermaid';
import { blankParagraphPlugin } from './blankParagraphPlugin';
import { lineBreakPlugin } from './lineBreakPlugin';
import { blankParagraphsToNbsp } from './blankLines';
import { rangeAtPoint } from './dropPoint';
import { embedProblemOf, readImages, summarize, type EmbedNotice } from './embedImage';
import { escapeForMdx, unescapeFromMdx } from './mdxEscape';
import MermaidBlockEditor from './MermaidBlockEditor';
import { InsertPageBreak, pageBreakPlugin } from './pageBreakPlugin';
import PageBreakOverlay from './PageBreakOverlay';
import type { PageLayoutState } from './usePageLayout';

interface RichMarkdownEditorProps {
  // 編集モードに入った時点のMarkdown(以降の変更は内部で保持し、onChangeで親へ通知する)
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  // Markdownを書式付きで解釈できなかった場合(サイレントに握りつぶさず親へ通知する)
  onParseError: (message: string) => void;
  // 画像の参照(相対パスなど)を、エディタ内に表示できるURL(data: URIなど)にする。Markdownの本文は書き換えない
  resolveImage: (source: string) => Promise<string>;
  // 画像ファイルのドロップ・貼り付けによる埋め込みの結果(成功・失敗)を知らせる
  onEmbedNotice: (notice: EmbedNotice | null) => void;
  // PDFのページの区切り位置(サーバが測った結果)。プレビューの上に、線で重ねて表示する
  pageLayout: PageLayoutState;
  // いまのMarkdown(測定した内容と違えば、区切りの位置は、測り直すまで、古い)
  markdown: string;
}

// 一覧に無い言語のコードブロックも、解釈エラーにならず通常どおり扱われる(実測済み)
const CODE_BLOCK_LANGUAGES = {
  txt: 'テキスト',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  python: 'Python',
  bash: 'Bash',
  sh: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  java: 'Java',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  go: 'Go',
  rust: 'Rust',
  diff: 'Diff',
  mermaid: 'Mermaid',
};

/**
 * 書式付き(WYSIWYG)編集。描画された見出し・表・箇条書きをそのまま編集でき、
 * 編集内容は裏のMarkdownへ反映される。
 *
 * - 編集モードを切り替えるたびに再マウントされ、その時点のMarkdownから開始する
 *   (このコンポーネントの外でMarkdownが書き換わる経路は、構文モードのtextareaのみ)
 * - 初期表示時にエディタが行う整形(空白・記号の正規化)は編集として扱わない。
 *   利用者が触っていない本文が、取り込んだMarkdownから勝手に書き換わるのを避けるため。
 * - 解釈できない記法(脚注・参照形式のリンクなど)があると onParseError で通知する
 * - 取り込んだ画像(相対パスの画像)は、resolveImage で表示用のURLにして表示する
 * - Enterで作った空の段落(空行)は、「&nbsp;」だけの段落として保存し、読み込むときに、空の段落に戻す(blankLines.ts)
 * - 手動の改ページは、「改ページ」の区切りとして表示し、<div style="page-break-after: always"></div> の1行として保存する(pageBreakPlugin.tsx)
 * - 画像ファイル(PNG・JPEG・GIF・WebP・SVG)をドロップ・貼り付けすると、data: URI として、文書に埋め込む
 * - PDFのページの区切りを、線で重ねて、常に表示する(位置は、サーバがPDFと同じ条件で測ったもの。PageBreakOverlay)
 * - コードブロックは、言語ごとに色分けして表示する(言語は、ブロックの右上で選べる)。
 *   Mermaidのコードブロックは、コードの下に図も表示する
 */
const RichMarkdownEditor: React.FC<RichMarkdownEditorProps> = ({ initialMarkdown, onChange, onParseError, resolveImage, onEmbedNotice, pageLayout, markdown }) => {
  const wrapper = useRef<HTMLDivElement>(null);
  // プラグインは、エディタを作るときに一度だけ渡すため、最新の通知先は、refを通して使う
  const notify = useRef(onEmbedNotice);
  notify.current = onEmbedNotice;

  // 画像ファイルを、data: URI にして、画像として挿入する(MDXEditorが、ドロップ・貼り付けのたびに呼ぶ)
  const embedImage = async (file: File): Promise<string> => {
    // ドロップ位置へ動かしたカーソル(placeCaretAtDrop)が、エディタに伝わってから、挿入する
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const result = await readImages([file]);
    notify.current(summarize(result));
    const [image] = result.images;
    if (image === undefined) {
      throw new Error(result.problems[0] ?? '画像を埋め込めません');
    }
    return image.uri;
  };

  // 埋め込めないファイルは、エディタに渡さず、理由を知らせる。エディタに渡すと、ブラウザがそのファイルを開いてしまい、
  // 編集中の内容が失われたり、エディタが、エラーを出したりするため
  const rejectUnembeddable = (files: FileList | undefined, event: React.SyntheticEvent): void => {
    const problems = [...(files ?? [])].flatMap((file) => embedProblemOf(file) ?? []);
    if (problems.length > 0) {
      event.preventDefault();
      event.nativeEvent.stopPropagation();
      notify.current({ kind: 'error', text: problems.map((problem) => `${problem}。`).join(' ') });
    }
  };

  // 画像は、エディタのカーソルの位置に挿入されるため、ドロップされた位置へ、先にカーソルを動かす。
  // 本文(段落・見出しなど)の上でなければ(コードブロックの中・余白など)、動かさない(カーソルのあった位置に入る)
  const placeCaretAtDrop = (event: React.DragEvent<HTMLElement>): void => {
    if (event.dataTransfer.files.length === 0) {
      return;
    }
    const range = rangeAtPoint(document, event.clientX, event.clientY);
    const host = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
    const body = host?.closest('.md-editor-content');
    if (range === null || host === null || host === undefined || body === null || host.closest('[contenteditable]') !== body) {
      return;
    }
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };

  return (
    <div
      ref={wrapper}
      className="md-editor-drop"
      onDragOverCapture={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
        }
      }}
      onDropCapture={(event) => {
        rejectUnembeddable(event.dataTransfer.files, event);
        if (!event.defaultPrevented) {
          placeCaretAtDrop(event);
        }
      }}
      onPasteCapture={(event) => {
        // 文字も一緒に貼り付けられる場合(表計算の範囲のコピーなど)は、文字として貼り付ける。画像だけの場合に限る
        const types = [...event.clipboardData.types];
        if (!types.includes('text/plain') && !types.includes('text/html')) {
          rejectUnembeddable(event.clipboardData.files, event);
        }
      }}
    >
      <MDXEditor
        className="md-editor"
        contentEditableClassName="md-editor-content"
        markdown={escapeForMdx(initialMarkdown)}
        onChange={(markdown, initialMarkdownNormalize) => {
          if (!initialMarkdownNormalize) {
            onChange(blankParagraphsToNbsp(unescapeFromMdx(markdown)));
          }
        }}
        onError={({ error }) => onParseError(error)}
        plugins={[
          blankParagraphPlugin(),
          pageBreakPlugin(),
          lineBreakPlugin(),
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          tablePlugin(),
          imagePlugin({ imagePreviewHandler: resolveImage, imageUploadHandler: embedImage }),
          frontmatterPlugin(),
          // Mermaidのコードブロックだけ、図も表示するエディタにする(それ以外は、codeMirrorPluginの色分けつきエディタ)
          codeBlockPlugin({
            defaultCodeBlockLanguage: 'txt',
            codeBlockEditorDescriptors: [{ priority: 100, match: (language) => isMermaidLanguage(language), Editor: MermaidBlockEditor }],
          }),
          codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <Separator />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />
                <ListsToggle />
                <Separator />
                <InsertTable />
                <InsertCodeBlock />
                <InsertThematicBreak />
                <InsertPageBreak />
              </>
            ),
          }),
        ]}
      />
      <PageBreakOverlay container={wrapper} state={pageLayout} markdown={markdown} />
    </div>
  );
};

export default RichMarkdownEditor;
