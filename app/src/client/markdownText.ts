/*
 * Markdownを行単位で扱うための共通部品。
 * コードフェンス(``` / ~~~)の内側と、インラインコード(`...`)の内側は、
 * エスケープや記法チェックの対象外とするために、ここで切り分ける。
 */

export const FENCE_LINE = /^\s{0,3}(```|~~~)/;

// フェンスの開始行・終了行・内側はそのまま、外側の行だけに変換を適用する
export function mapLinesOutsideFences(markdown: string, transform: (line: string) => string): string {
  let fenceMarker: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const match = FENCE_LINE.exec(line);
      if (match) {
        const marker = match[1] ?? null;
        if (fenceMarker === null) {
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          fenceMarker = null;
        }
        return line;
      }
      return fenceMarker === null ? transform(line) : line;
    })
    .join('\n');
}

// フェンスの外側の行を、行番号(1始まり)つきで順に渡す
export function forEachLineOutsideFences(markdown: string, visit: (line: string, lineNumber: number) => void): void {
  let lineNumber = 0;
  mapLinesOutsideFences(markdown, (line) => {
    lineNumber += 1;
    visit(line, lineNumber);
    return line;
  });
}

export interface InlineSegment {
  readonly text: string;
  // true ならインラインコード(前後のバッククォートを含む)
  readonly code: boolean;
}

// 直前に奇数個のバックスラッシュがあれば、その文字はエスケープされている
function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line.charAt(i) === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

// 行をインラインコードとそれ以外に分ける。同じ長さのバッククォート列で閉じられたものだけをコードとみなす。
// 行をまたぐインラインコードは扱わない(行単位で処理するため)
export function splitInlineCode(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let plain = '';
  let index = 0;

  while (index < line.length) {
    if (line.charAt(index) !== '`' || isEscaped(line, index)) {
      plain += line.charAt(index);
      index += 1;
      continue;
    }
    let runEnd = index;
    while (line.charAt(runEnd) === '`') {
      runEnd += 1;
    }
    const runLength = runEnd - index;

    let closeStart = -1;
    let searchFrom = runEnd;
    while (searchFrom < line.length) {
      const next = line.indexOf('`', searchFrom);
      if (next === -1) {
        break;
      }
      let nextEnd = next;
      while (line.charAt(nextEnd) === '`') {
        nextEnd += 1;
      }
      if (nextEnd - next === runLength) {
        closeStart = next;
        break;
      }
      searchFrom = nextEnd;
    }

    if (closeStart === -1) {
      plain += line.slice(index, runEnd);
      index = runEnd;
      continue;
    }
    if (plain !== '') {
      segments.push({ text: plain, code: false });
      plain = '';
    }
    const codeEnd = closeStart + runLength;
    segments.push({ text: line.slice(index, codeEnd), code: true });
    index = codeEnd;
  }

  if (plain !== '') {
    segments.push({ text: plain, code: false });
  }
  return segments;
}

// インラインコード以外の部分だけに変換を適用する
export function mapOutsideInlineCode(line: string, transform: (text: string) => string): string {
  return splitInlineCode(line)
    .map((segment) => (segment.code ? segment.text : transform(segment.text)))
    .join('');
}
