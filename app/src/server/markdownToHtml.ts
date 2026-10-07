import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { all as allLanguages } from 'lowlight';
import { visit, SKIP } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import type { Root as MdastRoot, Code, Heading, Image, Paragraph, PhrasingContent, RootContent } from 'mdast';
import type { Element as HastElement, Root as HastRoot } from 'hast';
import { classifyReference } from '../shared/assetPath.js';
import { parseImageTags, type ImageTag } from '../shared/imageTag.js';
import { diagramViewOf, isMermaidLanguage, sizedSvg, type DiagramOutcome } from '../shared/mermaid.js';
import { isPageBreakHtml } from '../shared/pageBreak.js';
import { bodyHeightMm, DEFAULT_PAGE_SETTINGS, type PageSettings } from '../shared/pageSettings.js';

/*
 * Markdown → HTML(PDF用)。
 * - 生HTMLは実行も黙殺もせず、文字としてそのまま表示する(例: <br> は「<br>」と表示される)。
 *   ただし、<img> のタグだけは画像として扱う(エディタで大きさを変えた画像は、<img width="…"> の形で保存されるため)。
 *   使う属性は src・alt・title・width・height だけで、画像の扱いは、![]() の画像と同じ(下記)。
 *   もう1つの例外は、手動の改ページの印(<div style="page-break-after: always"></div>。shared/pageBreak.ts)で、
 *   文書の直下にあるものだけ、その位置で改ページする
 * - front matter(YAML)は、内容を失わないようコードブロックとして表示する
 * - 段落内の改行はすべて改行として扱う(編集画面の表示と揃えるため)
 * - リンクは http/https/mailto/tel と相対URLのみ有効。それ以外は「文字 (URL)」に置き換える
 * - 画像は、data URI(png/jpeg/gif/webp/svg)と、リクエストで渡された画像(assets)だけ表示する。
 *   それ以外(外部URL・渡されていないファイル)は「[画像: 代替文](URL)」の文字にする
 *   (svgは<img>の中では、スクリプトの実行も外部の読み込みも行われない)
 * - コードブロックは、言語名(```python など)に応じて、構文ごとに色分けする(言語名の無いものは色分けしない)。
 *   言語名が mermaid のものは、描画済みの図(diagrams)があれば、図として表示する(言語名の後ろの `show=` で、
 *   図のみ・コードのみ・両方を選べる。書かなければ図のみ)。描けなかった図は、理由を添えて、コードのまま表示する
 */

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const DATA_IMAGE_URL = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

// 色分けしない言語名(そのまま表示する)
const PLAIN_TEXT_LANGUAGES = ['txt', 'text', 'plain', 'plaintext', 'mermaid'];
// これより長いコードは、色分けに時間がかかるため、色分けしない
const MAX_HIGHLIGHT_CHARS = 100_000;

function isAllowedLink(url: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url.trim());
  return scheme === null || ALLOWED_LINK_PROTOCOLS.has((scheme[1] ?? '').toLowerCase());
}

// 改行を含む文字列を「text, break, text ...」の並びにする(HTMLでは素の改行が空白に潰れるため)
function textWithBreaks(value: string): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  value.split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push({ type: 'break' });
    }
    if (line !== '') {
      nodes.push({ type: 'text', value: line.replace(/\r$/, '') });
    }
  });
  return nodes;
}

// <img> のタグを、Markdownの画像(![]())と同じ画像にする(大きさの指定があれば、それも引き継ぐ)
function imageNodeOf(tag: ImageTag): Image {
  const size = { ...(tag.width === undefined ? {} : { width: tag.width }), ...(tag.height === undefined ? {} : { height: tag.height }) };
  return { type: 'image', url: tag.src, alt: tag.alt, title: tag.title ?? null, data: { hProperties: size } };
}

/*
 * 本文の最上位のブロック(見出し・段落・リスト・表・コード・図など)に、Markdownでの番号(0始まり)を付ける(data-block)。
 * ページの区切りの測定用(画面のプレビューは、Markdownのブロックごとに並ぶため、その番号で位置を対応づける)。
 * Mermaidの図のように、1つのブロックが、PDFでは複数の要素(コードと図、理由とコードなど)になる場合も、同じ番号を付ける。
 * PDFの文書には付けない(tagBlocks が true のときだけ)。
 */
