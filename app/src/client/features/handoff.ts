/*
 * 機能どうしの受け渡し。画面(App.tsx)が、受け渡しの内容を持ち、渡された側の機能が受け取る。
 * 受け取る側は、id が変わったときだけ「新しい受け渡しが来た」と扱う(同じ内容を、何度も取り込み直さないため)。
 */

/** ② OCRの結果を、① MD/HTML → PDF で開いてPDFにする */
export interface MarkdownHandoff {
  readonly id: number;
  // 元のファイル名(「R-1.pdf」など)。保存するファイル名の既定に使う
  readonly fileName: string;
  readonly markdown: string;
}

/** ② OCRの結果を、③ RAG の登録フォームに入れる */
export interface RagHandoff extends MarkdownHandoff {
  // 原本PDF。OCRした下書きに保存されている(登録時に、原本として一緒に保存できる)。無ければ null
  readonly pdf: { readonly url: string; readonly fileName: string } | null;
}

export type FeatureId = 'pdf' | 'ocr' | 'rag' | 'chat';

export interface OcrFeatureProps {
  // 「① MD/HTML → PDF で開く」「③ RAG に登録する」の操作
  readonly onSendToPdfEditor: (handoff: Omit<MarkdownHandoff, 'id'>) => void;
  readonly onSendToRag: (handoff: Omit<RagHandoff, 'id'>) => void;
}

export interface RagFeatureProps {
  // ② から渡された内容(無ければ null)。新しく渡されると、登録フォームに入る
  readonly incoming: RagHandoff | null;
}

export interface PdfEditorFeatureProps {
  // ② から渡された内容(無ければ null)。新しく渡されると、編集画面で開く
  readonly incoming: MarkdownHandoff | null;
}
