import { describe, expect, it } from 'vitest';
import { escapeForMdx, unescapeFromMdx } from './mdxEscape';

describe('escapeForMdx / unescapeFromMdx', () => {
  it('本文の山括弧をエスケープし、往復で元に戻る', () => {
    const original = '## 見出し\n\n<エラー一覧表>\n\n圧力 < 0.5MPa';
    const escaped = escapeForMdx(original);
    expect(escaped).toBe('## 見出し\n\n\\<エラー一覧表>\n\n圧力 \\< 0.5MPa');
    expect(unescapeFromMdx(escaped)).toBe(original);
  });

  it('すでにエスケープ済みの「<」は二重にエスケープしない', () => {
    expect(escapeForMdx('a \\< b')).toBe('a \\< b');
  });

  it('コードフェンス内は変換しない', () => {
    const original = '前\n```\nif a < b\n```\n後 <x>';
    expect(escapeForMdx(original)).toBe('前\n```\nif a < b\n```\n後 \\<x>');
    expect(unescapeFromMdx('前\n```\nif a \\< b\n```\n後 \\<x>')).toBe('前\n```\nif a \\< b\n```\n後 <x>');
  });

  it('チルダのコードフェンス内も変換しない', () => {
    expect(escapeForMdx('~~~\na < b\n~~~')).toBe('~~~\na < b\n~~~');
  });

  it('山括弧が無い本文はそのまま返す', () => {
    const plain = '| コード | 内容 |\n| --- | --- |\n| E01 | 圧力異常 |';
    expect(escapeForMdx(plain)).toBe(plain);
    expect(unescapeFromMdx(plain)).toBe(plain);
  });

  describe('インラインコード', () => {
    it('インラインコード内の「<」は変換せず、外側だけ変換する', () => {
      const original = '型は `List<string>` で、本文の List<string> は文字。';
      const escaped = escapeForMdx(original);
      expect(escaped).toBe('型は `List<string>` で、本文の List\\<string> は文字。');
      expect(unescapeFromMdx(escaped)).toBe(original);
    });

    it('バッククォートを複数並べたインラインコードも対象外にする', () => {
      expect(escapeForMdx('``a<b`` と c<d')).toBe('``a<b`` と c\\<d');
    });

    it('閉じられていないバッククォートはコードとみなさず、以降を変換する', () => {
      expect(escapeForMdx('`a<b')).toBe('`a\\<b');
    });

    it('長さの違うバッククォート列では閉じない', () => {
      expect(escapeForMdx('``a<b` c<d')).toBe('``a\\<b` c\\<d');
    });

    it('エスケープされたバッククォートはコードの開始にならない', () => {
      expect(escapeForMdx('\\`a<b\\`')).toBe('\\`a\\<b\\`');
    });

    it('1行に複数のインラインコードがあっても、それぞれ対象外にする', () => {
      expect(escapeForMdx('`a<b` x<y `c<d`')).toBe('`a<b` x\\<y `c<d`');
    });

    it('エディタが出力したインラインコード内の「\\<」は、元に戻さない', () => {
      expect(unescapeFromMdx('`a\\<b` と \\<c>')).toBe('`a\\<b` と <c>');
    });
  });

  it('既知の非恒等: 元から「\\<」と書かれていた箇所は、エディタ経由で「<」になる', () => {
    // 元から「\<」の箇所はエディタへそのまま渡す(二重にエスケープしない)
    expect(escapeForMdx('\\<div\\>')).toBe('\\<div\\>');
    // エディタは画面上「<div>」として扱い、出力では「\<div>」にする。これを元に戻すと、元の「\」は失われる
    expect(unescapeFromMdx('\\<div>')).toBe('<div>');
  });
});
