import React from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  tablePlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  InsertTable,
  InsertCodeBlock,
  InsertThematicBreak,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { codeBlockPlugins } from '../../codeBlockPlugins';
import { escapeForMdx, unescapeFromMdx } from '../../mdxEscape';
import { InsertPageBreak, pageBreakPlugin } from '../../pageBreakPlugin';

interface OcrMarkdownEditorProps {
  // 編集モードに入った時点のMarkdown(以降の変更は内部で保持し、onChangeで親へ通知する)
  readonly initialMarkdown: string;
  readonly onChange: (markdown: string) => void;
  // Markdownを書式付きで解釈できなかった場合(サイレントに握りつぶさず親へ通知する)
  readonly onParseError: (message: string) => void;
}

/**
 * OCR結果の、書式付き(WYSIWYG)編集。描画された見出し・表・箇条書きをそのまま編集でき、
 * 編集内容は裏のMarkdownへ反映される。OCR結果に、人が内容を足せるよう、表・コードブロック・区切り線・改ページを
 * ツールバーから入れられる(「① MD/HTML → PDF」の編集画面と同じ部品)。画像の埋め込み・PDFのページの区切り位置の
 * 表示は持たない軽い構成(それらは「① MD/HTML → PDF」の編集画面で行う)。
 *
 * - 改ページは、「改ページ」の区切りとして表示し、<div style="page-break-after: always"></div> の1行として保存する
 *   (pageBreakPlugin.tsx)。「① PDFにして出力へ」で渡したPDFで、その位置から新しいページになる
 *
 * - 編集モードを切り替えるたびに再マウントされ、その時点のMarkdownから開始する
 *   (このコンポーネントの外でMarkdownが書き換わる経路は、構文モードのtextareaのみ)
 * - 初期表示時にエディタが行う整形(空白・記号の正規化)は編集として扱わない。
 *   利用者が触っていない本文が、OCR結果から勝手に書き換わるのを避けるため。
 */
const OcrMarkdownEditor: React.FC<OcrMarkdownEditorProps> = ({ initialMarkdown, onChange, onParseError }) => (
  <MDXEditor
    className="md-editor"
    contentEditableClassName="md-editor-content"
    markdown={escapeForMdx(initialMarkdown)}
    onChange={(markdown, initialMarkdownNormalize) => {
      if (!initialMarkdownNormalize) {
        onChange(unescapeFromMdx(markdown));
      }
    }}
    onError={({ error }) => onParseError(error)}
    plugins={[
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      tablePlugin(),
      pageBreakPlugin(),
      // OCR結果にコードフェンスが混ざることがあるため、解釈できるよう有効化する。ボタンで入れたブロックも、同じ設定で表示する
      ...codeBlockPlugins(),
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
);

export default OcrMarkdownEditor;
