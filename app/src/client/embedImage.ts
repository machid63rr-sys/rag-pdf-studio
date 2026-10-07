import { imageMimeOf, toBase64 } from './assets';

/*
 * 画像ファイルのドラッグ&ドロップ(貼り付け)による、文書への埋め込み。
 * 画像は data: URI にして、Markdown・HTML・CSSの文字の中へそのまま書き込む(文書だけで完結する)。
 * ここには、ファイルの検査・読み込み・挿入する文字の生成など、画面に依らない処理を置く。
 */

// 1枚あたりの上限。data: URI は元の約1.3倍になり、文書全体の上限(MAX_MARKDOWN_BYTES、既定30MB)にも数えられる
export const MAX_EMBED_BYTES = 10 * 1024 * 1024;

const EMBED_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
export const EMBED_FORMATS_LABEL = 'PNG・JPEG・GIF・WebP・SVG';

// ブラウザのFileと同じ形。テストでは、メモリ上の代役を渡す
export interface EmbedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface EmbeddedImage {
  readonly name: string;
  // 代替テキスト(ファイル名から拡張子を除いたもの)
  readonly alt: string;
  readonly uri: string;
}

export interface EmbedResult {
  readonly images: readonly EmbeddedImage[];
  // 埋め込めなかったファイルと、その理由(利用者に見せる文)
  readonly problems: readonly string[];
}

export interface EmbedNotice {
  readonly kind: 'info' | 'error';
  readonly text: string;
}

/** 埋め込める画像の種類(MIME)。ファイルの種類が不明(空)な場合は、拡張子で判断する */
export function embeddableMime(file: Pick<EmbedFile, 'name' | 'type'>): string | undefined {
  if (EMBED_MIME_TYPES.has(file.type)) {
    return file.type;
  }
  return file.type === '' ? imageMimeOf(file.name) : undefined;
}

const formatSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

/** 埋め込めないファイルなら、その理由。埋め込めるなら undefined(中身は読まない) */
export function embedProblemOf(file: Pick<EmbedFile, 'name' | 'type' | 'size'>): string | undefined {
  if (embeddableMime(file) === undefined) {
    return `「${file.name}」は画像として埋め込めません(対応: ${EMBED_FORMATS_LABEL})`;
  }
  if (file.size > MAX_EMBED_BYTES) {
    return `「${file.name}」は大きすぎるため埋め込めません(${formatSize(file.size)}。上限 ${formatSize(MAX_EMBED_BYTES)})`;
  }
  return undefined;
}

/** ファイル名から、代替テキスト(拡張子なし。Markdownの記号になる文字は除く)を作る */
export function altTextOf(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[[\]\\\r\n]/g, ' ')
    .trim();
}

/** 画像ファイルを読み込み、data: URI にする。埋め込めないファイルは、理由を添えて返す */
export async function readImages(files: readonly EmbedFile[]): Promise<EmbedResult> {
  const images: EmbeddedImage[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const problem = embedProblemOf(file);
    const mime = embeddableMime(file);
    if (problem !== undefined || mime === undefined) {
      problems.push(problem ?? `「${file.name}」は画像として埋め込めません`);
      continue;
    }
    try {
      images.push({ name: file.name, alt: altTextOf(file.name), uri: `data:${mime};base64,${toBase64(await file.arrayBuffer())}` });
    } catch {
      problems.push(`「${file.name}」を読み込めませんでした`);
    }
  }
  return { images, problems };
}

/** 埋め込みの結果を、利用者に伝える文にする。何も起きなかった(ファイルが無い)場合は null */
export function summarize(result: EmbedResult): EmbedNotice | null {
  const { images, problems } = result;
  if (images.length === 0 && problems.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (images.length > 0) {
    const added = images.reduce((total, image) => total + image.uri.length, 0);
    parts.push(`画像${images.map((image) => `「${image.name}」`).join('')}を埋め込みました(文書に約${formatSize(added)}のデータが加わります)。`);
  }
  parts.push(...problems.map((problem) => `${problem}。`));
  return { kind: problems.length > 0 ? 'error' : 'info', text: parts.join(' ') };
}

// 挿入する文字(それぞれの言語での、画像の書き方)
const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const markdownImage = (image: EmbeddedImage): string => `![${image.alt}](${image.uri})`;
export const htmlImage = (image: EmbeddedImage): string => `<img src="${image.uri}" alt="${escapeAttribute(image.alt)}">`;
export const cssImage = (image: EmbeddedImage): string => `url("${image.uri}")`;

export type SnippetKind = 'markdown' | 'html' | 'css';

/** 画像を書き込む文字。Markdownは、複数なら、それぞれを独立した段落にする */
export function snippetOf(kind: SnippetKind, images: readonly EmbeddedImage[]): string {
  if (kind === 'markdown') {
    return images.map(markdownImage).join('\n\n');
  }
  return images.map(kind === 'html' ? htmlImage : cssImage).join(kind === 'html' ? '\n' : ', ');
}

export interface Inserted {
  readonly value: string;
  // 挿入した文字の直後の位置
  readonly caret: number;
}

/**
 * テキストの選択範囲(start〜end)を、snippet で置き換える。
 * block が true(Markdown)のときは、行の途中に挿入して段落を壊さないよう、前後を空行で区切る。
 */
export function insertSnippet(value: string, start: number, end: number, snippet: string, block: boolean): Inserted {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = block && before !== '' && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const tail = block && after !== '' && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
  const inserted = lead + snippet + tail;
  return { value: before + inserted + after, caret: before.length + lead.length + snippet.length };
}
