/*
 * 選択された出力先フォルダへ、選ばれたファイル(MD・HTML・CSS・PDFなど、1つ以上)を書き込む。
 * ファイル名には、サブフォルダを含められる(例: css/style.css)。無ければ、サブフォルダを作る。
 * File System Access API の型そのものではなく、必要な操作だけを表すインターフェースに依存する
 * (実物の FileSystemDirectoryHandle はそのまま渡せる。テストでは、メモリ上の実装を渡す)。
 */

export interface WritableLike {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}

export interface DirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
  removeEntry(name: string): Promise<void>;
}

export interface PermissionLike {
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
}

export interface OutputEntry {
  // ファイル名(拡張子つき。サブフォルダを含む場合は '/' 区切り)
  readonly name: string;
  readonly data: string | Blob;
}

export interface OutputRequest {
  readonly directory: DirectoryLike;
  // 書き込むファイル。ここに無いファイルは、存在確認・上書き確認の対象にもしない
  readonly files: readonly OutputEntry[];
  // 既存のファイルがある場合に、上書きしてよいかを尋ねる。falseなら何も書かない
  readonly confirmOverwrite: (existingNames: readonly string[]) => boolean | Promise<boolean>;
}

export interface OutputFailure {
  readonly name: string;
  readonly message: string;
}

export interface OutputReport {
  // 上書き確認で断られ、何も書かなかった場合 true
  readonly cancelled: boolean;
  readonly written: readonly string[];
  readonly failed: readonly OutputFailure[];
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isNotFound = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'NotFoundError';

// 'css/style.css' -> ['css', 'style.css']。保存先の外へ出る書き方('..')や、使えない文字は、書き込む前に断る
function segmentsOf(path: string): string[] {
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[\\:*?"<>|\u0000-\u001f]/.test(segment))) {
    throw new Error(`保存するファイルの名前が不正です: ${path}`);
  }
  return segments;
}

// ファイルを置くフォルダ(サブフォルダ)を開く。create なら、無いフォルダは作る
async function parentOf(root: DirectoryLike, segments: readonly string[], create: boolean): Promise<DirectoryLike> {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function exists(root: DirectoryLike, path: string): Promise<boolean> {
  const segments = segmentsOf(path);
  try {
    const directory = await parentOf(root, segments, false);
    await directory.getFileHandle(segments[segments.length - 1] as string);
    return true;
  } catch (cause) {
    if (isNotFound(cause)) {
      return false; // ファイルが無い。または、置くサブフォルダが、まだ無い
    }
    // 同名のフォルダがある、権限が無いなど、存在確認自体ができない場合は、書き込みに進まず呼び出し元へ伝える
    throw cause;
  }
}

// 書き込みは一時領域へ行われ、close()で確定する。失敗時はabort()で破棄し、壊れた内容を残さない。
// 新規作成したファイルは、作成時点で空ファイルができているため、失敗時にそれも削除する
async function writeFile(root: DirectoryLike, path: string, data: string | Blob, existedBefore: boolean): Promise<void> {
  const segments = segmentsOf(path);
  const name = segments[segments.length - 1] as string;
  const directory = await parentOf(root, segments, true);
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (cause) {
    try {
      await writable.abort();
    } catch {
      // 破棄の失敗は、元の書き込み失敗の原因を覆い隠さないよう、ここでは扱わない
    }
    if (!existedBefore) {
      try {
        await directory.removeEntry(name);
      } catch {
        throw new Error(`${messageOf(cause)} (空のファイルが残っている可能性があります)`, { cause });
      }
    }
    throw cause;
  }
}

export async function writeOutputs(request: OutputRequest): Promise<OutputReport> {
  // 不正な名前が1つでもあれば、何も書かずに断る
  for (const { name } of request.files) {
    segmentsOf(name);
  }
  const existing: string[] = [];
  for (const { name } of request.files) {
    if (await exists(request.directory, name)) {
      existing.push(name);
    }
  }
  if (existing.length > 0 && !(await request.confirmOverwrite(existing))) {
    return { cancelled: true, written: [], failed: [] };
  }

  // 複数保存する場合、1つが失敗しても残りは書き、成否をファイルごとに報告する
  const written: string[] = [];
  const failed: OutputFailure[] = [];
  for (const { name, data } of request.files) {
    try {
      await writeFile(request.directory, name, data, existing.includes(name));
      written.push(name);
    } catch (cause) {
      failed.push({ name, message: messageOf(cause) });
    }
  }
  return { cancelled: false, written, failed };
}

/**
 * 出力先フォルダへの書き込み権限を確保する。クリック直後(ユーザー操作の有効期間内)に呼ぶこと。
 * 権限を確認する手段が無い環境では何もしない(その場合の書き込み失敗は、writeOutputsが報告する)。
 */
export async function ensureReadWrite(handle: PermissionLike): Promise<void> {
  const descriptor = { mode: 'readwrite' } as const;
  if (typeof handle.queryPermission !== 'function') {
    return;
  }
  if ((await handle.queryPermission(descriptor)) === 'granted') {
    return;
  }
  if (typeof handle.requestPermission !== 'function' || (await handle.requestPermission(descriptor)) !== 'granted') {
    throw new Error('出力先フォルダへの書き込みが許可されませんでした。もう一度フォルダを選択してください。');
  }
}
