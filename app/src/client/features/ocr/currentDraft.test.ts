import { describe, expect, it } from 'vitest';
import { clearCurrentDraftId, loadCurrentDraftId, saveCurrentDraftId } from './currentDraft';

const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

const brokenStorage = {
  getItem: (): string | null => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: (): void => {
    throw new DOMException('quota', 'QuotaExceededError');
  },
  removeItem: (): void => {
    throw new DOMException('denied', 'SecurityError');
  },
};

describe('currentDraft', () => {
  it('保存したIDを読み出せ、消すと読み出せなくなる', () => {
    const storage = memoryStorage();

    expect(loadCurrentDraftId(storage)).toBeNull();
    saveCurrentDraftId('draft-1', storage);
    expect(loadCurrentDraftId(storage)).toBe('draft-1');
    expect(storage.data.get('rag-pdf-studio.ocr.currentDraft')).toBe('draft-1');
    clearCurrentDraftId(storage);
    expect(loadCurrentDraftId(storage)).toBeNull();
  });

  it('空文字は、保存されていないものとして扱う', () => {
    const storage = memoryStorage();
    storage.setItem('rag-pdf-studio.ocr.currentDraft', '');

    expect(loadCurrentDraftId(storage)).toBeNull();
  });

  it('localStorageが使えなくても(例外になっても)、例外を出さず、覚えないだけにする', () => {
    expect(loadCurrentDraftId(brokenStorage)).toBeNull();
    expect(() => saveCurrentDraftId('x', brokenStorage)).not.toThrow();
    expect(() => clearCurrentDraftId(brokenStorage)).not.toThrow();
  });

  it('保存先が無い(null)場合も、動く', () => {
    expect(loadCurrentDraftId(null)).toBeNull();
    expect(() => saveCurrentDraftId('x', null)).not.toThrow();
    expect(() => clearCurrentDraftId(null)).not.toThrow();
  });
});
