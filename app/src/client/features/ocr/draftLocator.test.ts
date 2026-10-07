import { describe, expect, it } from 'vitest';
import type { DiffSegment } from '../../ragApi';
import { findSegmentRange } from './draftLocator';

const segment = (overrides: Partial<DiffSegment>): DiffSegment => ({
  page: 1,
  segment_id: 'seg-0',
  glm_text: '',
  glm_alt_text: '',
  status: 'needs_review',
  final_text: '',
  reason: null,
  ...overrides,
});

const markdown = '## PDF 1ページ目\n\n散水装置が作動していませんか？\n\n## PDF 2ページ目\n\n散水装置が作動していませんか？ 異常\n';

describe('findSegmentRange', () => {
  it('採用テキストが本文中にあれば、その範囲を返す', () => {
    const range = findSegmentRange(markdown, segment({ page: 1, final_text: '散水装置が作動していませんか？' }));

    expect(range).not.toBeNull();
    expect(markdown.slice(range?.start, range?.end)).toBe('散水装置が作動していませんか？');
  });

  it('同じ文言が複数ページにあっても、該当ページの側を返す', () => {
    const range = findSegmentRange(markdown, segment({ page: 2, final_text: '散水装置が作動していませんか？' }));

    expect(range?.start).toBeGreaterThan(markdown.indexOf('## PDF 2ページ目'));
  });

  it('採用テキストが空なら、主文候補で探す', () => {
    const range = findSegmentRange(markdown, segment({ page: 2, final_text: '', glm_text: '異常' }));

    expect(markdown.slice(range?.start, range?.end)).toBe('異常');
  });

  it('前後の空白・改行は無視して探す', () => {
    expect(findSegmentRange(markdown, segment({ page: 1, final_text: '\n 散水装置が作動していませんか？ \n' }))).not.toBeNull();
  });

  it('ページの見出しが本文に無ければ、本文の先頭から探す', () => {
    const range = findSegmentRange('本文だけの下書き 異常', segment({ page: 3, final_text: '異常' }));

    expect(range).toEqual({ start: 9, end: 11 });
  });

  it('本文中に無い(編集済みなど)場合は、nullを返す', () => {
    expect(findSegmentRange(markdown, segment({ final_text: '存在しない文言' }))).toBeNull();
  });

  it('探す文字列が全て空なら、nullを返す', () => {
    expect(findSegmentRange(markdown, segment({ final_text: '  ', glm_text: '' }))).toBeNull();
  });
});
