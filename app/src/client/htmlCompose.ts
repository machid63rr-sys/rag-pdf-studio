import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { dirnameOf } from '../shared/assetPath';
import { isImagePath, type AssetStore } from './assets';
import type { Stylesheet } from './documents';

/*
 * 取り込んだHTMLと、一緒に取り込んだCSS・画像から、プレビュー・PDF生成に使う「ひとつの文書」を作る。
 *
 * 元のHTMLを作り直さず、挿入・置換する位置だけをソース上で特定して差し込む。
 * (書き直すと、プレビューのDOMと元のHTMLの構造がずれ、編集内容を元のHTMLへ反映できなくなるため)
 *
 * - <link rel="stylesheet"> のCSSは、その位置へ埋め込む
 * - 画像(<img src>・srcset・poster・CSSの url(…))は、取り込んだファイルがあれば、プレビューではblob URL、
 *   PDFではdata: URI に置き換える。これは描画のための内部の処理で、保存するHTML・CSSは変わらない
 */

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ComposeContext {
  readonly assets: AssetStore;
  // HTMLのフォルダ。HTML内の相対パスの基準
  readonly baseDir: string;
}

export interface ComposeOptions {
  // true: プレビュー用。外部への通信を禁じるCSP・メタリフレッシュの除去・元の値を残す印を加える
  readonly preview: boolean;
}

export interface ComposedDocument {
  readonly html: string;
  // HTML・CSSが参照している画像(取り込んだ一式の中のパス)。読み込み済みでなくても含む
  readonly imagePaths: readonly string[];
}

// 画像の参照を置き換えた属性には、元の値をこの接頭辞つきの属性で残す(例: data-mdp-orig-src)。
// プレビューでの編集を元のHTMLへ反映するときに、元の値へ戻して比べるため
export const ORIGINAL_ATTRIBUTE_PREFIX = 'data-mdp-orig-';

// プレビューは、サーバ側のPDF生成(JS無効・外部通信遮断)と同じく、外部へ一切通信させない(取り込んだ画像のblob URLだけ許可する)
const PREVIEW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

// 画像を読み込む属性。要素ごとに、読み込みに使われるものだけを見る
const IMAGE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['poster'],
  input: ['src'],
};

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;

const isElement = (node: Node): node is Element => 'tagName' in node;
const childrenOf = (node: ParentNode): Node[] => node.childNodes as Node[];

export const attributeOf = (element: Element, name: string): string | undefined =>
  element.attrs.find((attr) => attr.name === name)?.value;

export const isStylesheetLink = (element: Element): boolean =>
  element.tagName === 'link' &&
  (attributeOf(element, 'rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet') &&
  attributeOf(element, 'href') !== undefined;

/** HTMLの <link href> が指しているCSS(取り込んだもの)を探す */
export function findStylesheet(href: string, stylesheets: readonly Stylesheet[], context: ComposeContext): Stylesheet | undefined {
  const path = context.assets.resolve(href, context.baseDir);
  return path === undefined ? undefined : stylesheets.find((stylesheet) => stylesheet.path === path);
}

export function walkElements(node: ParentNode, visit: (element: Element, insideHead: boolean) => void, insideHead = false): void {
  for (const child of childrenOf(node)) {
    if (isElement(child)) {
      visit(child, insideHead);
      walkElements(child, visit, insideHead || child.tagName === 'head');
    }
  }
}

function childElement(parent: ParentNode, tagName: string): Element | undefined {
  return childrenOf(parent).find((child): child is Element => isElement(child) && child.tagName === tagName);
}

// 本文(body)の最初の内容の位置。本文が空なら文書の末尾
function bodyContentStart(body: Element | undefined, sourceLength: number): number {
  if (body === undefined) {
    return sourceLength;
  }
  const startTag = body.sourceCodeLocation?.startTag;
  if (startTag) {
    return startTag.startOffset;
  }
  for (const child of childrenOf(body)) {
    const location = (child as { sourceCodeLocation?: { startOffset: number } | null }).sourceCodeLocation;
    if (location) {
      return location.startOffset;
    }
  }
  return sourceLength;
}

interface DocumentPositions {
  // <head>の先頭(ここへ挿入した要素は、必ずheadに入る)
  readonly headStart: number;
  // </head>の直前(ここへ挿入した<style>は、headに入り、本文より前に置かれる)
  readonly headEnd: number;
}

function documentPositions(document: ParentNode, sourceLength: number): DocumentPositions {
  const html = childElement(document, 'html');
  const head = html && childElement(html, 'head');
  const body = html && childElement(html, 'body');

  let headStart = 0;
  const headStartTag = head?.sourceCodeLocation?.startTag;
  const htmlStartTag = html?.sourceCodeLocation?.startTag;
  if (headStartTag) {
    headStart = headStartTag.endOffset;
  } else if (htmlStartTag) {
    headStart = htmlStartTag.endOffset;
  } else {
    const doctype = childrenOf(document).find((child) => child.nodeName === '#documentType');
    headStart = (doctype as { sourceCodeLocation?: { endOffset: number } | null } | undefined)?.sourceCodeLocation?.endOffset ?? 0;
  }

  const headEndTag = head?.sourceCodeLocation?.endTag;
  const headEnd = headEndTag ? headEndTag.startOffset : bodyContentStart(body, sourceLength);
  return { headStart, headEnd: Math.max(headEnd, headStart) };
}

// <style>の中では「</style」が文字列として現れてはならない(CSSとしては意味を持たないため、無害な形にする)
const styleElement = (css: string): string => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function applyEdits(source: string, edits: readonly Edit[]): string {
  return edits
    .map((edit, order) => ({ edit, order }))
    .sort((a, b) => b.edit.start - a.edit.start || b.order - a.order)
    .reduce((result, { edit }) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), source);
}

