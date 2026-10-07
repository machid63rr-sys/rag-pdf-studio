import { basenameOf, classifyReference } from '../shared/assetPath';

/*
 * 取り込んだファイル一式(HTML・CSS・画像など)。
 * 文書(HTML・CSS・Markdown)の中の参照を、この一式の中のファイルへ解決し、画像は必要になったときに読み込む。
 * 画像は、描画のときだけ使う(保存するファイルは書き換えない)。
 * - プレビュー・エディタ: blob URL(軽量。巨大な文字列をiframeに埋め込まずに済む)
 * - PDF生成: data: URI(サーバへ文書と一緒に送るため)
 */

// ブラウザのFileと同じ形。テストでは、メモリ上の代役を渡す
export interface FileLike {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BundleFile {
  // 取り込んだ一式のルートからの相対パス('/' 区切り)。ファイルを個別に選んだ場合は、ファイル名
  readonly path: string;
  readonly file: FileLike;
}

// PDFに表示できる画像の種類(サーバが受け付ける data: URI の種類と同じ)
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function imageMimeOf(path: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : IMAGE_MIME[extension];
}

export const isImagePath = (path: string): boolean => imageMimeOf(path) !== undefined;

// 大きなバッファでも、引数の数の上限に当たらないよう、少しずつ文字列にする
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

interface LoadedImage {
  readonly buffer: ArrayBuffer;
  readonly mime: string;
}

export class AssetStore {
  private readonly byPath = new Map<string, BundleFile>();
  private readonly byLowerPath = new Map<string, BundleFile[]>();
  private readonly byLowerName = new Map<string, BundleFile[]>();
  private readonly loaded = new Map<string, LoadedImage>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly dataUris = new Map<string, string>();
  private readonly blobUrls = new Map<string, string>();

  /**
   * @param structured フォルダごと取り込んだ(フォルダ構成が分かる)場合 true。
   *   false(ファイルを個別に選んだ)の場合は、フォルダ構成が分からないため、参照が見つからなければ、
   *   同じファイル名のファイルが1つだけある場合に限り、それを使う。
   */
  constructor(
    readonly files: readonly BundleFile[],
    private readonly structured: boolean,
  ) {
    const push = (map: Map<string, BundleFile[]>, key: string, file: BundleFile): void => {
      map.set(key, [...(map.get(key) ?? []), file]);
    };
    for (const file of files) {
      this.byPath.set(file.path, file);
      push(this.byLowerPath, file.path.toLowerCase(), file);
      push(this.byLowerName, basenameOf(file.path).toLowerCase(), file);
    }
  }

  /** 文書内の参照(baseDir: 参照が書かれたファイルのフォルダ)を、一式の中のファイルのパスへ解決する。無ければ undefined */
  resolve(reference: string, baseDir: string): string | undefined {
    const parsed = classifyReference(reference, baseDir);
    if (parsed.kind !== 'local' || parsed.path === null) {
      return undefined;
    }
    if (this.byPath.has(parsed.path)) {
      return parsed.path;
    }
    // Windowsで作られた文書は、大文字小文字が実際のファイル名と違うことがある(一意に決まる場合だけ使う)
    const sameCase = this.byLowerPath.get(parsed.path.toLowerCase());
    if (sameCase?.length === 1) {
      return sameCase[0]?.path;
    }
    if (!this.structured) {
      const sameName = this.byLowerName.get(basenameOf(parsed.path).toLowerCase());
      if (sameName?.length === 1) {
        return sameName[0]?.path;
      }
    }
    return undefined;
  }

  /** PDF生成のための、画像の data: URI。まだ読み込んでいない(または画像でない)場合は undefined */
  dataUri(path: string): string | undefined {
    const cached = this.dataUris.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const image = this.loaded.get(path);
    if (image === undefined) {
      return undefined;
    }
    const uri = `data:${image.mime};base64,${toBase64(image.buffer)}`;
    this.dataUris.set(path, uri);
    return uri;
  }

  /** プレビュー・エディタでの表示のための、画像のURL(blob URL)。まだ読み込んでいない(または画像でない)場合は undefined */
  previewUrl(path: string): string | undefined {
    const cached = this.blobUrls.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const image = this.loaded.get(path);
    if (image === undefined) {
      return undefined;
    }
    const url = URL.createObjectURL(new Blob([image.buffer], { type: image.mime }));
    this.blobUrls.set(path, url);
    return url;
  }

  /** 画像を読み込む(同じファイルは1回だけ)。画像でないファイル・読めないファイルは、何もしない */
  ensure(paths: Iterable<string>): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const path of new Set(paths)) {
      const pending = this.loading.get(path) ?? this.load(path);
      tasks.push(pending);
    }
    return Promise.all(tasks).then(() => undefined);
  }

  /** ensure で、新しく読み込まれたファイルがあるか(表示の更新が必要か)を知るための数 */
  get loadedCount(): number {
    return this.loaded.size;
  }

  private load(path: string): Promise<void> {
    const mime = imageMimeOf(path);
    const file = this.byPath.get(path);
    const task =
      mime === undefined || file === undefined
        ? Promise.resolve()
        : file.file.arrayBuffer().then(
            (buffer) => {
              this.loaded.set(path, { buffer, mime });
            },
            () => undefined, // 読み込めない画像は、表示されない(参照の解決はできているため、警告の対象にはならない)
          );
    this.loading.set(path, task);
    return task;
  }
}
