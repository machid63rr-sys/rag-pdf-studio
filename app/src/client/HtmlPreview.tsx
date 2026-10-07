import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { rangeAtPoint } from './dropPoint';
import { htmlImage, readImages, summarize, type EmbedNotice } from './embedImage';
import { ORIGINAL_ATTRIBUTE_PREFIX } from './htmlCompose';

/*
 * HTMLのプレビュー。隔離したiframe(スクリプト無効・外部通信遮断)に、文書を表示する。
 * editable のときは、プレビュー上で直接文字を編集でき、編集のたびに現在のHTMLを onEdit へ渡す
 * (元のHTMLへ「変更した箇所だけ」を反映する処理は、呼び出し側が htmlPatch で行う)。
 *
 * iframeは sandbox="allow-same-origin"(allow-scripts なし)。利用者のHTML内のスクリプトは実行されず、
 * 編集のための操作(designModeの設定・イベントの受け取り)は、このアプリ側のコードがiframeの文書に対して行う。
 */

export interface HtmlPreviewHandle {
  // 間引き中の編集があれば、すぐに onEdit へ渡す(タブを切り替える前などに呼ぶ)
  flush(): void;
}

interface HtmlPreviewProps {
  // 表示する文書全体(CSS適用済み・プレビュー用の安全対策済み)
  srcDoc: string;
  editable: boolean;
  // 編集のたびに(少し間引いて)、iframe内の文書全体のHTMLを渡す。editable のときだけ呼ばれる
  onEdit?: (liveHtml: string) => void;
  // 画像ファイルのドロップによる埋め込みの結果(editable のときだけ呼ばれる)
  onEmbedNotice?: (notice: EmbedNotice | null) => void;
}

const EDIT_DEBOUNCE_MS = 120;

interface ToolbarButton {
  label: string;
  title: string;
  command: string;
  value?: string;
}

const TOOLBAR: readonly (readonly ToolbarButton[])[] = [
  [
    { label: '元に戻す', title: '元に戻す (Ctrl+Z)', command: 'undo' },
    { label: 'やり直し', title: 'やり直し (Ctrl+Y)', command: 'redo' },
  ],
  [
    { label: '太字', title: '太字 (Ctrl+B)', command: 'bold' },
    { label: '斜体', title: '斜体 (Ctrl+I)', command: 'italic' },
    { label: '下線', title: '下線 (Ctrl+U)', command: 'underline' },
  ],
  [
    { label: '段落', title: '段落にする', command: 'formatBlock', value: 'p' },
    { label: '見出し1', title: '見出し1にする', command: 'formatBlock', value: 'h1' },
    { label: '見出し2', title: '見出し2にする', command: 'formatBlock', value: 'h2' },
    { label: '見出し3', title: '見出し3にする', command: 'formatBlock', value: 'h3' },
  ],
  [
    { label: '箇条書き', title: '箇条書き', command: 'insertUnorderedList' },
    { label: '番号付き', title: '番号付きリスト', command: 'insertOrderedList' },
  ],
];

// プレビュー用に data: URI へ置き換えた画像の参照(srcなど)を、元の値に戻す。
// 元の値は、置き換えた属性と一緒に、接頭辞つきの属性として残してある(htmlCompose)
function restoreOriginalAttributes(root: Element): void {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith(ORIGINAL_ATTRIBUTE_PREFIX)) {
        element.setAttribute(attribute.name.slice(ORIGINAL_ATTRIBUTE_PREFIX.length), attribute.value);
        element.removeAttribute(attribute.name);
      }
    }
  }
}

// iframe内の文書を、<!DOCTYPE> を含めてHTMLにする。outerHTMLだけだとdoctypeが失われ、
// 標準モード/互換モードの違いで、元のHTMLとは解釈の仕方(要素の入れ子)が変わってしまうため。
// プレビュー用に書き換えた画像の参照は、元の値に戻す(元のHTMLと比べて、画像の参照を編集と取り違えないため)
export function serializeDocument(doc: Document): string {
  const type = doc.doctype;
  const doctype = type
    ? `<!DOCTYPE ${type.name}${type.publicId ? ` PUBLIC "${type.publicId}"` : ''}${type.systemId ? ` "${type.systemId}"` : ''}>`
    : '';
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  restoreOriginalAttributes(root);
  return doctype + root.outerHTML;
}

// 画像の挿入位置: ドロップされた位置、無ければ現在のカーソル、それも無ければ本文の末尾
function insertionRange(doc: Document, win: Window, x: number, y: number): Range {
  const inBody = (range: Range | null): range is Range => range !== null && doc.body.contains(range.startContainer);
  const dropped = rangeAtPoint(doc, x, y);
  if (inBody(dropped)) {
    return dropped;
  }
  const current = win.getSelection()?.rangeCount ? win.getSelection()?.getRangeAt(0) ?? null : null;
  if (inBody(current)) {
    return current;
  }
  const end = doc.createRange();
  end.selectNodeContents(doc.body);
  end.collapse(false);
  return end;
}