type BlockData = { sourceBlock?: number };

// 要素のdataに、ブロック番号を加える(mdastの型は、独自の項目を持てないため、型を保ったまま、値だけを足す)
const withBlock = <T extends object | undefined>(data: T, sourceBlock: number): T => Object.assign({}, data, { sourceBlock }) as T;

function remarkMarkBlocks() {
  return (tree: MdastRoot, file: { data: object }): void => {
    if ((file.data as { tagBlocks?: boolean }).tagBlocks !== true) {
      return;
    }
    tree.children.forEach((child, index) => {
      child.data = withBlock(child.data, index);
    });
  };
}

// 置き換えた要素に、元の要素のブロック番号を引き継ぐ
function inheritBlock(from: RootContent, replacements: readonly RootContent[]): void {
  const sourceBlock = (from.data as BlockData | undefined)?.sourceBlock;
  if (sourceBlock !== undefined) {
    for (const replacement of replacements) {
      replacement.data = withBlock(replacement.data, sourceBlock);
    }
  }
}

function remarkBlocksToProperties() {
  return (tree: MdastRoot): void => {
    for (const child of tree.children) {
      const sourceBlock = (child.data as BlockData | undefined)?.sourceBlock;
      if (sourceBlock !== undefined) {
        const data = child.data as { hProperties?: Record<string, unknown> };
        data.hProperties = { ...data.hProperties, dataBlock: String(sourceBlock) };
      }
    }
  };
}

// 手動の改ページ(shared/pageBreak.ts の印)。中身の無い <div class="manual-page-break"> にする(改ページはCSSで効かせる)
function pageBreakNode(): Paragraph {
  return { type: 'paragraph', children: [], data: { hName: 'div', hProperties: { className: ['manual-page-break'] } } };
}

// 生HTML(html)とfront matter(yaml)を、実行もせず消しもしない形に置き換える。<img> のタグは画像に、改ページの印は改ページにする
function remarkNeutralizeRawContent() {
  return (tree: MdastRoot): void => {
    visit(tree, (node, index, parent) => {
      if (parent === undefined || index === undefined) {
        return undefined;
      }
      let replacement: RootContent[];
      if (node.type === 'html') {
        if (parent.type === 'root' && isPageBreakHtml(node.value)) {
          // 改ページは、文書の直下に書かれたものだけ(段落の途中の <div> や、リスト・引用の中では、文字のまま)
          replacement = [pageBreakNode()];
          inheritBlock(node as RootContent, replacement);
          parent.children.splice(index, 1, ...(replacement as typeof parent.children));
          return [SKIP, index + replacement.length];
        }
        const images = parseImageTags(node.value)?.map(imageNodeOf);
        const inline = images ?? textWithBreaks(node.value);
        replacement = FLOW_PARENTS.has(parent.type) ? [{ type: 'paragraph', children: inline }] : inline;
      } else if (node.type === 'yaml') {
        replacement = [{ type: 'code', lang: 'yaml', value: node.value }];
      } else {
        return undefined;
      }
      inheritBlock(node as RootContent, replacement);
      parent.children.splice(index, 1, ...(replacement as typeof parent.children));
      return [SKIP, index + replacement.length];
    });
  };
}

// Markdownの中の相対パスの画像に使える、画像の一覧。キーは、取り込んだ一式のルートからの相対パス
export interface MarkdownAssets {
  // Markdownがあるフォルダ(相対パスの基準)
  readonly baseDir: string;
  // パス -> data URI。値は、使う前に検査する(クライアントから渡されたものを信用しない)
  readonly files: Readonly<Record<string, string>>;
}

