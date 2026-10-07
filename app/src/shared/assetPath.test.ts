import { describe, expect, it } from 'vitest';
import { basenameOf, classifyReference, dirnameOf, relativeWithin } from './assetPath.js';

const local = (path: string | null) => ({ kind: 'local', path });

describe('classifyReference', () => {
  it.each([
    ['images/a.png', '', 'images/a.png'],
    ['./images/a.png', '', 'images/a.png'],
    ['a.png', 'pages', 'pages/a.png'],
    ['../images/a.png', 'pages', 'images/a.png'],
    ['../../a.png', 'a/b/c', 'a/a.png'],
    ['a/./b//c.png', '', 'a/b/c.png'],
    ['/images/a.png', 'pages/deep', 'images/a.png'],
    ['images\\sub\\a.png', 'pages', 'pages/images/sub/a.png'],
    ['a.png?v=2#top', 'x', 'x/a.png'],
    ['%E6%97%A5%E6%9C%AC%20%E5%9B%B3.png', '', '日本 図.png'],
    ['  images/a.png  ', '', 'images/a.png'],
  ])('%s (基準 "%s") -> %s', (reference, baseDir, expected) => {
    expect(classifyReference(reference, baseDir)).toEqual(local(expected));
  });

  it('ルートより上を指す参照は、path が null になる(取り込んだファイルの外)', () => {
    expect(classifyReference('../a.png', '')).toEqual(local(null));
    expect(classifyReference('../../a.png', 'x')).toEqual(local(null));
  });

  it('デコードできない「%」は、そのままのファイル名として扱う', () => {
    expect(classifyReference('100%.png', '')).toEqual(local('100%.png'));
  });

  it.each(['http://example.com/a.png', 'https://example.com/a.png', '//cdn.example.com/a.png', 'file:///etc/passwd', 'blob:x', 'javascript:alert(1)', 'C:\\a.png', '\\\\server\\share\\a.png'])(
    '%s は外部の参照',
    (reference) => {
      expect(classifyReference(reference, '')).toEqual({ kind: 'external' });
    },
  );

  it.each(['data:image/png;base64,AAAA', 'DATA:image/png;base64,AAAA', '#section', '', '   '])('%j は読み込むファイルが無い(inline)', (reference) => {
    expect(classifyReference(reference, '')).toEqual({ kind: 'inline' });
  });
});

describe('パスの部品', () => {
  it('dirnameOf / basenameOf', () => {
    expect(dirnameOf('a/b/c.png')).toBe('a/b');
    expect(dirnameOf('c.png')).toBe('');
    expect(basenameOf('a/b/c.png')).toBe('c.png');
    expect(basenameOf('c.png')).toBe('c.png');
  });

  it('relativeWithin: フォルダの中なら相対パス、外ならnull', () => {
    expect(relativeWithin('pages', 'pages/css/s.css')).toBe('css/s.css');
    expect(relativeWithin('pages', 'css/s.css')).toBeNull();
    expect(relativeWithin('pages', 'pages2/s.css')).toBeNull();
    expect(relativeWithin('', 'css/s.css')).toBe('css/s.css');
  });
});
