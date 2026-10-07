import { describe, expect, it } from 'vitest';
import { defaultBaseName, validateBaseName } from './filename';

const messageOf = (name: string): string | null => {
  const check = validateBaseName(name);
  return check.ok ? null : check.message;
};

describe('validateBaseName', () => {
  it.each(['manual', '取扱説明書_v2', 'a.b', 'report 2026-10', 'ＡＢＣ', '.hidden'])('%s は使える', (name) => {
    expect(validateBaseName(name)).toEqual({ ok: true });
  });

  it('空は使えない', () => {
    expect(messageOf('')).toContain('入力してください');
  });

  it.each(['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b'])('%j は使えない文字を含む', (name) => {
    expect(messageOf(name)).toContain('使えません');
  });

  it('先頭・末尾の空白、末尾のドットは使えない', () => {
    expect(messageOf(' a')).toContain('空白');
    expect(messageOf('a ')).toContain('空白');
    expect(messageOf('a.')).toContain('「.」');
    expect(messageOf('..')).toContain('「.」');
  });

  it.each(['CON', 'con', 'PRN', 'aux', 'NUL', 'COM1', 'com9', 'LPT3', 'con.backup'])('予約名 %s は使えない', (name) => {
    expect(messageOf(name)).toContain('予約');
  });

  it('予約名を含むだけの名前は使える', () => {
    expect(validateBaseName('console')).toEqual({ ok: true });
    expect(validateBaseName('com10')).toEqual({ ok: true });
    expect(validateBaseName('my.con')).toEqual({ ok: true });
  });

  it('UTF-8で200バイトを超える名前は使えない(日本語は1文字3バイト)', () => {
    expect(validateBaseName('あ'.repeat(66))).toEqual({ ok: true });
    expect(messageOf('あ'.repeat(67))).toContain('長すぎます');
    expect(messageOf('a'.repeat(201))).toContain('長すぎます');
  });
});

describe('defaultBaseName', () => {
  it('拡張子(.md/.markdown/.txt)を除く', () => {
    expect(defaultBaseName('manual.md')).toBe('manual');
    expect(defaultBaseName('手順書.MARKDOWN')).toBe('手順書');
    expect(defaultBaseName('memo.txt')).toBe('memo');
    expect(defaultBaseName('a.b.md')).toBe('a.b');
  });

  it('HTMLの拡張子(.html/.htm)も除く', () => {
    expect(defaultBaseName('index.html')).toBe('index');
    expect(defaultBaseName('案内.HTM')).toBe('案内');
    expect(defaultBaseName('a.b.html')).toBe('a.b');
  });

  it('貼り付け(ファイル名なし)や、拡張子を除くと空になる名前はdocument', () => {
    expect(defaultBaseName(null)).toBe('document');
    expect(defaultBaseName('.md')).toBe('document');
    expect(defaultBaseName('')).toBe('document');
  });

  it('使えない文字は「_」に置き換える', () => {
    expect(defaultBaseName('a:b*c.md')).toBe('a_b_c');
  });

  it('予約名や長すぎる名前は、使える形にそろえる', () => {
    expect(defaultBaseName('CON.md')).toBe('document');
    const longName = defaultBaseName(`${'あ'.repeat(100)}.md`);
    expect(validateBaseName(longName)).toEqual({ ok: true });
    expect(longName).toBe('あ'.repeat(66));
  });

  it('結果は常に検証を通る', () => {
    for (const source of ['.', '..', ' ', 'a. ', 'lpt1.txt', '///']) {
      expect(validateBaseName(defaultBaseName(source))).toEqual({ ok: true });
    }
  });
});