// 画像のsrcを、表示してよいdata URIにする。表示できなければ undefined
function displayableImage(src: string, assets: MarkdownAssets | undefined): string | undefined {
  if (DATA_IMAGE_URL.test(src)) {
    return src;
  }
  if (assets === undefined) {
    return undefined;
  }
  const reference = classifyReference(src, assets.baseDir);
  if (reference.kind !== 'local' || reference.path === null) {
    return undefined;
  }
  const uri = Object.hasOwn(assets.files, reference.path) ? assets.files[reference.path] : undefined;
  return uri !== undefined && DATA_IMAGE_URL.test(uri) ? uri : undefined;
}

// 参照形式(定義+参照)や自動リンクを含め、HTMLに変換された後のURLをまとめて検査する
function rehypeNeutralizeUrls() {
  return (tree: HastRoot, file: { data: object }): void => {
    const assets = (file.data as { markdownAssets?: MarkdownAssets }).markdownAssets;
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName === 'a') {
        const href = node.properties['href'];
        if (typeof href === 'string' && !isAllowedLink(href)) {
          delete node.properties['href'];
          node.children.push({ type: 'text', value: ` (${href})` });
        }
        return undefined;
      }
      if (node.tagName === 'img' && parent !== undefined && index !== undefined) {
        const src = node.properties['src'];
        const displayable = typeof src === 'string' ? displayableImage(src, assets) : undefined;
        if (displayable !== undefined) {
          node.properties['src'] = displayable;
          return undefined;
        }
        const alt = typeof node.properties['alt'] === 'string' ? node.properties['alt'] : '';
        parent.children.splice(index, 1, { type: 'text', value: `[画像: ${alt}](${String(src ?? '')})` });
        return [SKIP, index + 1];
      }
      return undefined;
    });
  };
}

// 描画済みのMermaidの図。キーは、コードブロックの中身(図のコード)
export type DiagramMap = ReadonlyMap<string, DiagramOutcome>;

const svgDataUri = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

function diagramFigure(outcome: DiagramOutcome & { ok: true }): Paragraph | null {
  const sized = sizedSvg(outcome.svg);
  if (sized === null) {
    return null;
  }
  const image: HastElement = {
    type: 'element',
    tagName: 'img',
    properties: { src: svgDataUri(sized.svg), width: sized.width, height: sized.height, alt: 'Mermaidの図' },
    children: [],
  };
  // 空の段落を、図(figure)として出力する
  return { type: 'paragraph', children: [], data: { hName: 'figure', hProperties: { className: ['mermaid-diagram'] }, hChildren: [image] } };
}

function failureNote(message: string): Paragraph {
  return {
    type: 'paragraph',
    children: [{ type: 'text', value: `Mermaidの図を描画できなかったため、コードのまま表示します(${message})` }],
    data: { hProperties: { className: ['diagram-error'] } },
  };
}

// 描画済みの図(diagrams)を、mermaidのコードブロックの代わりに置く。表示は、コードブロックごとの選択(show=)に従う。
// 描けなかった図は、選択に関わらず、理由を添えてコードを残す
function remarkMermaidDiagrams() {
  return (tree: MdastRoot, file: { data: object }): void => {
    const diagrams = (file.data as { diagrams?: DiagramMap }).diagrams;
    if (diagrams === undefined) {
      return;
    }
    visit(tree, 'code', (node: Code, index, parent) => {
      const view = diagramViewOf(node.meta);
      const outcome = isMermaidLanguage(node.lang) && view !== 'code' ? diagrams.get(node.value) : undefined;
      if (outcome === undefined || parent === undefined || index === undefined) {
        return undefined;
      }
      const figure = outcome.ok ? diagramFigure(outcome) : null;
      let replacement: RootContent[];
      if (figure === null) {
        replacement = [failureNote(outcome.ok ? '図の大きさを取得できません' : outcome.message), node];
      } else {
        // 両方のときは、エディタと同じ並び(コードの下に図)にする
        replacement = view === 'both' ? [node, figure] : [figure];
      }
      inheritBlock(node, replacement);
      parent.children.splice(index, 1, ...(replacement as typeof parent.children));
      return [SKIP, index + replacement.length];
    });
  };
}

