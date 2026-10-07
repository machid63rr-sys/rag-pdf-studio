import { parse, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';

/*
 * プレビューで編集した内容を、元のHTMLソースへ「変更した箇所だけ」反映する。
 *
 * 編集後のDOM全体からHTMLを作り直すと、インデント・属性の引用符・実体参照(&amp; など)・
 * 省略されたタグなど、利用者が触っていない部分まで書き換わってしまう。そこで、
 *   1. 元のソースをパースし、各ノードがソースのどの範囲にあたるか(位置情報)を得る
 *   2. 編集後のHTMLをパースし、元の木と見比べて、違う箇所を探す
 *   3. 違う箇所のソース範囲だけを、編集後の内容で置き換える
 * という手順にする。編集していなければ、結果は元のソースと1文字も変わらない。
 *
 * 比較の対象は <body> の中身だけ(プレビューで編集できるのは本文だけのため)。
 */

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

interface Patch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

// 位置を特定できず、ソースの一部だけを置き換えられない場合
class Unpatchable extends Error {}

export interface PatchResult {
  readonly html: string;
  // 差分が細かく特定できず、本文全体を書き直した場合 true(通常はfalse)
  readonly rewroteBody: boolean;
}

// parse5は、</body></html> の前後の空白を1つのテキストノードにまとめ、その範囲がタグをまたぐことがある
const TAG_LIKE = /<\/?[A-Za-z]|<!--|<\?|<!/;

const isElement = (node: Node): node is Element => 'tagName' in node;
const isText = (node: Node): node is TextNode => node.nodeName === '#text';
const isComment = (node: Node): boolean => node.nodeName === '#comment';

function childrenOf(node: ParentNode): ChildNode[] {
  return node.childNodes;
}

function findBody(document: ParentNode): Element | null {
  for (const html of childrenOf(document)) {
    if (isElement(html) && html.tagName === 'html') {
      for (const child of childrenOf(html)) {
        if (isElement(child) && child.tagName === 'body') {
          return child;
        }
      }
    }
  }
  return null;
}

const attributesEqual = (a: Element, b: Element): boolean =>
  a.attrs.length === b.attrs.length && a.attrs.every((attr) => b.attrs.some((other) => other.name === attr.name && other.value === attr.value));

const sameShell = (a: Element, b: Element): boolean =>
  a.tagName === b.tagName && a.namespaceURI === b.namespaceURI && attributesEqual(a, b);

function sameNode(a: ChildNode, b: ChildNode): boolean {
  if (isText(a) && isText(b)) {
    return a.value === b.value;
  }
  if (isComment(a) && isComment(b)) {
    return (a as { data: string }).data === (b as { data: string }).data;
  }
  if (isElement(a) && isElement(b)) {
    if (!sameShell(a, b)) {
      return false;
    }
    // <style>・<script>の中身は、プレビュー用に書き換えられている(画像の埋め込みなど)ことがあり、
    // プレビュー上で編集もできないため、比べない
    if (a.tagName === 'style' || a.tagName === 'script') {
      return true;
    }
    const ac = childrenOf(a);
    const bc = childrenOf(b);
    return ac.length === bc.length && ac.every((child, index) => sameNode(child, bc[index] as ChildNode));
  }
  return false;
}

// ノードがソースで占める範囲。暗黙に補われた要素(tbodyなど)は、子の範囲の和で表す
function spanOf(node: ChildNode): Span | null {
  const location = node.sourceCodeLocation;
  if (location) {
    return { start: location.startOffset, end: location.endOffset };
  }
  if (!isElement(node)) {
    return null;
  }
  let span: Span | null = null;
  for (const child of childrenOf(node)) {
    const childSpan = spanOf(child);
    if (childSpan !== null) {
      span = span === null ? childSpan : { start: Math.min(span.start, childSpan.start), end: Math.max(span.end, childSpan.end) };
    }
  }
  return span;
}

// 子を1つも持たない要素へ内容を挿入するときの位置(開始タグの直後)
function contentStart(container: ParentNode, sourceLength: number): number {
  const location = (container as Element).sourceCodeLocation;
  if (location?.startTag) {
    return location.startTag.endOffset;
  }
  if (isElement(container as Node) && (container as Element).tagName === 'body') {
    return sourceLength; // <body>が省略された空の文書
  }
  throw new Unpatchable('挿入位置を特定できません');
}

// 元の children[prefix .. length-suffix) を、編集後のノード列で置き換えるパッチ
function replaceChildren(
  container: ParentNode,
  original: ChildNode[],
  prefix: number,
  suffix: number,
  replacement: ChildNode[],
  sourceLength: number,
): Patch {
  const text = replacement.map((node) => serializeOuter(node)).join('');
  const removed = original.slice(prefix, original.length - suffix);
  const first = removed[0];
  const last = removed[removed.length - 1];
  if (first !== undefined && last !== undefined) {
    const start = spanOf(first);
    const end = spanOf(last);
    if (start === null || end === null) {
      throw new Unpatchable('置き換える範囲を特定できません');
    }
    return { start: start.start, end: end.end, text };
  }
  const before = original[prefix - 1];
  if (before !== undefined) {
    const span = spanOf(before);
    if (span === null) {
      throw new Unpatchable('挿入位置を特定できません');
    }
    return { start: span.end, end: span.end, text };
  }
  const after = original[original.length - suffix];
  if (after !== undefined) {
    const span = spanOf(after);
    if (span === null) {
      throw new Unpatchable('挿入位置を特定できません');
    }
    return { start: span.start, end: span.start, text };
  }
  const position = contentStart(container, sourceLength);
  return { start: position, end: position, text };
}

function textPatch(source: string, original: TextNode, edited: TextNode): Patch {
  const location = original.sourceCodeLocation;
  if (!location) {
    throw new Unpatchable('テキストの位置を特定できません');
  }
  const text = serializeOuter(edited);
  const raw = source.slice(location.startOffset, location.endOffset);
  const tagAt = raw.search(TAG_LIKE);
  // 通常は範囲全体を置き換える。範囲がタグをまたぐ場合は、タグより前の文字の部分だけを置き換え、タグは残す
  return { start: location.startOffset, end: tagAt === -1 ? location.endOffset : location.startOffset + tagAt, text };
}

function diffChildren(source: string, original: ParentNode, edited: ParentNode): Patch[] {
  const oc = childrenOf(original);
  const ec = childrenOf(edited);

  let prefix = 0;
  while (prefix < oc.length && prefix < ec.length && sameNode(oc[prefix] as ChildNode, ec[prefix] as ChildNode)) {
    prefix += 1;
  }
  if (prefix === oc.length && prefix === ec.length) {
    return [];
  }
  let suffix = 0;
  while (
    suffix < oc.length - prefix &&
    suffix < ec.length - prefix &&
    sameNode(oc[oc.length - 1 - suffix] as ChildNode, ec[ec.length - 1 - suffix] as ChildNode)
  ) {
    suffix += 1;
  }

  const removed = oc.slice(prefix, oc.length - suffix);
  const added = ec.slice(prefix, ec.length - suffix);
  const [x] = removed;
  const [y] = added;
  if (removed.length === 1 && added.length === 1 && x !== undefined && y !== undefined) {
    // 違いが1つの子にだけある場合は、その子の中へ入って、さらに範囲を絞る
    if (isText(x) && isText(y)) {
      return [textPatch(source, x, y)];
    }
    if (isElement(x) && isElement(y) && sameShell(x, y)) {
      return diffChildren(source, x, y);
    }
  }
  return [replaceChildren(original, oc, prefix, suffix, added, source.length)];
}

function applyPatches(source: string, patches: readonly Patch[]): string {
  return [...patches]
    .sort((a, b) => b.start - a.start)
    .reduce((result, patch) => result.slice(0, patch.start) + patch.text + result.slice(patch.end), source);
}

/**
 * 元のHTMLソース(source)に、編集後のHTML(editedHtml。プレビューの現在の文書全体)との差分を反映する。
 * editedHtml が <!doctype> を含まない場合は、元の文書と解釈の仕方(標準/互換モード)が変わらないよう、
 * 呼び出し側で元と同じ <!doctype> を付けること。
 */
export function patchHtmlSource(source: string, editedHtml: string): PatchResult {
  const originalBody = findBody(parse(source, { sourceCodeLocationInfo: true }));
  const editedBody = findBody(parse(editedHtml));
  if (originalBody === null || editedBody === null) {
    return { html: source, rewroteBody: false };
  }
  try {
    return { html: applyPatches(source, diffChildren(source, originalBody, editedBody)), rewroteBody: false };
  } catch (cause) {
    if (!(cause instanceof Unpatchable)) {
      throw cause;
    }
    // 位置を特定できない構造(特殊な省略タグなど)の場合は、本文全体を書き換える
    const all = childrenOf(originalBody);
    const patch = replaceChildren(originalBody, all, 0, 0, childrenOf(editedBody), source.length);
    return { html: applyPatches(source, [patch]), rewroteBody: true };
  }
}
