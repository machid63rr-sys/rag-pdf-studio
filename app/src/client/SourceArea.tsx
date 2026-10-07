import React, { useLayoutEffect, useRef } from 'react';
import { insertSnippet, readImages, snippetOf, summarize, type EmbedNotice, type SnippetKind } from './embedImage';

interface SourceAreaProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  // 画像をドロップしたときに書き込む、画像の書き方(Markdownの ![]() 、HTMLの <img>、CSSの url())
  snippet: SnippetKind;
  // 画像を埋め込んだ結果(成功・失敗)を知らせる
  onNotice: (notice: EmbedNotice | null) => void;
}

const hasFiles = (event: React.DragEvent): boolean => event.dataTransfer.types.includes('Files');

/**
 * ソース(Markdown・HTML・CSS)を直接編集するテキスト欄。
 * 画像ファイルをドロップすると、カーソルの位置(選択中なら、その範囲の代わり)に、画像を data: URI で埋め込む。
 * ファイルのドロップを受け付けないと、ブラウザが、その画像を開いてしまい、編集中の内容が失われるため、
 * 画像以外のファイルも、ここで受け止めて、理由を知らせる。
 */
const SourceArea: React.FC<SourceAreaProps> = ({ value, onChange, ariaLabel, snippet, onNotice }) => {
  const area = useRef<HTMLTextAreaElement>(null);
  // 挿入後に、カーソルを置く位置(値が反映されてから設定する)
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && area.current) {
      area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const embed = async (files: readonly File[]): Promise<void> => {
    const textarea = area.current;
    const result = await readImages(files);
    onNotice(summarize(result));
    if (textarea === null || result.images.length === 0) {
      return;
    }
    // 読み込みの間に、利用者が編集を続けても、その内容を失わないよう、挿入の直前の値と位置を使う
    const inserted = insertSnippet(textarea.value, textarea.selectionStart, textarea.selectionEnd, snippetOf(snippet, result.images), snippet === 'markdown');
    pendingCaret.current = inserted.caret;
    onChange(inserted.value);
  };

  return (
    <textarea
      ref={area}
      className="source-area"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onDragOver={(event) => {
        if (hasFiles(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) {
          return; // 文字のドラッグ(選択した文字の移動など)は、そのまま
        }
        event.preventDefault();
        void embed([...event.dataTransfer.files]);
      }}
      spellCheck={false}
    />
  );
};

export default SourceArea;
