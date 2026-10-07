import { parse } from 'parse5';
import { basenameOf, classifyReference, dirnameOf, relativeWithin } from '../shared/assetPath';
import { AssetStore, isImagePath, type BundleFile } from './assets';
import { decodeUtf8Strict } from './decodeUtf8';
import type { HtmlDocument, ImportedDocument, MarkdownDocument, Stylesheet } from './documents';
import { attributeOf, isStylesheetLink, walkElements } from './htmlCompose';

/*
 * 取り込んだファイル一式から、編集する文書を決める。
 * - 文書(Markdown または HTML)は1つだけ。フォルダに複数ある場合は、どれを開くか選んでもらう
 * - HTMLは、使っているCSSと一緒に取り込む。画像は、必要になったときに読み込む(assets)
 * - フォルダごと取り込む場合は、文書内の相対パスを、フォルダ構成のとおりに解決する。
 *   ファイルを個別に選んだ場合は、フォルダ構成が分からないため、ファイル名で突き合わせる
 */

const HTML_FILE = /\.(html?|xhtml)$/i;
const MARKDOWN_FILE = /\.(md|markdown|mdown)$/i;
const CSS_FILE = /\.css$/i;

export interface ImportOptions {
  // フォルダごと取り込んだ(フォルダ構成が分かる)場合 true
  readonly structured: boolean;
  // フォルダに文書が複数あるとき、利用者が選んだ文書のパス
  readonly chosen?: string;
}

export type ImportOutcome =
  | { readonly kind: 'document'; readonly document: ImportedDocument }
  // フォルダに文書が複数ある。どれを開くかを選んで、chosen を指定してやり直す
  | { readonly kind: 'choose'; readonly candidates: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

const fail = (message: string): ImportOutcome => ({ kind: 'error', message });

class ReadError extends Error {}

async function readText(file: BundleFile): Promise<string> {
  try {
    return decodeUtf8Strict(await file.file.arrayBuffer());
  } catch (cause) {
    throw new ReadError(`「${file.path}」を読み込めませんでした。${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

// フォルダ内の文書を、浅い階層から順に並べる
const byDepthThenName = (a: string, b: string): number => a.split('/').length - b.split('/').length || a.localeCompare(b, 'ja');

// HTMLの <link rel="stylesheet" href> が指している、取り込んだCSS(HTMLに書かれた順)。href は、書かれたとおりの参照
function linkedStylesheets(html: string, baseDir: string, assets: AssetStore): Map<string, string> {
  const linked = new Map<string, string>();
  walkElements(parse(html), (element) => {
    if (!isStylesheetLink(element)) {
      return;
    }
    const href = attributeOf(element, 'href') ?? '';
    const path = assets.resolve(href, baseDir);
    if (path !== undefined && CSS_FILE.test(path) && !linked.has(path)) {
      linked.set(path, href);
    }
  });
  return linked;
}

// CSSを保存するときの、HTMLのフォルダからの相対パス。HTMLの <link> が指している位置に合わせる(そうしないと、
// 保存したHTMLが、保存したCSSを見つけられない)。HTMLのフォルダの外になる場合は、ファイル名だけにする
function outputPathOf(path: string, written: string | undefined, baseDir: string): string {
  let target: string | null = path;
  if (written !== undefined) {
    const parsed = classifyReference(written, baseDir);
    target = parsed.kind === 'local' ? parsed.path : null;
  }
  return (target === null ? undefined : relativeWithin(baseDir, target)) ?? basenameOf(path);
}

async function importHtml(
  document: BundleFile,
  html: string,
  files: readonly BundleFile[],
  options: ImportOptions,
): Promise<ImportOutcome> {
  const baseDir = dirnameOf(document.path);
  const assets = new AssetStore(files, options.structured);
  const linked = linkedStylesheets(html, baseDir, assets);

  // フォルダごとの場合は、HTMLが参照しているCSSだけ(フォルダには、他のページのCSSもあるため)。
  // 個別に選んだ場合は、選んだCSSのすべて(参照がなくても、使うつもりで選んでいる)
  const cssFiles = options.structured ? [...linked.keys()].flatMap((path) => files.filter((file) => file.path === path)) : files.filter((file) => CSS_FILE.test(file.path));

  const seen = new Set<string>();
  for (const css of cssFiles) {
    const key = css.path.toLowerCase();
    if (seen.has(key)) {
      return fail(`同じ名前のCSSファイルが複数あります(「${css.path}」)。HTMLからは名前で参照するため、区別できません。`);
    }
    seen.add(key);
  }
  const stylesheets: Stylesheet[] = [];
  for (const css of cssFiles) {
    stylesheets.push({ path: css.path, outputPath: outputPathOf(css.path, linked.get(css.path), baseDir), text: await readText(css) });
  }
  const result: HtmlDocument = { kind: 'html', html, stylesheets, sourceName: basenameOf(document.path), baseDir, assets };
  return { kind: 'document', document: result };
}

export async function importBundle(files: readonly BundleFile[], options: ImportOptions): Promise<ImportOutcome> {
  const stylesheets = files.filter((file) => CSS_FILE.test(file.path));
  const candidates = files.filter((file) =>
    options.structured ? HTML_FILE.test(file.path) || MARKDOWN_FILE.test(file.path) : !CSS_FILE.test(file.path) && !isImagePath(file.path),
  );

  if (files.length === 0) {
    return fail('ファイルがありません。');
  }
  if (candidates.length === 0) {
    if (options.structured) {
      return fail('MarkdownまたはHTMLのファイル(.md / .markdown / .html / .htm)が見つかりません。');
    }
    return fail(
      stylesheets.length > 0
        ? 'CSSファイルだけは取り込めません。HTMLファイルと一緒に選んでください。'
        : '画像だけは取り込めません。MarkdownまたはHTMLファイルと一緒に選んでください。',
    );
  }

  let document = candidates[0] as BundleFile;
  if (options.chosen !== undefined) {
    const chosen = candidates.find((file) => file.path === options.chosen);
    if (chosen === undefined) {
      return fail(`「${options.chosen}」は、取り込んだファイルの中にありません。`);
    }
    document = chosen;
  } else if (candidates.length > 1) {
    if (options.structured) {
      return { kind: 'choose', candidates: candidates.map((file) => file.path).sort(byDepthThenName) };
    }
    return fail(
      `文書は1つずつ取り込んでください(${candidates.map((file) => `「${file.path}」`).join('、')})。HTMLと一緒に取り込めるのは、CSSファイルと画像だけです。`,
    );
  }

  try {
    const text = await readText(document);
    if (text.trim() === '') {
      return fail(`「${document.path}」は空のファイルです。`);
    }
    if (HTML_FILE.test(document.path)) {
      return await importHtml(document, text, files, options);
    }
    if (!options.structured && stylesheets.length > 0) {
      return fail(`CSSファイルは、HTMLファイルと一緒にのみ取り込めます(「${document.path}」はHTMLではありません)。`);
    }
    const markdown: MarkdownDocument = {
      kind: 'markdown',
      markdown: text,
      sourceName: basenameOf(document.path),
      baseDir: dirnameOf(document.path),
      assets: new AssetStore(files, options.structured),
    };
    return { kind: 'document', document: markdown };
  } catch (cause) {
    if (cause instanceof ReadError) {
      return fail(cause.message);
    }
    throw cause;
  }
}
