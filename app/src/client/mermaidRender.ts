import { MERMAID_CONFIG, diagramErrorMessage, sizedSvg } from '../shared/mermaid';

/*
 * 編集画面でのMermaidの図の描画。PDFと同じ設定・同じ版のMermaidで描くため、見た目が揃う。
 * Mermaid本体は大きいため、図のあるMarkdownを開いたときに初めて読み込む。
 */

type Mermaid = (typeof import('mermaid'))['default'];

export type DrawnDiagram =
  | { readonly ok: true; readonly uri: string; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly message: string };

let loading: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid')
    .then(({ default: mermaid }) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    })
    .catch((cause: unknown) => {
      loading = undefined; // 通信の失敗などは、次の機会にやり直せるようにする
      throw cause;
    });
  return loading;
}

let counter = 0;

/** 図を<img>で表示するためのURL。画像として表示するため、図の中のスクリプトが実行されることはない */
const svgUri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Mermaidのコードを図にする。構文が誤っているなど、描けない場合は、理由を返す */
export async function drawDiagram(code: string): Promise<DrawnDiagram> {
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (cause) {
    return { ok: false, message: `図の描画機能を読み込めませんでした(${diagramErrorMessage(cause)})` };
  }
  const id = `mermaid-preview-${counter}`;
  counter += 1;
  try {
    const { svg } = await mermaid.render(id, code);
    const sized = sizedSvg(svg);
    if (sized === null) {
      return { ok: false, message: '図の大きさを取得できません' };
    }
    return { ok: true, uri: svgUri(sized.svg), width: sized.width, height: sized.height };
  } catch (cause) {
    // 失敗した描画が、作業用の要素を画面に残すことがある
    document.getElementById(`d${id}`)?.remove();
    return { ok: false, message: diagramErrorMessage(cause) };
  }
}
