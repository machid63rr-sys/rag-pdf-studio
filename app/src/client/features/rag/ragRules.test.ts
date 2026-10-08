import { describe, expect, it } from 'vitest';
import { RagApiError, type DocumentSummary, type SearchResult } from '../../ragApi';
import {
  addEquipmentNames, allLowRelevance, defaultRegistrationName, describeEquipmentNames, ensureMarkdownFileName, errorMessage, findExistingDocument, formatDateTime, formatFileSize,
  formatSimilarity, isLowRelevance, isMarkdownFileName, isPdfFileName, LOW_SIMILARITY_THRESHOLD, MAX_NAME_LENGTH, MAX_UPLOAD_BYTES, shouldSubmitOnEnter, similarityPercent,
  validateMarkdownFile, validatePdfFile, validateQuery, validateRegistrationName, validateTitle,
} from './ragRules';

const document = (overrides: Partial<DocumentSummary>): DocumentSummary => ({
  id: 'd1', title: 'R-1', source_file_name: 'R-1.md', equipment_names: [], chunk_count: 3, has_pdf: false, created_at: '2026-10-07T00:00:00Z', ...overrides,
});

const result = (similarity: number): SearchResult => ({ content: '本文', document_title: 'R-1', document_id: 'd1', similarity });

describe('ensureMarkdownFileName', () => {
  it.each([
    ['R-1', 'R-1.md'],
    ['R-1.md', 'R-1.md'],
    ['R-1.MD', 'R-1.MD'],
    ['メモ.markdown', 'メモ.markdown'],
    ['メモ.txt', 'メモ.txt'],
    ['R-1.pdf', 'R-1.pdf.md'],
    ['  R-1  ', 'R-1.md'],
  ])('%s → %s', (input, expected) => {
    expect(ensureMarkdownFileName(input)).toBe(expected);
  });

  it('空白だけなら空文字(.mdを補わない)', () => {
    expect(ensureMarkdownFileName('   ')).toBe('');
    expect(ensureMarkdownFileName('')).toBe('');
  });

  it('取り込んだファイル名からの初期値も、同じ規則', () => {
    expect(defaultRegistrationName('AHU-1')).toBe('AHU-1.md');
    expect(defaultRegistrationName('AHU-1.md')).toBe('AHU-1.md');
  });
});

describe('validateRegistrationName', () => {
  it('普通の名前は問題なし', () => {
    expect(validateRegistrationName('R-1.md')).toBeNull();
    expect(validateRegistrationName('空冷モジュールチラー.md')).toBeNull();
  });

  it.each([[''], ['.md'], ['.txt']])('名前の本体が空(%s)は、入力を促す', (name) => {
    expect(validateRegistrationName(name)).toBe('登録名を入力してください。');
  });

  it.each([['a/b.md'], ['..\\a.md']])('パス区切り(%s)は使えない(サーバは黙って末尾だけにするため、先に断る)', (name) => {
    expect(validateRegistrationName(name)).toContain('使えません');
  });

  it('255文字ちょうどは通り、256文字は断る', () => {
    expect(validateRegistrationName(`${'あ'.repeat(MAX_NAME_LENGTH - 3)}.md`)).toBeNull();
    expect(validateRegistrationName(`${'あ'.repeat(MAX_NAME_LENGTH - 2)}.md`)).toContain('長すぎます');
  });
});

describe('validateTitle', () => {
  it('空は問題なし(登録名から作られる)', () => {
    expect(validateTitle('')).toBeNull();
  });

  it('255文字までは通り、超えると断る(前後の空白は数えない)', () => {
    expect(validateTitle(` ${'あ'.repeat(255)} `)).toBeNull();
    expect(validateTitle('あ'.repeat(256))).toContain('長すぎます');
  });
});

describe('findExistingDocument', () => {
  it('同じ登録名(ファイル名)の文書を返す。題名が同じだけでは一致しない', () => {
    const docs = [document({ id: 'a', source_file_name: 'A.md', title: 'R-1' }), document({ id: 'b', source_file_name: 'R-1.md', title: '別名' })];

    expect(findExistingDocument(docs, 'R-1.md')?.id).toBe('b');
    expect(findExistingDocument(docs, 'C.md')).toBeNull();
  });

  it('大文字小文字は区別する(サーバのunique制約と同じ)', () => {
    expect(findExistingDocument([document({ source_file_name: 'r-1.md' })], 'R-1.md')).toBeNull();
  });
});

describe('addEquipmentNames', () => {
  it('1つ追加する。前後の空白は除く', () => {
    expect(addEquipmentNames([], '  ESP-1 ')).toEqual({ ok: true, names: ['ESP-1'] });
  });

  it('カンマ(半角・全角・読点)区切りで、複数を追加する。順序は入力順で、既存の後ろ', () => {
    expect(addEquipmentNames(['AHU-1'], 'ESP-1, ESP-2，R-1、R-2')).toEqual({ ok: true, names: ['AHU-1', 'ESP-1', 'ESP-2', 'R-1', 'R-2'] });
  });

  it('空・区切りだけは断る', () => {
    expect(addEquipmentNames([], '   ')).toEqual({ ok: false, message: 'タグ名を入力してください。' });
    expect(addEquipmentNames([], ',，、')).toEqual({ ok: false, message: 'タグ名を入力してください。' });
  });

  it('既存と重複する名前は断る', () => {
    expect(addEquipmentNames(['ESP-1'], 'ESP-1')).toEqual({ ok: false, message: '「ESP-1」は既に追加されています。' });
  });

  it('入力の中での重複も断る', () => {
    expect(addEquipmentNames([], 'ESP-1,ESP-1')).toMatchObject({ ok: false });
  });

  it('255文字超は断る。1つでも問題があれば、1つも追加しない', () => {
    const result = addEquipmentNames(['AHU-1'], `ESP-1,${'あ'.repeat(256)}`);

    expect(result).toMatchObject({ ok: false });
    expect(addEquipmentNames([], 'あ'.repeat(255))).toMatchObject({ ok: true });
  });

  it('現在の一覧は書き換えない', () => {
    const current = ['AHU-1'];
    addEquipmentNames(current, 'ESP-1');

    expect(current).toEqual(['AHU-1']);
  });
});