const HtmlPreview = forwardRef<HtmlPreviewHandle, HtmlPreviewProps>(function HtmlPreview({ srcDoc, editable, onEdit, onEmbedNotice }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<number | null>(null);
  const scroll = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // 最新のonEditを使う(iframeの読み込み時に登録したイベントから呼ぶため)
  const latestOnEdit = useRef(onEdit);
  latestOnEdit.current = onEdit;
  const latestOnEmbedNotice = useRef(onEmbedNotice);
  latestOnEmbedNotice.current = onEmbedNotice;

  const emit = useCallback((): void => {
    pending.current = null;
    const doc = frame.current?.contentDocument;
    if (doc) {
      latestOnEdit.current?.(serializeDocument(doc));
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flush: () => {
        if (pending.current !== null) {
          window.clearTimeout(pending.current);
          emit();
        }
      },
    }),
    [emit],
  );

  const handleLoad = (): void => {
    const doc = frame.current?.contentDocument;
    const win = frame.current?.contentWindow;
    if (!doc || !win) {
      return;
    }
    // 再描画(srcDocの更新)でスクロール位置が先頭に戻らないよう、位置を覚えて戻す
    win.scrollTo(scroll.current.x, scroll.current.y);
    win.addEventListener('scroll', () => {
      scroll.current = { x: win.scrollX, y: win.scrollY };
    });
    // リンクをたどって、iframeが別のページ(外部サイトなど)に移ってしまわないようにする
    doc.addEventListener(
      'click',
      (event) => {
        // iframe内の要素は、このページの Element とは別物のため、instanceof ではなく closest の有無で判断する
        const target = event.target as Element | null;
        if (target?.closest?.('a')) {
          event.preventDefault();
        }
      },
      true,
    );
    // ファイルのドロップで、iframeが別の文書に切り替わらないようにする(編集できない側も同様)
    for (const type of ['dragover', 'drop'] as const) {
      doc.addEventListener(type, (event) => event.preventDefault());
    }
    if (!editable) {
      return;
    }
    doc.designMode = 'on';
    // 太字などを、style属性つきの<span>ではなく<b>・<i>などのタグで付ける(元のHTMLに近い形にするため)
    doc.execCommand('styleWithCSS', false, 'false');
    doc.addEventListener('input', () => {
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
      }
      pending.current = window.setTimeout(emit, EDIT_DEBOUNCE_MS);
    });
    // 他のページからの貼り付けで、余計なタグやスタイルが入り込まないよう、文字だけを貼り付ける
    doc.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text !== '') {
        doc.execCommand('insertText', false, text);
      }
    });
    // 画像ファイルをドロップすると、ドロップした位置に、画像のデータ(data: URI)を埋め込む。
    // 画像以外のファイルは、理由を知らせる(文字などのドロップは、何もしない)
    doc.addEventListener('drop', (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) {
        return;
      }
      const { clientX, clientY } = event;
      void readImages(files).then((result) => {
        latestOnEmbedNotice.current?.(summarize(result));
        if (result.images.length > 0) {
          win.getSelection()?.removeAllRanges();
          win.getSelection()?.addRange(insertionRange(doc, win, clientX, clientY));
          win.focus();
          // 挿入すると inputイベントが起き、元のHTMLへ、この画像の分だけが反映される
          doc.execCommand('insertHTML', false, result.images.map(htmlImage).join(''));
        }
      });
    });
  };

  const run = (button: ToolbarButton): void => {
    const doc = frame.current?.contentDocument;
    if (!doc) {
      return;
    }
    frame.current?.contentWindow?.focus();
    doc.execCommand(button.command, false, button.value);
  };

  return (
    <div className="html-preview">
      {editable && (
        <div className="html-toolbar" role="toolbar" aria-label="書式">
          {TOOLBAR.map((group, index) => (
            <span key={index} className="html-toolbar-group">
              {group.map((button) => (
                <button
                  key={button.label}
                  type="button"
                  className="button button-small"
                  title={button.title}
                  // ボタンを押しても、プレビュー内の選択範囲・カーソルが外れないようにする
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(button)}
                >
                  {button.label}
                </button>
              ))}
            </span>
          ))}
        </div>
      )}
      <iframe
        ref={frame}
        className="html-preview-frame"
        title={editable ? 'プレビュー(直接編集)' : 'プレビュー'}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={handleLoad}
      />
    </div>
  );
});

export default HtmlPreview;
