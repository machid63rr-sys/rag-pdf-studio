import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_SETTINGS } from '../shared/pageSettings';
import type { DraftContent } from './draft';
import { DraftSaver, SAVE_DELAY_MS, type SaveState } from './draftSaver';
import { createMemoryDraftStorage, type DraftStorage } from './draftStorage';

const content = (markdown: string): DraftContent => ({ kind: 'markdown', sourceName: 'a.md', baseDir: '', markdown, pageSettings: DEFAULT_PAGE_SETTINGS });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(storage: DraftStorage = createMemoryDraftStorage()) {
  const states: SaveState[] = [];
  const saver = new DraftSaver(storage, (state) => states.push(state), SAVE_DELAY_MS, () => 1234);
  return { saver, states, last: (): SaveState => states[states.length - 1] as SaveState };
}

describe('DraftSaver(下書きの自動保存)', () => {
  it('編集が止まってから(遅れて)保存する。保存するまでは「未保存」、保存したら「保存済み」', async () => {
    const storage = createMemoryDraftStorage();
    const { saver, last } = setup(storage);
    saver.update(content('# A'));
    expect(last()).toEqual({ pending: true, error: null, savedAt: null });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    expect(storage.saves).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(storage.saves).toBe(1);
    expect(storage.current).toEqual({ ...content('# A'), version: 1, savedAt: 1234 });
    expect(last()).toEqual({ pending: false, error: null, savedAt: 1234 });
  });

  it('編集が続く間は、保存しない。最後の内容だけを、1回保存する', async () => {
    const storage = createMemoryDraftStorage();
    const { saver } = setup(storage);
    saver.update(content('1'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 100);
    saver.update(content('12'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 100);
    saver.update(content('123'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(storage.saves).toBe(1);
    expect(storage.current).toMatchObject({ markdown: '123' });
  });

  it('編集のない文書(null)は、保存しない。保存待ちも、取りやめる', async () => {
    const storage = createMemoryDraftStorage();
    const { saver, last } = setup(storage);
    saver.update(content('# A'));
    saver.update(null);
    expect(last()).toEqual({ pending: false, error: null, savedAt: null });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(storage.saves).toBe(0);
  });

  it('保存した後で、元の文書に戻した(null)ときは、保存した下書きを消す(古い編集を、再開に出さない)', async () => {
    const storage = createMemoryDraftStorage();
    const { saver, last } = setup(storage);
    saver.update(content('# A'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(storage.current).not.toBeNull();

    saver.update(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.current).toBeNull();
    expect(last()).toEqual({ pending: false, error: null, savedAt: null });
  });

  it('保存できなかったときは、理由を持った「未保存」のまま。次の編集で、もう一度試し、保存できたら、理由は消える', async () => {
    const storage = createMemoryDraftStorage();
    storage.failWith = new Error('QuotaExceededError');
    const { saver, last } = setup(storage);
    saver.update(content('# A'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(last()).toEqual({ pending: true, error: 'QuotaExceededError', savedAt: null });

    storage.failWith = undefined;
    saver.update(content('# AB'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(last()).toEqual({ pending: false, error: null, savedAt: 1234 });
    expect(storage.current).toMatchObject({ markdown: '# AB' });
  });

  it('flush: 待たずに、いますぐ保存する。保存済みの内容は、もう一度保存しない', async () => {
    const storage = createMemoryDraftStorage();
    const { saver, last } = setup(storage);
    saver.update(content('# A'));
    await saver.flush();
    expect(storage.saves).toBe(1);
    expect(last().pending).toBe(false);
    await saver.flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(storage.saves).toBe(1);
  });

  it('保存している最中に内容が変わったら、その保存では「保存済み」にならず、変えた内容も保存される', async () => {
    let release: () => void = () => undefined;
    const saved: string[] = [];
    const slow: DraftStorage = {
      load: () => Promise.resolve(null),
      save: (draft) =>
        new Promise<void>((resolve) => {
          release = () => {
            saved.push(draft.kind === 'markdown' ? draft.markdown : '');
            resolve();
          };
        }),
      clear: () => Promise.resolve(),
    };
    const { saver, last } = setup(slow);
    saver.update(content('first'));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS); // 保存を開始(まだ終わらない)
    saver.update(content('second'));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual(['first']);
    expect(last().pending).toBe(true);

    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual(['first', 'second']);
    expect(last().pending).toBe(false);
  });

  it('dispose: 保存待ちを取りやめる(画面を閉じたあとに、保存しない)', async () => {
    const storage = createMemoryDraftStorage();
    const { saver } = setup(storage);
    saver.update(content('# A'));
    saver.dispose();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(storage.saves).toBe(0);
  });
});
