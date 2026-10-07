import { describe, expect, it } from 'vitest';
import {
  bodyHeightMm,
  contentSizePx,
  DEFAULT_PAGE_SETTINGS,
  MARGIN_LABELS,
  MARGIN_PRESETS,
  ORIENTATION_LABELS,
  ORIENTATIONS,
  PAPER_LABELS,
  PAPER_SIZES,
  pageSettingsEqual,
  paperMm,
  parsePageSettings,
  type PageSettings,
} from './pageSettings.js';

const everySetting = (): PageSettings[] =>
  PAPER_SIZES.flatMap((paper) => ORIENTATIONS.flatMap((orientation) => MARGIN_PRESETS.map((margin) => ({ paper, orientation, margin, pageNumbers: true }))));

describe('parsePageSettings', () => {
  it('4つの項目が、決められた値なら、そのまま返す(余計な項目は捨てる)', () => {
    expect(parsePageSettings({ paper: 'B5', orientation: 'landscape', margin: 'wide', pageNumbers: false, extra: 1 })).toEqual({
      paper: 'B5',
      orientation: 'landscape',
      margin: 'wide',
      pageNumbers: false,
    });
  });

  it('既定の設定は、そのまま通る', () => {
    expect(parsePageSettings(DEFAULT_PAGE_SETTINGS)).toEqual(DEFAULT_PAGE_SETTINGS);
  });

  it.each([
    ['null', null],
    ['文字列', 'A4'],
    ['配列', []],
    ['空', {}],
    ['用紙が一覧に無い', { ...DEFAULT_PAGE_SETTINGS, paper: 'A5' }],
    ['用紙が文字列でない', { ...DEFAULT_PAGE_SETTINGS, paper: 4 }],
    ['向きが一覧に無い', { ...DEFAULT_PAGE_SETTINGS, orientation: 'sideways' }],
    ['余白が一覧に無い', { ...DEFAULT_PAGE_SETTINGS, margin: 'huge' }],
    ['ページ番号が真偽値でない', { ...DEFAULT_PAGE_SETTINGS, pageNumbers: 1 }],
    ['ページ番号が無い', { paper: 'A4', orientation: 'portrait', margin: 'standard' }],
    ['prototypeの名前(toString)', { ...DEFAULT_PAGE_SETTINGS, paper: 'toString' }],
  ])('不正な値(%s)は undefined', (_label, value) => {
    expect(parsePageSettings(value)).toBeUndefined();
  });
});

describe('contentSizePx(PDFの本文の領域。ページの区切りの測定が使う)', () => {
  it('A4縦・標準は、実測した大きさ(646 × 955)', () => {
    expect(contentSizePx(DEFAULT_PAGE_SETTINGS)).toEqual({ width: 646, height: 955 });
  });

  it('向きを変えると、幅と高さの役割が入れ替わる(A4横・標準は、本文の幅が 297mm − 左右の余白)', () => {
    expect(contentSizePx({ ...DEFAULT_PAGE_SETTINGS, orientation: 'landscape' })).toEqual({ width: 974, height: 627 });
  });

  it('余白が狭いほど、広い(本文の領域が大きい)', () => {
    const size = (margin: PageSettings['margin']) => contentSizePx({ ...DEFAULT_PAGE_SETTINGS, margin });
    expect(size('narrow').width).toBeGreaterThan(size('standard').width);
    expect(size('standard').width).toBeGreaterThan(size('wide').width);
    expect(size('narrow').height).toBeGreaterThan(size('standard').height);
    expect(size('standard').height).toBeGreaterThan(size('wide').height);
  });

  // 全30通りの、実際のPDFとの一致は、統合テスト(tests/pdf.integration.test.ts)で確かめる。ここでは、実測した値を固定する
  it.each([
    ['A4', 'portrait', 'narrow', 721, 1030],
    ['A4', 'portrait', 'wide', 609, 917],
    ['A3', 'portrait', 'standard', 974, 1421],
    ['A3', 'landscape', 'wide', 1402, 917],
    ['Letter', 'portrait', 'standard', 667, 889],
    ['B4', 'landscape', 'standard', 1227, 805],
    ['B5', 'portrait', 'standard', 539, 805],
    ['B5', 'landscape', 'wide', 786, 482],
  ] as const)('実測値(%s・%s・%s)', (paper, orientation, margin, width, height) => {
    expect(contentSizePx({ paper, orientation, margin, pageNumbers: true })).toEqual({ width, height });
  });

  it('ページ番号の有無では、変わらない(フッターは、余白の中に出る)', () => {
    for (const setting of everySetting()) {
      expect(contentSizePx({ ...setting, pageNumbers: false })).toEqual(contentSizePx(setting));
    }
  });

  it('全30通りで、正の大きさになる(用紙より小さい)', () => {
    for (const setting of everySetting()) {
      const size = contentSizePx(setting);
      const paper = paperMm(setting);
      expect(size.width, JSON.stringify(setting)).toBeGreaterThan(300);
      expect(size.height, JSON.stringify(setting)).toBeGreaterThan(300);
      expect(size.width, JSON.stringify(setting)).toBeLessThan((paper.width / 25.4) * 96);
      expect(size.height, JSON.stringify(setting)).toBeLessThan((paper.height / 25.4) * 96);
    }
  });
});

describe('paperMm・bodyHeightMm', () => {
  it('向きを反映した用紙の大きさ', () => {
    expect(paperMm(DEFAULT_PAGE_SETTINGS)).toEqual({ width: 210, height: 297 });
    expect(paperMm({ ...DEFAULT_PAGE_SETTINGS, orientation: 'landscape' })).toEqual({ width: 297, height: 210 });
  });

  it('本文の高さ: 用紙の高さ − 上下の余白(A4縦・標準は252mm)', () => {
    expect(bodyHeightMm(DEFAULT_PAGE_SETTINGS)).toBe(252);
    expect(bodyHeightMm({ ...DEFAULT_PAGE_SETTINGS, orientation: 'landscape' })).toBe(165);
    expect(bodyHeightMm({ paper: 'Letter', orientation: 'portrait', margin: 'standard', pageNumbers: true })).toBe(234.4);
  });
});

describe('表示名・比較', () => {
  it('すべての選択肢に、表示名がある', () => {
    for (const paper of PAPER_SIZES) expect(PAPER_LABELS[paper]).not.toBe('');
    for (const orientation of ORIENTATIONS) expect(ORIENTATION_LABELS[orientation]).not.toBe('');
    for (const margin of MARGIN_PRESETS) expect(MARGIN_LABELS[margin]).not.toBe('');
  });

  it('pageSettingsEqual: 4つの項目がすべて同じときだけ、真', () => {
    expect(pageSettingsEqual(DEFAULT_PAGE_SETTINGS, { ...DEFAULT_PAGE_SETTINGS })).toBe(true);
    expect(pageSettingsEqual(DEFAULT_PAGE_SETTINGS, { ...DEFAULT_PAGE_SETTINGS, pageNumbers: false })).toBe(false);
    expect(pageSettingsEqual(DEFAULT_PAGE_SETTINGS, { ...DEFAULT_PAGE_SETTINGS, paper: 'A3' })).toBe(false);
  });
});
