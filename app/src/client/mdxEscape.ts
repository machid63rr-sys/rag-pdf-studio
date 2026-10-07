import { mapLinesOutsideFences, mapOutsideInlineCode } from './markdownText';

/**
 * 書式付きエディタ(MDXEditor)はMarkdownをMDXとして解釈するため、本文中の「<エラー一覧表>」のような
 * 山括弧がJSXタグとみなされ、閉じタグが無いとして解釈に失敗する。
 * エディタへ渡す前に「<」を「\<」にして文字として扱わせ、エディタから受け取った後に元へ戻す。
 *
 * - コードフェンスの内側とインラインコードの内側は、文字列がそのまま扱われるので、どちらの変換も行わない
 *   (インラインコード内を変換すると、`List<string>` が画面上で `List\<string>` と表示されてしまう)
 * - 元から「\<」と書かれていた箇所は、往復で「<」になる(エディタが「\<」の「\」を保持しないため)
 *   `{` `}` はエスケープ不要であることを実測で確認している
 */

// すでにエスケープ済み(直前にバックスラッシュが奇数個)の「<」は二重にエスケープしない
const escapeText = (text: string): string =>
  text.replace(/(\\*)</g, (whole, backslashes: string) =>
    backslashes.length % 2 === 0 ? `${backslashes}\\<` : whole,
  );

const unescapeText = (text: string): string =>
  text.replace(/(\\*)\\</g, (_whole, backslashes: string) =>
    backslashes.length % 2 === 0 ? `${backslashes}<` : `${backslashes}\\<`,
  );

export function escapeForMdx(markdown: string): string {
  return mapLinesOutsideFences(markdown, (line) => mapOutsideInlineCode(line, escapeText));
}

export function unescapeFromMdx(markdown: string): string {
  return mapLinesOutsideFences(markdown, (line) => mapOutsideInlineCode(line, unescapeText));
}
