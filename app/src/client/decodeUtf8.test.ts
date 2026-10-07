import { describe, expect, it } from 'vitest';
import { DecodeError, decodeUtf8Strict } from './decodeUtf8';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('decodeUtf8Strict', () => {
  it('UTF-8の日本語を読み込める(Uint8ArrayとArrayBufferの両方)', () => {
    const bytes = encode('# 見出し\n本文');
    expect(decodeUtf8Strict(bytes)).toBe('# 見出し\n本文');
    expect(decodeUtf8Strict(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).toBe(
      '# 見出し\n本文',
    );
  });

  it('先頭のBOMは取り除く', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('本文')]);
    expect(decodeUtf8Strict(withBom)).toBe('本文');
  });

  it('CRLFはそのまま保持する', () => {
    expect(decodeUtf8Strict(encode('a\r\nb'))).toBe('a\r\nb');
  });

  it('Shift_JISのバイト列は、文字化けさせずに例外にする', () => {
    // 「あ」のShift_JIS表現
    const shiftJis = new Uint8Array([0x82, 0xa0]);
    expect(() => decodeUtf8Strict(shiftJis)).toThrowError(DecodeError);
    expect(() => decodeUtf8Strict(shiftJis)).toThrowError('UTF-8');
  });

  it('空のファイルは空文字列になる', () => {
    expect(decodeUtf8Strict(new Uint8Array())).toBe('');
  });
});