// コードブロックでは、ブロック番号の属性が、<pre> の中の <code> に付くため、<pre>(最上位の要素)へ移す
function rehypeLiftBlockNumber() {
  return (tree: HastRoot): void => {
    for (const child of tree.children) {
      if (child.type === 'element' && child.tagName === 'pre') {
        const code = child.children.find((node): node is HastElement => node.type === 'element' && node.tagName === 'code');
        if (code?.properties['dataBlock'] !== undefined) {
          child.properties['dataBlock'] = code.properties['dataBlock'];
          delete code.properties['dataBlock'];
        }
      }
    }
  };
}

// 長すぎるコードは色分けの対象から外す(rehype-highlightは、no-highlightクラスのコードを飛ばす)
function rehypeSkipHugeCode() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'pre') {
        const code = node.children.find((child): child is HastElement => child.type === 'element' && child.tagName === 'code');
        if (code !== undefined && toString(code).length > MAX_HIGHLIGHT_CHARS) {
          const classes = Array.isArray(code.properties['className']) ? code.properties['className'] : [];
          code.properties['className'] = [...classes, 'no-highlight'];
        }
      }
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMarkBlocks)
  .use(remarkNeutralizeRawContent)
  .use(remarkMermaidDiagrams)
  .use(remarkBlocksToProperties)
  .use(remarkRehype)
  .use(rehypeNeutralizeUrls)
  .use(rehypeLiftBlockNumber)
  .use(rehypeSkipHugeCode)
  // 言語名が登録されていないコードは、そのまま表示される(エラーにならない)
  .use(rehypeHighlight, { languages: allLanguages, plainText: PLAIN_TEXT_LANGUAGES })
  .use(rehypeStringify)
  .freeze();

const UNTITLED = '無題';

function extractTitle(tree: MdastRoot): string {
  let title = UNTITLED;
  visit(tree, 'heading', (node: Heading) => {
    if (node.depth === 1) {
      title = toString(node).trim() || UNTITLED;
      return false;
    }
    return undefined;
  });
  return title;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RenderedMarkdown {
  readonly title: string;
  readonly bodyHtml: string;
}

export interface RenderOptions {
  // 最上位のブロックに、Markdownでの番号(data-block)を付ける(ページの区切りの測定用。PDFには付けない)
  readonly tagBlocks?: boolean;
  // ページ設定(buildDocumentHtml だけが使う。用紙の本文の高さを、文書のCSSの変数 --page-body-height にする)
  readonly pageSettings?: PageSettings;
}

export function renderMarkdown(markdown: string, assets?: MarkdownAssets, diagrams?: DiagramMap, options?: RenderOptions): RenderedMarkdown {
  const mdast = processor.parse(markdown);
  const title = extractTitle(mdast);
  const hast = processor.runSync(mdast, { data: { markdownAssets: assets, diagrams, tagBlocks: options?.tagBlocks === true } }) as HastRoot;
  return { title, bodyHtml: String(processor.stringify(hast)) };
}

/** Markdownの中の、図にするMermaidのコード(コードブロックの中身)。文書の上から順に、同じ内容は1つにまとめる。コードだけを表示する指定(show=code)のものは、図にしないため含めない */
export function extractMermaidSources(markdown: string): string[] {
  const sources = new Set<string>();
  visit(processor.parse(markdown), 'code', (node: Code) => {
    if (isMermaidLanguage(node.lang) && diagramViewOf(node.meta) !== 'code') {
      sources.add(node.value);
    }
  });
  return [...sources];
}

// PDF化するHTML全体。メタタグのCSPは、Chromium側の通信遮断に加えた二重の防御
export function buildDocumentHtml(markdown: string, css: string, assets?: MarkdownAssets, diagrams?: DiagramMap, options?: RenderOptions): string {
  const { title, bodyHtml } = renderMarkdown(markdown, assets, diagrams, options);
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${css}</style>`,
    // 縦長の図を、1ページに収まる大きさにするための、本文の高さ(document.css が使う)
    `<style>:root{--page-body-height:${bodyHeightMm(options?.pageSettings ?? DEFAULT_PAGE_SETTINGS)}mm}</style>`,
    `</head><body class="document">${bodyHtml}</body></html>`,
  ].join('');
}
