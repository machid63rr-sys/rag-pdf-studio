import { parseDraft, type Draft } from './draft';

/*
 * 下書きの保存先。ブラウザのIndexedDB(文字列の長い文書も、保存できる)に、最新の下書きを1つだけ残す。
 * 使えない場合(プライベートウィンドウなど)は、何もしない保存先になる(編集・出力は、そのまま使える)。
 */

export interface DraftStorage {
  /** 保存してある下書き。無い・読めない場合は null(例外にしない) */
  load(): Promise<Draft | null>;
  /** 下書きを保存する(前の下書きは置き換わる)。保存できなければ、理由つきで例外にする */
  save(draft: Draft): Promise<void>;
  /** 下書きを消す(失敗しても、例外にしない) */
  clear(): Promise<void>;
}

const DB_NAME = 'md-pdf-editor';
const STORE = 'drafts';
const KEY = 'current';

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      // ほかのタブが、データベースを消す・作り直すときに、待たせない
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDBを開けません'));
    request.onblocked = () => reject(new Error('IndexedDBを開けません(ほかのタブが使用中です)'));
  });
}

// トランザクションが完了してから(書き込みが確定してから)結果を返す。容量不足などは、abort として届く
function run<T>(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDBの操作に失敗しました'));
    transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('IndexedDBの操作が中止されました'));
  });
}

/** IndexedDB に保存する。factory が無い(使えない)場合は、何もしない保存先にする */
export function createIndexedDbDraftStorage(factory: IDBFactory | undefined = globalThis.indexedDB): DraftStorage {
  if (factory === undefined) {
    return createNoopDraftStorage();
  }
  // 接続は1つにして、操作を、呼んだ順に実行させる(保存の直後の削除が、先に実行されて、下書きが残ることを防ぐ)
  let opened: Promise<IDBDatabase> | undefined;
  const database = (): Promise<IDBDatabase> => {
    opened ??= openDatabase(factory).catch((cause: unknown) => {
      opened = undefined;
      throw cause;
    });
    return opened;
  };
  return {
    async load() {
      try {
        return parseDraft(await run(await database(), 'readonly', (store) => store.get(KEY)));
      } catch {
        return null;
      }
    },
    async save(draft) {
      try {
        await run(await database(), 'readwrite', (store) => store.put(draft, KEY));
      } catch (cause) {
        throw new Error(messageOf(cause), { cause });
      }
    },
    async clear() {
      try {
        await run(await database(), 'readwrite', (store) => store.delete(KEY));
      } catch {
        // 消せなくても、編集・出力には影響しない
      }
    },
  };
}

/** 何も保存しない保存先(IndexedDBが無い環境用) */
export function createNoopDraftStorage(): DraftStorage {
  return { load: () => Promise.resolve(null), save: () => Promise.resolve(), clear: () => Promise.resolve() };
}

/** メモリ上の保存先(テスト用) */
export function createMemoryDraftStorage(): DraftStorage & { current: Draft | null; saves: number; failWith: Error | undefined } {
  const storage = {
    current: null as Draft | null,
    saves: 0,
    failWith: undefined as Error | undefined,
    load: () => Promise.resolve(storage.current),
    save: (draft: Draft) => {
      if (storage.failWith !== undefined) {
        return Promise.reject(storage.failWith);
      }
      storage.current = draft;
      storage.saves += 1;
      return Promise.resolve();
    },
    clear: () => {
      storage.current = null;
      return Promise.resolve();
    },
  };
  return storage;
}

/** 画面が使う保存先(IndexedDB) */
export const draftStorage: DraftStorage = createIndexedDbDraftStorage();
