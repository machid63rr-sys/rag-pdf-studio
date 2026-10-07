import type { PageLayout, PageStart } from '../shared/pageLayout';

/*
 * サーバが測った、PDFのページの区切り位置(PageLayout)を、編集画面のプレビュー(Markdownを書式付きで表示したDOM)の
 * 上の位置に対応づける。
 *
 * プレビューの上端の要素は、Markdownの最上位のブロック(見出し・段落・リスト・表・コード・図・水平線など)と、
 * 同じ順序で並ぶ。位置は、ブロックの番号と、ブロックの中の位置(空白を除いた文字の数・表の行・コードの行)で表されているため、
 * プレビューの文字の折り返しやフォントが、PDFと違っても、「同じ文字・同じ行の前」に区切りを置ける。
 */

export interface PageMarker {
  // この線から始まるページの番号
  readonly page: number;
  // 線の位置。プレビューの(スクロールする)内容の上端からの距離(px)
  readonly y: number;
}

export interface LocatedPageBreaks {
  readonly markers: readonly PageMarker[];
  // プレビューの上に、位置を見つけられなかった区切りの数(プレビューの構造が、PDFと対応しなかった場合)
  readonly unplaced: number;
}

const WHITESPACE = /\s/;

/**
 * 文字列の並び(プレビューのテキストノードの文字列)の中の、空白を除いて n 文字目(0始まり)の位置。
 * 空白は、プレビューとPDFで、有無・幅が違うことがあるため、数えない(サーバも同じ数え方)。
 */
export function findNonWhitespaceChar(texts: readonly string[], n: number): { readonly text: number; readonly index: number } | null {
  let count = 0;
  for (const [textIndex, text] of texts.entries()) {
    for (let index = 0; index < text.length; index += 1) {
      if (!WHITESPACE.test(text.charAt(index))) {
        if (count === n) {
          return { text: textIndex, index };
        }
        count += 1;
      }
    }
  }
  return null;
}

// プレビューの部品(ボタン・アイコン・コードの行番号・表の操作用のセル・Mermaidの表示の選択)の文字は、本文ではない
const NOT_CONTENT = 'button, svg, style, script, .cm-gutters, [data-tool-cell], .mermaid-view, [contenteditable="false"]';

function contentTextNodes(block: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(NOT_CONTENT) === null) {
      nodes.push(node as Text);
    }
  }
  return nodes;
}

function charRect(node: Text, index: number): DOMRect | null {
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  return range.getClientRects()[0] ?? null;
}

// 前の要素の下端と、次の要素の上端の間(余白の真ん中)。前が無ければ、次の上端
const between = (previous: { readonly bottom: number } | null, next: { readonly top: number }): number =>
  previous === null ? next.top : (previous.bottom + next.top) / 2;

// PDFでのタグと、プレビューの要素が、同じブロックを指しているか(違えば、位置の対応が信用できない)
function isSameBlock(tag: string, element: Element): boolean {
  // Mermaidの図は、PDFでは複数の要素(コード・図・理由)になるが、プレビューでは1つのブロック
  if (element.querySelector('.mermaid-block') !== null) {
    return true;
  }
  switch (tag) {
    case 'table':
      return element.querySelector('table') !== null;
    case 'pre':
      return element.querySelector('.cm-editor') !== null;
    case 'hr':
      return element.tagName === 'HR' || element.querySelector('hr') !== null;
    case 'figure':
      return false;
    default:
      return element.tagName.toLowerCase() === tag;
  }
}

// 区切りの、直前の要素の下端(top 側が、新しいページの最初)。見つからなければ null
function boundaryOf(start: PageStart, block: HTMLElement, previousBlock: Element | null): number | null {
  if (block.querySelector('.mermaid-block') !== null) {
    // コードと図の両方を出す場合の、図の手前。それ以外は、ブロックの先頭
    const preview = block.querySelector('.mermaid-preview');
    if (start.tag === 'figure' && preview !== null) {
      const code = block.querySelector('.cm-editor');
      return between(code?.getBoundingClientRect() ?? null, preview.getBoundingClientRect());
    }
    return between(previousBlock?.getBoundingClientRect() ?? null, block.getBoundingClientRect());
  }
  switch (start.kind) {
    case 'start':
      return between(previousBlock?.getBoundingClientRect() ?? null, block.getBoundingClientRect());
    case 'row': {
      // 表の操作用の行(ボタンだけの行。先頭の空のセルは、操作用の印が無いため、印では見分けられない)は、数えない。
      // 内容の行は、編集できるセル(Lexicalのエディタ)を持つ
      const rows = [...block.querySelectorAll('tr')].filter((row) => row.querySelector('[data-lexical-editor]') !== null);
      const row = rows[start.index];
      return row === undefined ? null : between(rows[start.index - 1]?.getBoundingClientRect() ?? null, row.getBoundingClientRect());
    }
    case 'line': {
      const lines = block.querySelectorAll('.cm-line');
      const line = lines[start.index];
      return line === undefined ? null : between(lines[start.index - 1]?.getBoundingClientRect() ?? null, line.getBoundingClientRect());
    }
    case 'text': {
      const nodes = contentTextNodes(block);
      const texts = nodes.map((node) => node.data);
      const target = findNonWhitespaceChar(texts, start.offset);
      if (target === null) {
        return null;
      }
      const next = charRect(nodes[target.text] as Text, target.index);
      const before = findNonWhitespaceChar(texts, start.offset - 1);
      const previous = before === null ? null : charRect(nodes[before.text] as Text, before.index);
      if (next === null) {
        return null;
      }
      // プレビューの折り返しが、PDFと違い、区切りの文字が、行の途中になる場合は、その行の下に線を引く
      if (previous !== null && previous.bottom > next.top + 1) {
        return Math.max(previous.bottom, next.bottom);
      }
      return between(previous, next);
    }
  }
}

/**
 * ページの区切り(layout)を、プレビュー(root。Markdownの最上位のブロックが並ぶ要素)の上の位置にする。
 * root がスクロールしていても、位置は、内容の上端からの距離になる(スクロールに依らない)。
 */
export function locatePageBreaks(root: HTMLElement, layout: PageLayout): LocatedPageBreaks {
  const blocks = [...root.children] as HTMLElement[];
  const top = root.getBoundingClientRect().top - root.scrollTop;
  const markers: PageMarker[] = [];
  let unplaced = 0;
  for (const start of layout.starts) {
    const block = blocks[start.block];
    const y = block !== undefined && isSameBlock(start.tag, block) ? boundaryOf(start, block, blocks[start.block - 1] ?? null) : null;
    if (y === null) {
      unplaced += 1;
    } else {
      markers.push({ page: start.page, y: y - top });
    }
  }
  return { markers, unplaced };
}
