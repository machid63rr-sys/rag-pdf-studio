import { describe, expect, it } from 'vitest';
import { findNonWhitespaceChar } from './pageBreaks';

describe('findNonWhitespaceChar', () => {
  it('空白を数えずに、n文字目(0始まり)の、何番目の文字列の何文字目かを返す', () => {
    expect(findNonWhitespaceChar(['ab cd'], 0)).toEqual({ text: 0, index: 0 });
    expect(findNonWhitespaceChar(['ab cd'], 2)).toEqual({ text: 0, index: 3 });
    expect(findNonWhitespaceChar(['ab cd'], 3)).toEqual({ text: 0, index: 4 });
  });

  it('複数の文字列(テキストノード)にまたがって数える', () => {
    expect(findNonWhitespaceChar(['ab', ' cd', 'ef'], 2)).toEqual({ text: 1, index: 1 });
    expect(findNonWhitespaceChar(['ab', ' cd', 'ef'], 4)).toEqual({ text: 2, index: 0 });
  });

  it('全角の空白・改行・タブ・前後の空白も、数えない(サーバの数え方と同じ)', () => {
    expect(findNonWhitespaceChar(['　あ\n\tい　'], 1)).toEqual({ text: 0, index: 4 });
    expect(findNonWhitespaceChar(['  ', '\n', 'あ'], 0)).toEqual({ text: 2, index: 0 });
  });

  it('空白だけの文字列は、飛ばす', () => {
    expect(findNonWhitespaceChar(['', ' ', 'a', '  ', 'b'], 1)).toEqual({ text: 4, index: 0 });
  });

  it('文字数を超えた位置・負の位置・空の入力は null', () => {
    expect(findNonWhitespaceChar(['ab'], 2)).toBeNull();
    expect(findNonWhitespaceChar(['ab'], -1)).toBeNull();
    expect(findNonWhitespaceChar([], 0)).toBeNull();
    expect(findNonWhitespaceChar(['  '], 0)).toBeNull();
  });

  it('絵文字などのサロゲートペアは、UTF-16の単位で数える(サーバの数え方と同じ)', () => {
    // 「😀」は2単位。サーバ(ブラウザ)も、文字列の単位(UTF-16)で数える
    expect(findNonWhitespaceChar(['😀a'], 2)).toEqual({ text: 0, index: 2 });
  });
});
