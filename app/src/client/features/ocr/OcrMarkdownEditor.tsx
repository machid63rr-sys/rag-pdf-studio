import React from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  tablePlugin,
  codeBlockPlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  InsertTable,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { escapeForMdx, unescapeFromMdx } from '../../mdxEscape';

interface OcrMarkdownEditorProps {
  // 編集モードに入った時点のMarkdown(以降の変更は内部で保持し、onChangeで親へ通知する)
  readonly initialMarkdown: string;
  readonly onChange: (markdown: string) => void;
  // Markdownを書式付きで解釈できなかった場合(サイレントに握りつぶさず親へ通知する)
  readonly onParseError: (message: string) => void;
}

/**
 * OCR結果の、書式付き(WYSIWYG)編集。描画された見出し・表・箇条書きをそのまま編集でき、
 * 編集内容は裏のMarkdownへ反映される。PDF出力向けの機能(改ページ・画像の埋め込み・図)は持たない
 * 軽い構成(それらは「① MD/HTML → PDF」の編集画面で行う)。
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
      // OCR結果にコードフェンスが混ざることがあるため、解釈できるよう有効化する
      codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
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
          </>
        ),
      }),
    ]}
  />
);

export default OcrMarkdownEditor;