/**
 * HTMLに、取り込んだCSS・画像を適用した文書を返す。
 * - <head>内の <link rel="stylesheet" href="…"> のうち、取り込んだCSSを指すものは、その位置へCSSを埋め込む
 * - <body>内の <link> や、どの <link> にも参照されていないCSSは、<head>の末尾へ追加する
 * - プレビュー用には、外部通信を禁じるCSPを加え、メタリフレッシュ(別ページへの自動移動)を除く
 */
export function composeDocument(
  source: string,
  stylesheets: readonly Stylesheet[],
  context: ComposeContext,
  options: ComposeOptions,
): ComposedDocument {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const positions = documentPositions(document, source.length);
  const edits: Edit[] = [];
  const used = new Set<Stylesheet>();
  const appended: Stylesheet[] = [];
  const imagePaths = new Set<string>();

  // 参照を、読み込み済みの画像のURLにする(プレビューはblob URL、PDFはdata: URI)。
  // 読み込み前や、画像でない場合は undefined(参照した画像のパスは記録する)
  const imageUrlFor = (reference: string, baseDir: string): string | undefined => {
    const path = context.assets.resolve(reference, baseDir);
    if (path === undefined || !isImagePath(path)) {
      return undefined;
    }
    imagePaths.add(path);
    return options.preview ? context.assets.previewUrl(path) : context.assets.dataUri(path);
  };

  const rewriteCss = (css: string, baseDir: string): string =>
    css.replace(CSS_URL, (whole, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const uri = imageUrlFor(double ?? single ?? bare ?? '', baseDir);
      return uri === undefined ? whole : `url("${uri}")`;
    });

  // srcset("a.png 1x, b.png 2x")の、URLの部分だけを置き換える。1つも置き換えなければ undefined
  const rewriteSrcset = (value: string): string | undefined => {
    let changed = false;
    const candidates = value.split(',').map((candidate) => {
      const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
      const uri = imageUrlFor(url, context.baseDir);
      if (uri === undefined) {
        return candidate.trim();
      }
      changed = true;
      return [uri, ...descriptor].join(' ');
    });
    return changed ? candidates.join(', ') : undefined;
  };

  // 同じ位置への挿入は、先に追加したものが前に並ぶ。CSPは、どの要素よりも先に置く
  if (options.preview) {
    edits.push({
      start: positions.headStart,
      end: positions.headStart,
      text: `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    });
  }

  const replaceAttribute = (element: Element, name: string, newValue: string): void => {
    const location = element.sourceCodeLocation?.attrs?.[name];
    const original = attributeOf(element, name);
    if (!location || original === undefined) {
      return;
    }
    const marker = options.preview ? ` ${ORIGINAL_ATTRIBUTE_PREFIX}${name}="${escapeAttribute(original)}"` : '';
    edits.push({ start: location.startOffset, end: location.endOffset, text: `${name}="${escapeAttribute(newValue)}"${marker}` });
  };

  walkElements(document, (element, insideHead) => {
    const location = element.sourceCodeLocation;

    if (isStylesheetLink(element)) {
      const stylesheet = findStylesheet(attributeOf(element, 'href') ?? '', stylesheets, context);
      if (stylesheet !== undefined && !used.has(stylesheet)) {
        used.add(stylesheet);
        if (insideHead && location) {
          edits.push({ start: location.startOffset, end: location.endOffset, text: styleElement(rewriteCss(stylesheet.text, dirnameOf(stylesheet.path))) });
        } else {
          appended.push(stylesheet);
        }
      }
      return;
    }

    if (
      options.preview &&
      insideHead &&
      location &&
      element.tagName === 'meta' &&
      (attributeOf(element, 'http-equiv') ?? '').toLowerCase() === 'refresh'
    ) {
      edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
      return;
    }

    for (const name of IMAGE_ATTRIBUTES[element.tagName] ?? []) {
      const value = attributeOf(element, name);
      if (value === undefined) {
        continue;
      }
      const replaced = name === 'srcset' ? rewriteSrcset(value) : imageUrlFor(value, context.baseDir);
      if (replaced !== undefined) {
        replaceAttribute(element, name, replaced);
      }
    }

    const inlineStyle = attributeOf(element, 'style');
    if (inlineStyle !== undefined) {
      const rewritten = rewriteCss(inlineStyle, context.baseDir);
      if (rewritten !== inlineStyle) {
        replaceAttribute(element, 'style', rewritten);
      }
    }

    if (element.tagName === 'style') {
      for (const child of childrenOf(element)) {
        const textLocation = (child as { sourceCodeLocation?: { startOffset: number; endOffset: number } | null }).sourceCodeLocation;
        const value = (child as { value?: string }).value;
        if (child.nodeName === '#text' && textLocation && value !== undefined) {
          const rewritten = rewriteCss(value, context.baseDir);
          if (rewritten !== value) {
            edits.push({ start: textLocation.startOffset, end: textLocation.endOffset, text: rewritten });
          }
        }
      }
    }
  });

  for (const stylesheet of stylesheets) {
    if (!used.has(stylesheet)) {
      appended.push(stylesheet);
    }
  }
  if (appended.length > 0) {
    const text = appended.map((stylesheet) => styleElement(rewriteCss(stylesheet.text, dirnameOf(stylesheet.path)))).join('');
    edits.push({ start: positions.headEnd, end: positions.headEnd, text });
  }
  return { html: applyEdits(source, edits), imagePaths: [...imagePaths] };
}

export const composeHtml = (
  source: string,
  stylesheets: readonly Stylesheet[],
  context: ComposeContext,
  options: ComposeOptions,
): string => composeDocument(source, stylesheets, context, options).html;
