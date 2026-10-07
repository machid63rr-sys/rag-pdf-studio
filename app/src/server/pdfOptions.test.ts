import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SETTINGS, type PageSettings } from '../shared/pageSettings.js';
import { FOOTER_TEMPLATE, pdfOptionsFor } from './pdfOptions.js';

const TIMEOUT = 12_345;

describe('pdfOptionsFor', () => {
  it('既定(A4縦・標準・ページ番号あり)は、これまでのPDFと同じ指定', () => {
    expect(pdfOptionsFor(DEFAULT_PAGE_SETTINGS, false, TIMEOUT)).toEqual({
      format: 'A4',
      margin: { top: '20mm', bottom: '25mm', left: '20mm', right: '20mm' },
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: FOOTER_TEMPLATE,
      timeout: TIMEOUT,
    });
  });

  it('A3・Letterは、Chromiumの用紙の名前で渡す。JIS B列(B4・B5)は、大きさ(mm)で渡す', () => {
    const options = (paper: PageSettings['paper']) => pdfOptionsFor({ ...DEFAULT_PAGE_SETTINGS, paper }, false, TIMEOUT);
    expect(options('A3').format).toBe('A3');
    expect(options('Letter').format).toBe('Letter');
    expect(options('B5')).toMatchObject({ width: '182mm', height: '257mm' });
    expect(options('B5').format).toBeUndefined();
    expect(options('B4')).toMatchObject({ width: '257mm', height: '364mm' });
  });

  it('横向きは landscape(縦向きでは、指定しない)', () => {
    expect(pdfOptionsFor({ ...DEFAULT_PAGE_SETTINGS, orientation: 'landscape' }, false, TIMEOUT).landscape).toBe(true);
    expect('landscape' in pdfOptionsFor(DEFAULT_PAGE_SETTINGS, false, TIMEOUT)).toBe(false);
  });

  it('余白のプリセットが、mmで渡る', () => {
    expect(pdfOptionsFor({ ...DEFAULT_PAGE_SETTINGS, margin: 'narrow' }, false, TIMEOUT).margin).toEqual({ top: '10mm', bottom: '15mm', left: '10mm', right: '10mm' });
    expect(pdfOptionsFor({ ...DEFAULT_PAGE_SETTINGS, margin: 'wide' }, false, TIMEOUT).margin).toEqual({ top: '25mm', bottom: '30mm', left: '25mm', right: '25mm' });
  });

  it('ページ番号なしは、フッターを出さない(余白は、そのまま)', () => {
    const options = pdfOptionsFor({ ...DEFAULT_PAGE_SETTINGS, pageNumbers: false }, false, TIMEOUT);
    expect(options.displayHeaderFooter).toBe(false);
    expect(options.headerTemplate).toBeUndefined();
    expect(options.footerTemplate).toBeUndefined();
    expect(options.margin).toEqual({ top: '20mm', bottom: '25mm', left: '20mm', right: '20mm' });
  });

  describe('文書のCSS(@page)を優先する(利用者のHTML)', () => {
    const custom: PageSettings = { paper: 'B4', orientation: 'landscape', margin: 'wide', pageNumbers: true };

    it('用紙・向き・余白の設定は使わず(既定のA4・標準のまま)、preferCSSPageSize を付ける', () => {
      expect(pdfOptionsFor(custom, true, TIMEOUT)).toEqual({ ...pdfOptionsFor(DEFAULT_PAGE_SETTINGS, true, TIMEOUT) });
      expect(pdfOptionsFor(custom, true, TIMEOUT)).toMatchObject({ format: 'A4', preferCSSPageSize: true });
      expect('landscape' in pdfOptionsFor(custom, true, TIMEOUT)).toBe(false);
    });

    it('ページ番号の有無だけは、設定に従う', () => {
      expect(pdfOptionsFor({ ...custom, pageNumbers: false }, true, TIMEOUT)).toMatchObject({ displayHeaderFooter: false, preferCSSPageSize: true });
      expect(pdfOptionsFor(custom, true, TIMEOUT)).toMatchObject({ displayHeaderFooter: true, footerTemplate: FOOTER_TEMPLATE });
    });
  });
});
