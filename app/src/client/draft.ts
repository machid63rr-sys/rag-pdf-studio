import { basenameOf } from '../shared/assetPath';
import { DEFAULT_PAGE_SETTINGS, parsePageSettings, type PageSettings } from '../shared/pageSettings';
import { AssetStore, type BundleFile } from './assets';
import type { ImportedDocument, Stylesheet } from './documents';

/*
 * 下書き(自動保存する、編集中の文書)。
 *
 * 保存するのは、文書の内容(Markdown、またはHTMLとCSS)、元のファイル名、ページ設定だけ。
 * フォルダから取り込んだ画像・CSSのファイルは、保存しない(復元後は、画像が「見つからない」警告になる。
 * ドロップして埋め込んだ画像は、文書の中に入っているため、復元される)。
 */

interface DraftBase {
  // 取り込んだファイル名(貼り付けの場合は null)
  readonly sourceName: string | null;
  readonly baseDir: string;
  readonly pageSettings: PageSettings;
}

export interface MarkdownDraftContent extends DraftBase {
  readonly kind: 'markdown';
  readonly markdown: string;
}

export interface HtmlDraftContent extends DraftBase {
  readonly kind: 'html';
  readonly html: string;
  // HTMLと一緒に取り込んだCSS(編集中の内容)
  readonly stylesheets: readonly Stylesheet[];
}

/** 下書きにする内容(保存した日時を除く) */
export type DraftContent = MarkdownDraftContent | HtmlDraftContent;

/** 保存してある下書き。version は、保存形式の版(読めない版の下書きは、無いものとして扱う) */
export type Draft = DraftContent & { readonly version: 1; readonly savedAt: number };

export const DRAFT_VERSION = 1;

const isString = (value: unknown): value is string => typeof value === 'string';

function parseStylesheets(value: unknown): Stylesheet[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sheets: Stylesheet[] = [];
  for (const entry of value as unknown[]) {
    const { path, outputPath, text } = (entry ?? {}) as Record<string, unknown>;
    if (!isString(path) || !isString(outputPath) || !isString(text)) {
      return undefined;
    }
    sheets.push({ path, outputPath, text });
  }
  return sheets;
}

/** 保存先から読んだ値を、下書きにする。読めない形(版が違う・項目が足りない)なら null。ページ設定だけは、壊れていれば既定にする */
export function parseDraft(value: unknown): Draft | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { version, kind, sourceName, baseDir, savedAt } = record;
  if (version !== DRAFT_VERSION || !isString(baseDir) || typeof savedAt !== 'number' || !(sourceName === null || isString(sourceName))) {
    return null;
  }
  const common = { version: DRAFT_VERSION, sourceName, baseDir, savedAt, pageSettings: parsePageSettings(record['pageSettings']) ?? DEFAULT_PAGE_SETTINGS } as const;
  if (kind === 'markdown' && isString(record['markdown'])) {
    return { ...common, kind, markdown: record['markdown'] };
  }
  const stylesheets = parseStylesheets(record['stylesheets']);
  if (kind === 'html' && isString(record['html']) && stylesheets !== undefined) {
    return { ...common, kind, html: record['html'], stylesheets };
  }
  return null;
}

// 文字だけのファイル(復元したCSSを、取り込んだファイルの一式に入れるため)
const textFile = (path: string, text: string): BundleFile => ({
  path,
  file: { name: basenameOf(path), arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer as ArrayBuffer) },
});

/**
 * 下書きから、編集できる文書を作る。「変更あり」(restored)として扱う。
 * HTMLのCSSは、取り込んだファイルの一式にも入れる(HTMLの <link> と、CSSの対応を、取り込んだときと同じように見つけるため)。
 * 画像などのファイルは、無い
 */
export function documentFromDraft(draft: Draft): ImportedDocument {
  const common = { sourceName: draft.sourceName, baseDir: draft.baseDir, restored: true, pageSettings: draft.pageSettings } as const;
  if (draft.kind === 'markdown') {
    return { kind: 'markdown', markdown: draft.markdown, assets: new AssetStore([], false), ...common };
  }
  return {
    kind: 'html',
    html: draft.html,
    stylesheets: draft.stylesheets,
    assets: new AssetStore(
      draft.stylesheets.map((sheet) => textFile(sheet.path, sheet.text)),
      false,
    ),
    ...common,
  };
}

/** 取り込み画面に出す、下書きの名前(ファイル名。貼り付けた文書は、種類) */
export const draftName = (draft: Draft): string => draft.sourceName ?? (draft.kind === 'html' ? '貼り付けたHTML' : '貼り付けたMarkdown');
