/*
 * ドロップされた位置(画面上の座標)に対応する、文書内のカーソル位置。
 * ブラウザによって、取得の関数が異なる(Chrome・Edge・Safariは caretRangeFromPoint、Firefoxは caretPositionFromPoint)。
 */
export function rangeAtPoint(doc: Document, x: number, y: number): Range | null {
  const legacy = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  if (typeof legacy.caretRangeFromPoint === 'function') {
    return legacy.caretRangeFromPoint(x, y);
  }
  const modern = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const position = modern.caretPositionFromPoint?.(x, y) ?? null;
  if (position === null) {
    return null;
  }
  const range = doc.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}
