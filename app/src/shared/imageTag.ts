import { parseFragment } from 'parse5';

/*
 * Markdownの中に書かれた <img> タグ(例: <img src="a.png" width="300" height="166" />)を、画像として読む。
 *
 * Markdownの画像記法 ![代替文](パス) には、大きさを指定する方法が無いため、エディタ(MDXEditor)は、
 * 画像の大きさを変えると、その画像を <img width="…" height="…"> というHTMLのタグで書き出す。
 * Markdownの中のHTMLは、PDFでは文字として表示される(実行も、解釈もしない)が、このタグだけは、
 * 画像として扱う。そうしないと、大きさを変えた画像が、PDFで、タグの文字になってしまう。
 *
 * 画像として読むのは、<img> のタグだけで構成された内容(タグの間の空白は可)。
 * 使う属性は src・alt・title・width・height だけで、それ以外の属性(style・onerror など)は、無視する(出力しない)。
 * src が無いもの、<img> 以外のタグ・文字・コメントが混ざるものは、画像として読まない(null)。
 */

export interface ImageTag {
  readonly src: string;
  readonly alt: string;
  readonly title: string | undefined;
  // 数字(px)または「50%」の形だけ。それ以外は無視する
  readonly width: string | undefined;
  readonly height: string | undefined;
}

const DIMENSION = /^\d{1,5}(?:\.\d{1,6})?%?$/;

const dimensionOf = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && DIMENSION.test(trimmed) ? trimmed : undefined;
};

/** <img> タグだけからなるHTMLなら、そのタグの一覧。そうでなければ null */
export function parseImageTags(html: string): ImageTag[] | null {
  const tags: ImageTag[] = [];
  for (const node of parseFragment(html).childNodes) {
    if (node.nodeName === '#text') {
      if ((node as { value: string }).value.trim() !== '') {
        return null;
      }
      continue;
    }
    if (node.nodeName !== 'img') {
      return null;
    }
    const attributes = new Map((node as { attrs: { name: string; value: string }[] }).attrs.map((attribute) => [attribute.name, attribute.value]));
    const src = attributes.get('src')?.trim() ?? '';
    if (src === '') {
      return null;
    }
    tags.push({
      src,
      alt: attributes.get('alt') ?? '',
      title: attributes.get('title'),
      width: dimensionOf(attributes.get('width')),
      height: dimensionOf(attributes.get('height')),
    });
  }
  return tags.length > 0 ? tags : null;
}

// 1行の文章の中の、<img> のタグらしい部分(タグの中に、> を含む属性値は、対象外)
const IMG_TAG = /<img\b[^<>]*>/gi;

/** 1行の中にある、画像として読める <img> タグ。それぞれの元の文字と、タグの内容 */
export function imageTagsIn(line: string): { readonly text: string; readonly tag: ImageTag }[] {
  return [...line.matchAll(IMG_TAG)].flatMap((match) => {
    const tag = parseImageTags(match[0])?.[0];
    return tag === undefined ? [] : [{ text: match[0], tag }];
  });
}
