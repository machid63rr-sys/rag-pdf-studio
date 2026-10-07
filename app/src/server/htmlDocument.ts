import { defaultTreeAdapter, html as htmlSpec, parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

/*
 * 利用者のHTML(CSSは埋め込み済み)を、PDF化するための文書にする。
 * 描画は、JavaScript無効・外部通信遮断のChromiumで行う(pdf.ts)。ここでは、それに加えた二重の防御として、
 *   - 外部への読み込みを禁じるCSP(メタタグ)を、<head>の先頭へ加える
 *   - メタリフレッシュ(別ページへの自動移動)を除く。遮断された移動先のエラーページが、PDFになるのを防ぐ
 * 利用者のHTMLの見た目を決める部分(タグ・属性・CSS)は変更しない。
 */

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

// 画像・フォントはdata URIだけ許可する(CSSの埋め込みは許可)
const CONTENT_SECURITY_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

const isElement = (node: Node): node is Element => 'tagName' in node;

function childElement(parent: ParentNode, tagName: string): Element | undefined {
  return parent.childNodes.find((child): child is Element => isElement(child) && child.tagName === tagName);
}

function isMetaRefresh(element: Element): boolean {
  return (
    element.tagName === 'meta' &&
    (element.attrs.find((attr) => attr.name === 'http-equiv')?.value ?? '').trim().toLowerCase() === 'refresh'
  );
}

function removeMetaRefresh(parent: ParentNode): void {
  for (const child of [...parent.childNodes]) {
    if (!isElement(child)) {
      continue;
    }
    if (isMetaRefresh(child)) {
      defaultTreeAdapter.detachNode(child);
    } else {
      removeMetaRefresh(child);
    }
  }
}

export function prepareHtmlForPdf(source: string): string {
  const document = parse(source);
  const head = childElement(document, 'html')?.childNodes.find((child): child is Element => isElement(child) && child.tagName === 'head');
  if (head === undefined) {
    // parse5は、html/head/bodyが省略された入力にも必ずこれらを補う
    throw new Error('HTMLのheadを特定できませんでした');
  }
  removeMetaRefresh(document);
  const meta = defaultTreeAdapter.createElement('meta', htmlSpec.NS.HTML, [
    { name: 'http-equiv', value: 'Content-Security-Policy' },
    { name: 'content', value: CONTENT_SECURITY_POLICY },
  ]);
  const first = head.childNodes[0];
  if (first === undefined) {
    defaultTreeAdapter.appendChild(head, meta);
  } else {
    defaultTreeAdapter.insertBefore(head, meta, first);
  }
  return serialize(document);
}
