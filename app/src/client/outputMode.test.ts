import { describe, expect, it } from 'vitest';
import { chosenFiles, fileNameOf, folderOutputLabel, selectedExtensions, usesBaseName, type OutputFile } from './outputMode';

const md: OutputFile = { id: 'markdown', label: 'Markdown (.md)', shortLabel: 'MD', extension: 'md', content: { type: 'text', text: '#', mimeType: 'text/markdown' } };
const html: OutputFile = { id: 'html', label: 'HTML (.html)', shortLabel: 'HTML', extension: 'html', content: { type: 'text', text: '<p>', mimeType: 'text/html' } };
const css = (name: string): OutputFile => ({
  id: `css:${name}`,
  label: `CSS (${name})`,
  shortLabel: 'CSS',
  extension: 'css',
  fixedName: name,
  content: { type: 'text', text: 'p{}', mimeType: 'text/css' },
});
const pdf: OutputFile = { id: 'pdf', label: 'PDF (.pdf)', shortLabel: 'PDF', extension: 'pdf', content: { type: 'pdf' } };

describe('chosenFiles', () => {
  it('選ばれたものだけを、元の並び順で返す', () => {
    expect(chosenFiles([md, pdf], new Set(['pdf', 'markdown'])).map((file) => file.id)).toEqual(['markdown', 'pdf']);
    expect(chosenFiles([md, pdf], new Set(['pdf'])).map((file) => file.id)).toEqual(['pdf']);
    expect(chosenFiles([md, pdf], new Set())).toEqual([]);
  });
});

describe('folderOutputLabel', () => {
  it.each([
    [[md, pdf], '選んだフォルダへMDとPDFを出力'],
    [[md], '選んだフォルダへMDを出力'],
    [[pdf], '選んだフォルダへPDFを出力'],
    [[html, css('style.css'), pdf], '選んだフォルダへHTMLとCSSとPDFを出力'],
    [[html, css('a.css'), css('b.css')], '選んだフォルダへHTMLとCSSを出力'],
  ])('%j -> %s', (chosen, expected) => {
    expect(folderOutputLabel(chosen)).toBe(expected);
  });
});

describe('selectedExtensions', () => {
  it.each([
    [[md, pdf], '.md / .pdf'],
    [[pdf], '.pdf'],
    [[html, css('style.css'), pdf], '.html / style.css / .pdf'],
    [[], ''],
  ])('%j -> "%s"', (chosen, expected) => {
    expect(selectedExtensions(chosen)).toBe(expected);
  });
});

describe('fileNameOf / usesBaseName', () => {
  it('利用者が決めた名前を使うファイルと、固定名のファイルを区別する', () => {
    expect(fileNameOf(html, '手順書')).toBe('手順書.html');
    expect(fileNameOf(css('style.css'), '手順書')).toBe('style.css');
    expect(usesBaseName([html, css('style.css')])).toBe(true);
    expect(usesBaseName([css('style.css')])).toBe(false);
    expect(usesBaseName([])).toBe(false);
  });
});
