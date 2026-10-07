import { FENCE_LINE } from './markdownText';

/**
 * 本文中の「表として解釈できない表形式の行」を検出する。
 *
 * 見出し行と区切り行の列数が食い違うなどして、GFM(Markdownの表記法)が表と認識できない形になると、
 * 書式付きエディタでは「| a | b |」というパイプ付きの生テキストとして表示され、解釈エラーにもならないため
 * 利用者が気づきにくい。編集中の本文から毎回検出して警告に使う。
 *
 * 判定は、行頭が「|」の連続を1つのまとまりとして、1行目が見出し行・2行目が列数の等しい区切り行なら
 * 表として成立、とする。コードフェンス内は対象外。
 */

export interface BrokenTable {
  // 本文中の行番号(1始まり)。崩れたまとまりの先頭行
  line: number;
  // 先頭行の抜粋(Markdown構文モードで該当箇所を探すための手がかり)
  excerpt: string;
}

const DELIMITER_CELL = /^:?-+:?$/;
const EXCERPT_MAX_LENGTH = 40;

const startsTable = (line: string): boolean => line.trim().startsWith('|');

// 「\|」(エスケープされたパイプ)ではセルを分割しない。ルックビハインド正規表現は使わず、文字を順に走査する
function splitCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) {
    body = body.slice(1);
  }
  if (body.endsWith('|') && !body.endsWith('\\|')) {
    body = body.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body.charAt(i);
    if (char === '\\' && body.charAt(i + 1) === '|') {
      current += '\\|';
      i += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

const isDelimiterRow = (line: string): boolean =>
  startsTable(line) && splitCells(line).every((cell) => DELIMITER_CELL.test(cell));

// 1行目が見出し行、2行目が列数の等しい区切り行であれば、表として成立している
function startsWithValidTable(run: string[]): boolean {
  const [header, delimiter] = run;
  return (
    header !== undefined &&
    delimiter !== undefined &&
    isDelimiterRow(delimiter) &&
    splitCells(header).length === splitCells(delimiter).length
  );
}

function toExcerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > EXCERPT_MAX_LENGTH ? `${trimmed.slice(0, EXCERPT_MAX_LENGTH)}…` : trimmed;
}

export function findBrokenTables(markdown: string): BrokenTable[] {
  const lines = markdown.split('\n');
  const broken: BrokenTable[] = [];
  let fenceMarker: string | null = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? null;
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        fenceMarker = null;
      }
      index += 1;
      continue;
    }
    if (fenceMarker !== null || !startsTable(line)) {
      index += 1;
      continue;
    }

    let end = index;
    while (end < lines.length && startsTable(lines[end] ?? '')) {
      end += 1;
    }
    const run = lines.slice(index, end);
    // 行頭が「|」の1行だけのまとまりは、セルが2つ以上あるときだけ表の崩れとみなす
    // (見出し行だけが残り、区切り行との間に別の行が割り込んだ場合など)
    const looksLikeTable = run.length >= 2 || splitCells(run[0] ?? '').length >= 2;
    if (looksLikeTable && !startsWithValidTable(run)) {
      broken.push({ line: index + 1, excerpt: toExcerpt(run[0] ?? '') });
    }
    index = end;
  }

  return broken;
}
