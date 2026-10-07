import { imageTagsIn } from '../shared/imageTag';
import { isPageBreakHtml } from '../shared/pageBreak';
import { imageReferencesIn } from './markdownRefs';
import { forEachLineOutsideFences, splitInlineCode } from './markdownText';
import { findBrokenTables } from './tableCheck';

/*
 * 出力前に利用者へ知らせるべき「PDFやプレビューで期待と違う見え方になる記法」を検出する。
 * いずれも内容は失われない(文字として残る)が、黙って見え方が変わることを避けるための警告。
 */

export type LintCode = 'front-matter' | 'broken-table' | 'unsupported-image' | 'raw-html';

export interface LintWarning {
  // 警告の種類。Markdown用はLintCode。HTML用(lintHtml)は別の値も取る
  readonly code: string;
  readonly message: string;
  // 該当する行番号(1始まり)
  readonly lines: readonly number[];
}

const MESSAGES: Record<LintCode, string> = {
  'front-matter': '先頭のfront matterは、PDFではYAMLのコードブロックとして表示されます。',
  'broken-table': '表として解釈できない表形式の行があります。PDFでは「|」付きの文字のまま表示されます。',
  'unsupported-image':
    '表示できない画像があります(外部のURL、または取り込んだファイルの中に無いもの)。PDFには「[画像: …]」という文字で表示されます。',
  'raw-html': 'HTMLタグ(<br> など)は実行されず、文字としてそのまま表示されます。',
};

// タグ名はASCII英字で始まるものだけ(<https://…> の自動リンクや <エラー一覧表> は含めない)
const RAW_HTML = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--/;

// 先頭のfront matter(--- で始まり、後で --- か ... で閉じる)が占める行数。無ければ0
function frontMatterLineCount(markdown: string): number {
  const lines = markdown.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return 0;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trimEnd();
    if (trimmed === '---' || trimmed === '...') {
      return i + 1;
    }
  }
  return 0;
}

const withoutInlineCode = (line: string): string =>
  splitInlineCode(line)
    .filter((segment) => !segment.code)
    .map((segment) => segment.text)
    .join(' ');

const isDataImage = (reference: string): boolean => /^data:image\//i.test(reference.trim());

/**
 * @param canDisplayImage 参照(相対パスなど)が、取り込んだ画像として表示できるか。省略すると、data URIだけを表示できるとみなす
 */
export function lintMarkdown(markdown: string, canDisplayImage?: (reference: string) => boolean): LintWarning[] {
  const frontMatterLines = frontMatterLineCount(markdown);
  const imageLines: number[] = [];
  const htmlLines: number[] = [];

  forEachLineOutsideFences(markdown, (line, lineNumber) => {
    if (lineNumber <= frontMatterLines) {
      return;
    }
    // 手動の改ページの印(shared/pageBreak.ts)は、改ページとして扱われる(文字としては表示されない)ため、警告しない
    if (isPageBreakHtml(line)) {
      return;
    }
    const prose = withoutInlineCode(line);
    // 画像として読める <img> のタグは、画像として扱われる(文字としては表示されない)ため、HTMLタグの警告の対象から外す。
    // その画像が表示できるかは、![]() の画像と同じように、下で調べる
    const proseWithoutImages = imageTagsIn(prose).reduce((text, entry) => text.replace(entry.text, ' '), prose);
    const hasUnsupportedImage = imageReferencesIn(prose).some(
      (reference) => !isDataImage(reference) && canDisplayImage?.(reference) !== true,
    );
    if (hasUnsupportedImage) {
      imageLines.push(lineNumber);
    }
    if (RAW_HTML.test(proseWithoutImages)) {
      htmlLines.push(lineNumber);
    }
  });

  const warnings: LintWarning[] = [];
  const add = (code: LintCode, lines: readonly number[]): void => {
    if (lines.length > 0) {
      warnings.push({ code, message: MESSAGES[code], lines });
    }
  };
  add('front-matter', frontMatterLines > 0 ? [1] : []);
  add(
    'broken-table',
    findBrokenTables(markdown).map((table) => table.line),
  );
  add('unsupported-image', imageLines);
  add('raw-html', htmlLines);
  return warnings;
}
