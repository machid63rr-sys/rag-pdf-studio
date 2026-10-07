/*
 * HTML・CSS・Markdownの中の「参照」(画像やCSSなどのファイルを指す書き方)を、
 * 取り込んだファイル一式の中のパスへ解決する。
 *
 * クライアント(HTMLのプレビュー・PDF)とサーバ(MarkdownのPDF)で、同じ規則を使うための共有モジュール。
 * 扱うのは、取り込んだ一式の「ルート」を基準にした、'/' 区切りの相対パスだけ(先頭に '/' を付けない。ルート自体は '')。
 */

export type Reference =
  // data: URI や、文書内の移動(#…)。読み込むファイルは無い
  | { readonly kind: 'inline' }
  // http(s):// などのスキームつき、または //ホスト。取り込んだファイルの中には無い
  | { readonly kind: 'external' }
  // 取り込んだ一式の中のファイルを指す書き方。path が null の場合は、ルートの外を指している(読めない)
  | { readonly kind: 'local'; readonly path: string | null };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// 'a/./b/../c' -> 'a/c'。ルートより上へ出る場合は null
function normalize(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // 「%」を含むファイル名など、デコードできないものはそのまま使う
  }
}

/**
 * 書かれている参照(例: "../images/a.png?v=2")を、baseDir(参照が書かれたファイルのフォルダ)を基準に解決する。
 * - "/" で始まる参照は、ルートからの指定として扱う
 * - クエリ(?…)とフラグメント(#…)は無視する。"%E6…" は文字に戻す。"\" は "/" として扱う
 */
export function classifyReference(reference: string, baseDir: string): Reference {
  const trimmed = reference.trim();
  if (trimmed === '' || trimmed.startsWith('#') || /^data:/i.test(trimmed)) {
    return { kind: 'inline' };
  }
  if (SCHEME.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('\\\\')) {
    return { kind: 'external' };
  }
  const path = decode(trimmed.split(/[?#]/)[0] ?? '').replace(/\\/g, '/');
  return { kind: 'local', path: normalize(path.startsWith('/') ? path : `${baseDir}/${path}`) };
}

export const dirnameOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

export const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** path が dir の中にあれば、dir からの相対パスを返す。外なら null(dir が '' ならルート直下以下のすべて) */
export function relativeWithin(dir: string, path: string): string | null {
  if (dir === '') {
    return path;
  }
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}