describe('describeEquipmentNames', () => {
  it('空なら「共通(タグなし)」、あれば読点でつなぐ', () => {
    expect(describeEquipmentNames([])).toBe('共通(タグなし)');
    expect(describeEquipmentNames(['R-1', 'R-2'])).toBe('R-1、R-2');
  });
});

describe('ファイルの検証', () => {
  it('拡張子(大文字小文字を問わない)', () => {
    expect(isMarkdownFileName('a.MD')).toBe(true);
    expect(isMarkdownFileName('a.docx')).toBe(false);
    expect(isPdfFileName('a.PDF')).toBe(true);
    expect(isPdfFileName('a.pdf.txt')).toBe(false);
  });

  it('Markdown: 問題なし・拡張子違い・空・大きすぎる', () => {
    expect(validateMarkdownFile({ name: 'R-1.md', size: 10 })).toBeNull();
    expect(validateMarkdownFile({ name: 'R-1.docx', size: 10 })).toContain('Markdown(.md / .markdown / .txt)のファイルを選んでください');
    expect(validateMarkdownFile({ name: 'R-1.md', size: 0 })).toContain('空です');
    expect(validateMarkdownFile({ name: 'R-1.md', size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(validateMarkdownFile({ name: 'R-1.md', size: MAX_UPLOAD_BYTES + 1 })).toContain('上限 100MB');
  });

  it('PDF: 問題なし・PDF以外・空・大きすぎる', () => {
    expect(validatePdfFile({ name: 'R-1.pdf', size: 10 })).toBeNull();
    expect(validatePdfFile({ name: 'R-1.md', size: 10 })).toContain('.pdf');
    expect(validatePdfFile({ name: 'R-1.pdf', size: 0 })).toContain('空です');
    expect(validatePdfFile({ name: 'R-1.pdf', size: MAX_UPLOAD_BYTES + 1 })).toContain('大きすぎます');
  });

  it('大きさの表記', () => {
    expect(formatFileSize(1)).toBe('1KB');
    expect(formatFileSize(1500)).toBe('2KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0MB');
    expect(formatFileSize(3.5 * 1024 * 1024)).toBe('3.5MB');
  });
});

describe('shouldSubmitOnEnter', () => {
  it('通常のEnterは実行する', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true);
  });

  it('日本語入力の変換中のEnter(isComposing)は実行しない', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: true, keyCode: 13 })).toBe(false);
  });

  it('keyCode 229(Safariなどの変換中)も実行しない', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false);
  });

  it('Enter以外は実行しない', () => {
    expect(shouldSubmitOnEnter({ key: 'a', isComposing: false, keyCode: 65 })).toBe(false);
  });
});

describe('類似度', () => {
  it('しきい値(0.5)未満が「関連度が低い」。ちょうど0.5は低くない', () => {
    expect(LOW_SIMILARITY_THRESHOLD).toBe(0.5);
    expect(isLowRelevance(0.49)).toBe(true);
    expect(isLowRelevance(0.5)).toBe(false);
    expect(isLowRelevance(0.78)).toBe(false);
  });

  it('全件が低いときだけ true(0件・1件でも高いものがあれば false)', () => {
    expect(allLowRelevance([])).toBe(false);
    expect(allLowRelevance([result(0.4), result(0.3)])).toBe(true);
    expect(allLowRelevance([result(0.4), result(0.6)])).toBe(false);
  });

  it('表記は小数第2位、棒の長さは0〜100に収める', () => {
    expect(formatSimilarity(0.7345)).toBe('0.73');
    expect(formatSimilarity(1)).toBe('1.00');
    expect(similarityPercent(0.734)).toBe(73);
    expect(similarityPercent(-0.2)).toBe(0);
    expect(similarityPercent(1.3)).toBe(100);
  });

  it('質問文の検証', () => {
    expect(validateQuery('ポンプ')).toBeNull();
    expect(validateQuery('   ')).toBe('質問文を入力してください。');
    expect(validateQuery('あ'.repeat(2001))).toContain('長すぎます');
    expect(validateQuery('あ'.repeat(2000))).toBeNull();
  });
});

describe('表示', () => {
  it('日時を日本語の表記にする(時間帯を指定できる)', () => {
    expect(formatDateTime('2026-10-07T00:30:00Z', 'Asia/Tokyo')).toBe('2026/10/7 9:30:00');
  });

  it('日時として読めない文字列は、そのまま返す', () => {
    expect(formatDateTime('不明')).toBe('不明');
  });

  it('エラーの文言: RagApiError・Error・その他', () => {
    expect(errorMessage(new RagApiError('接続できません', 0, 'network'))).toBe('接続できません');
    expect(errorMessage(new Error('失敗'))).toBe('失敗');
    expect(errorMessage('文字列')).toBe('文字列');
  });
});
