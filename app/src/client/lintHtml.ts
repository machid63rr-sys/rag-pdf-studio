import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { classifyReference, dirnameOf } from '../shared/assetPath';
import { isImagePath } from './assets';
import type { Stylesheet } from './documents';
import { attributeOf, findStylesheet, isStylesheetLink, walkElements, type ComposeContext } from './htmlCompose';
import type { LintWarning } from './lint';

/*
 * 出力前に利用者へ知らせるべき「PDFやプレビューで期待と違う見え方になるHTML・CSS」を検出する。
 * PDFは、JavaScriptを実行せず、外部へ通信せず、取り込んだ画像だけを表示する状態で描画するため、
 * 次のものは反映されない。
 */

type Element = DefaultTreeAdapterMap['element'];

const MESSAGES = {
  script: 'スクリプト(<script>・onclick など)は実行されません。',
  noscript: '<noscript>の内容は、JavaScriptを実行しないため、そのまま表示されます。',
  'stylesheet-missing':
    '取り込んでいないCSS(<link rel="stylesheet">)は適用されません。CSSファイルも一緒に取り込んでください(フォルダごと取り込めば、自動で読み込まれます)。',
  'external-resource': '外部の画像・フォント・ファイル(http:// などのURL)は表示されません。',
  'missing-resource': '取り込んだファイルの中に見つからない画像・ファイルは表示されません。フォルダごと取り込むか、画像も一緒に選んでください。',
  'unsupported-resource': '画像以外のファイル(フォント・動画・別のHTMLなど)は、取り込んだ中にあっても表示されません(フォントは data: URI にすると使えます)。',
  'css-import': 'CSSの @import は読み込まれません。CSSは <link> で指定するか、1つのファイルにまとめてください。',
} as const;

type Problem = 'external' | 'missing' | 'unsupported' | 'import';

// 問題の種類と、警告の種類(MESSAGESのキー)の対応
const PROBLEM_CODE: Readonly<Record<Problem, keyof typeof MESSAGES>> = {
  external: 'external-resource',
  missing: 'missing-resource',
  unsupported: 'unsupported-resource',
  import: 'css-import',
};

// 外部ファイルを指す属性。画像を読み込む要素は、取り込んだ画像が使える。それ以外は、使えない
const IMAGE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = { img: ['src', 'srcset'], source: ['src', 'srcset'], video: ['poster'], input: ['src'] };
const OTHER_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = { video: ['src'], audio: ['src'], iframe: ['src'], embed: ['src'], object: ['data'] };

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
const CSS_IMPORT = /@import\b/i;

// srcset は「URL 幅, URL 幅 …」の形。URLの部分だけを取り出す
const srcsetUrls = (value: string): string[] =>
  value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '');

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const sorted = (lines: Iterable<number>): number[] => [...new Set(lines)].sort((a, b) => a - b);

export function lintHtml(source: string, stylesheets: readonly Stylesheet[], context: ComposeContext): LintWarning[] {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const found: Record<keyof typeof MESSAGES, number[]> = {
    script: [],
    noscript: [],
    'stylesheet-missing': [],
    'external-resource': [],
    'missing-resource': [],
    'unsupported-resource': [],
    'css-import': [],
  };
  const referenced = new Set<Stylesheet>();

  // 参照が表示できない理由。表示できるなら undefined
  const problemOf = (reference: string, baseDir: string, imagesOnly: boolean): Problem | undefined => {
    const parsed = classifyReference(reference, baseDir);
    if (parsed.kind === 'inline') {
      return undefined;
    }
    if (parsed.kind === 'external') {
      return 'external';
    }
    const path = context.assets.resolve(reference, baseDir);
    if (path === undefined) {
      return 'missing';
    }
    return imagesOnly && isImagePath(path) ? undefined : 'unsupported';
  };

  const report = (problem: Problem, line: number): void => {
    found[PROBLEM_CODE[problem]].push(line);
  };

  const cssProblems = (css: string, baseDir: string): { problem: Problem; line: number }[] => {
    const problems: { problem: Problem; line: number }[] = [];
    for (const match of css.matchAll(CSS_URL)) {
      const problem = problemOf(match[1] ?? match[2] ?? match[3] ?? '', baseDir, true);
      if (problem !== undefined) {
        problems.push({ problem, line: lineOf(css, match.index) });
      }
    }
    const importMatch = CSS_IMPORT.exec(css);
    if (importMatch) {
      problems.push({ problem: 'import', line: lineOf(css, importMatch.index) });
    }
    return problems;
  };

  const lineAt = (element: Element): number => element.sourceCodeLocation?.startLine ?? 0;

  walkElements(document, (element) => {
    if (element.tagName === 'script' || element.attrs.some((attr) => /^on/i.test(attr.name))) {
      found.script.push(lineAt(element));
    }
    if (element.tagName === 'noscript') {
      found.noscript.push(lineAt(element));
    }
    if (isStylesheetLink(element)) {
      const stylesheet = findStylesheet(attributeOf(element, 'href') ?? '', stylesheets, context);
      if (stylesheet === undefined) {
        found['stylesheet-missing'].push(lineAt(element));
      } else {
        referenced.add(stylesheet);
      }
      return;
    }
    for (const [attributes, imagesOnly] of [
      [IMAGE_ATTRIBUTES, true],
      [OTHER_ATTRIBUTES, false],
    ] as const) {
      for (const name of attributes[element.tagName] ?? []) {
        const value = attributeOf(element, name);
        if (value === undefined) {
          continue;
        }
        for (const reference of name === 'srcset' ? srcsetUrls(value) : [value]) {
          const problem = problemOf(reference, context.baseDir, imagesOnly);
          if (problem !== undefined) {
            report(problem, lineAt(element));
          }
        }
      }
    }
    const inlineStyle = attributeOf(element, 'style');
    if (inlineStyle !== undefined) {
      for (const { problem } of cssProblems(inlineStyle, context.baseDir)) {
        report(problem, lineAt(element));
      }
    }
    if (element.tagName === 'style') {
      const css = (element.childNodes as { value?: string }[]).map((node) => node.value ?? '').join('');
      const start = element.sourceCodeLocation?.startTag?.endLine ?? lineAt(element);
      for (const { problem, line } of cssProblems(css, context.baseDir)) {
        report(problem, start + line - 1);
      }
    }
  });

  const warnings: LintWarning[] = [];
  for (const code of Object.keys(MESSAGES) as (keyof typeof MESSAGES)[]) {
    if (found[code].length > 0) {
      warnings.push({ code, message: MESSAGES[code], lines: sorted(found[code]) });
    }
  }

  for (const stylesheet of stylesheets) {
    const grouped = new Map<Problem, number[]>();
    for (const { problem, line } of cssProblems(stylesheet.text, dirnameOf(stylesheet.path))) {
      grouped.set(problem, [...(grouped.get(problem) ?? []), line]);
    }
    for (const [problem, lines] of grouped) {
      warnings.push({
        code: `${problem}:${stylesheet.path}`,
        message: `CSS「${stylesheet.path}」: ${MESSAGES[PROBLEM_CODE[problem]]}`,
        lines: sorted(lines),
      });
    }
    if (!referenced.has(stylesheet)) {
      warnings.push({
        code: `unreferenced-stylesheet:${stylesheet.path}`,
        message: `CSS「${stylesheet.path}」を参照する <link> がHTMLに無いため、<head>の末尾に追加して適用します(保存するHTMLは変わりません)。`,
        lines: [],
      });
    }
  }
  return warnings;
}
