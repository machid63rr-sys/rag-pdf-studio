import type { BundleFile } from './assets';

/*
 * フォルダの取り込み。フォルダのドラッグ&ドロップ(FileSystemEntry)と、フォルダの選択(<input webkitdirectory>)の
 * どちらからも、「ルートからの相対パスつきのファイル一覧」にする。
 * 中身は、ここでは読まない(文書・参照されているCSS・画像だけが、必要になったときに読まれる)。
 */

// 巨大なフォルダ(node_modulesなど)を丸ごと取り込んでしまうのを防ぐ
export const MAX_FOLDER_FILES = 5000;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export class FolderError extends Error {}

// 「.git」「.DS_Store」のような「.」で始まる名前と、node_modulesは、取り込まない
export const isIgnoredName = (name: string): boolean => name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);

const tooMany = (): FolderError =>
  new FolderError(`フォルダの中のファイルが多すぎます(${MAX_FOLDER_FILES}個まで)。取り込みたいファイルだけを入れた、小さなフォルダにしてください。`);

/** フォルダを選択(<input webkitdirectory>)したときのファイル一覧。パスは、選んだフォルダからの相対パスにする */
export function fromDirectoryInput(files: ArrayLike<File>): BundleFile[] {
  const result: BundleFile[] = [];
  for (const file of Array.from(files)) {
    // webkitRelativePath は「選んだフォルダ名/下位のパス」。先頭の、選んだフォルダ名は除く
    const segments = (file.webkitRelativePath || file.name).split('/');
    const path = segments.length > 1 ? segments.slice(1).join('/') : (segments[0] ?? file.name);
    if (segments.slice(segments.length > 1 ? 1 : 0).some(isIgnoredName)) {
      continue;
    }
    result.push({ path, file });
    if (result.length > MAX_FOLDER_FILES) {
      throw tooMany();
    }
  }
  return result;
}

// ドロップされたもの(FileSystemEntry)の、必要な部分だけ。テストでは、メモリ上の代役を渡す
export interface EntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
}
export interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (error: Error) => void): void;
}
export interface DirectoryEntryLike extends EntryLike {
  createReader(): { readEntries(success: (entries: EntryLike[]) => void, failure?: (error: Error) => void): void };
}

const readFile = (entry: FileEntryLike): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));

// readEntriesは、1回に一部(Chromeでは100件)しか返さないため、空になるまで繰り返す
async function readChildren(entry: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader();
  const children: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) {
      return children;
    }
    children.push(...batch);
  }
}

/**
 * ドロップされたもの(フォルダ・ファイル)のファイル一覧。フォルダ1つだけなら、そのフォルダをルートにする。
 * 複数をまとめてドロップした場合は、ドロップしたフォルダ名が、パスの先頭に付く。
 */
export async function collectDropped(dropped: readonly EntryLike[]): Promise<BundleFile[]> {
  const result: BundleFile[] = [];

  async function walk(entry: EntryLike, prefix: string): Promise<void> {
    if (isIgnoredName(entry.name)) {
      return;
    }
    if (entry.isFile) {
      result.push({ path: prefix + entry.name, file: await readFile(entry as FileEntryLike) });
      if (result.length > MAX_FOLDER_FILES) {
        throw tooMany();
      }
    } else if (entry.isDirectory) {
      for (const child of await readChildren(entry as DirectoryEntryLike)) {
        await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }

  const [only] = dropped;
  if (dropped.length === 1 && only?.isDirectory) {
    for (const child of await readChildren(only as DirectoryEntryLike)) {
      await walk(child, '');
    }
  } else {
    for (const entry of dropped) {
      await walk(entry, '');
    }
  }
  return result;
}
