/*
 * ページの区切りの測定に送る内容を軽くする。
 * 測るのに必要なのは、画像の「大きさ」だけで、中身ではない。数MBの画像を、編集のたびに送らないよう、
 * 画像のデータ(data: URI)を、同じ大きさの、空のSVG画像に置き換える(Markdownの本文・取り込んだ画像の両方)。
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

// 画像(data: URI)の大きさ。読み取れなければ null
export type ImageSizer = (uri: string) => Promise<ImageSize | null>;

const DATA_IMAGE = /data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+/gi;

// 大きな文字列を、保持せずに見分けるための、短い目印(FNV-1a)
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

const placeholderOf = ({ width, height }: ImageSize): string =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`)}`;

const MAX_REMEMBERED = 100;

/** ブラウザで、画像の大きさを調べる。同じ画像は、覚えておいて、再び調べない */
export function createBrowserImageSizer(): ImageSizer {
  const remembered = new Map<string, ImageSize | null>();
  return async (uri) => {
    const key = fingerprint(uri);
    if (remembered.has(key)) {
      return remembered.get(key) ?? null;
    }
    let size: ImageSize | null = null;
    try {
      const image = new Image();
      image.src = uri;
      await image.decode();
      size = image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null;
    } catch {
      size = null;
    }
    remembered.set(key, size);
    if (remembered.size > MAX_REMEMBERED) {
      remembered.delete(remembered.keys().next().value as string);
    }
    return size;
  };
}

export interface LightPayload {
  readonly markdown: string;
  readonly assets: Readonly<Record<string, string>>;
}

/** Markdownと取り込んだ画像の、data: URI の画像を、同じ大きさの空の画像に置き換える(大きさを読めない画像は、そのまま) */
export async function withImagePlaceholders(markdown: string, assets: Readonly<Record<string, string>>, sizer: ImageSizer): Promise<LightPayload> {
  const replacements = new Map<string, string>();
  const uris = new Set<string>([...(markdown.match(DATA_IMAGE) ?? []), ...Object.values(assets).filter((value) => /^data:image\//i.test(value))]);
  for (const uri of uris) {
    const size = await sizer(uri);
    if (size !== null) {
      replacements.set(uri, placeholderOf(size));
    }
  }
  const replaceIn = (text: string): string => text.replace(DATA_IMAGE, (uri) => replacements.get(uri) ?? uri);
  return {
    markdown: replaceIn(markdown),
    assets: Object.fromEntries(Object.entries(assets).map(([path, uri]) => [path, replacements.get(uri) ?? uri])),
  };
}
