import { FENCE_LINE } from './markdownText';

/*
 * 空行(空の段落)の保存と、読み込み。
 *
 * 書式付きエディタで、Enterを重ねて作った「空の段落」は、Markdownでは、空行が重なっただけになる
 * (例: 「A」「(空の段落)」「B」→ 「A\n\n\n\nB」)。Markdownの規則では、空行がいくつ重なっても、段落の区切りは1つにまとまる
 * ため、PDFでは空行が詰まり、エディタに読み込み直しても、空の段落は消えてしまう。
 *
 * そこで、空の段落は、「&nbsp;」(改行しない空白)だけの段落として保存する。
 *   - PDF: 空白の段落が、1行分の空きになる(Markdownの規則どおりで、他のツールでも、空きとして残る)
 *   - エディタ: 「&nbsp;」だけの段落は、空の段落に戻して表示する(blankParagraphPlugin)
 * 保存するMarkdownで、空行は、「&nbsp;」の行として見える。手で書いてもよい。
 */

export const BLANK_PARAGRAPH = '&nbsp;';

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * エディタが書き出したMarkdownの、空行の重なり(空の段落)を、「&nbsp;」だけの段落にする。
 * エディタは、段落の間を1つの空行で区切って書き出すため、空の段落が k 個あると、空行は 1+2k 行になる。
 * コードフェンスの内側は、そのまま。文書の先頭の空の段落も、書き出す。文書の末尾の空行は、そのまま
 * (末尾の空の段落は、見た目に影響しないうえ、エディタが、末尾に自動で置くことがあるため、書き出さない)。
 */
export function blankParagraphsToNbsp(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let fence: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const match = FENCE_LINE.exec(line);
    if (match) {
      const marker = match[1] ?? null;
      if (fence === null) {
        fence = marker;
      } else if (marker === fence) {
        fence = null;
      }
    }
    if (fence !== null || match !== null || !isBlank(line)) {
      result.push(line);
      index += 1;
      continue;
    }
    // 空行の連なり(lines[index] から end の手前まで)
    let end = index;
    while (end < lines.length && isBlank(lines[end] as string)) {
      end += 1;
    }
    const length = end - index;
    const atStart = index === 0;
    const atEnd = end === lines.length;
    if (atEnd) {
      result.push(...lines.slice(index, end));
    } else if (atStart) {
      // 先頭: 空の段落 k 個 = 空行 2k 行(段落の後ろの区切り)
      const count = Math.floor(length / 2);
      for (let k = 0; k < count; k += 1) {
        result.push(BLANK_PARAGRAPH, '');
      }
      result.push(...Array<string>(length - count * 2).fill(''));
    } else {
      // 途中: 区切りの空行1行と、空の段落 k 個(それぞれ、「&nbsp;」の行と区切りの空行)。余った空行は、そのまま
      const count = Math.max(0, Math.floor((length - 1) / 2));
      result.push('');
      for (let k = 0; k < count; k += 1) {
        result.push(BLANK_PARAGRAPH, '');
      }
      result.push(...Array<string>(length - 1 - count * 2).fill(''));
    }
    index = end;
  }
  return result.join('\n');
}
