import { useEffect, useRef, useState } from 'react';
import type { DraftContent } from './draft';
import { DraftSaver, type SaveState } from './draftSaver';
import type { DraftStorage } from './draftStorage';

/**
 * 編集中の文書を、自動保存する(draftSaver.ts)。content は、元の文書から変わっていなければ null。
 * - 保存が済んでいない編集があるときと、保存に失敗したときだけ、タブを閉じる前に、ブラウザの警告を出す
 * - タブを隠す・閉じるときは、待たずに保存を試みる
 */
export function useDraftAutosave(storage: DraftStorage, content: DraftContent | null): SaveState {
  const [state, setState] = useState<SaveState>({ pending: false, error: null, savedAt: null });
  const saver = useRef<DraftSaver | null>(null);
  saver.current ??= new DraftSaver(storage, setState);

  useEffect(() => {
    saver.current?.update(content);
  }, [content]);

  useEffect(() => {
    const current = saver.current;
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') {
        void current?.flush();
      }
    };
    const flush = (): void => void current?.flush();
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flush);
      current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!state.pending) {
      return undefined;
    }
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.pending]);

  return state;
}
