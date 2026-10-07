import { buildDocumentHtml } from './markdownToHtml.js';
import type { PdfRenderer } from './pdf.js';

const PDF_SIGNATURE = '%PDF-';

/**
 * 起動時にPDFを1本生成し、Mermaidの図を1つ描画して、Chromium・フォント・描画経路が動くことを確認する。
 * 失敗した場合は例外を投げる(呼び出し側がプロセスを終了させ、壊れた状態で起動し続けない)。
 */
export async function selfCheck(renderer: PdfRenderer, css: string): Promise<{ chromium: string }> {
  const chromium = await renderer.chromiumVersion();
  const pdf = await renderer.render(buildDocumentHtml('# 起動確認\n\n日本語の表示 ✓', css));
  if (pdf.subarray(0, PDF_SIGNATURE.length).toString('latin1') !== PDF_SIGNATURE) {
    throw new Error('起動時セルフチェックに失敗しました: 生成物がPDFではありません');
  }
  const [diagram] = await renderer.drawDiagrams(['graph LR\n  A --> B']);
  if (diagram?.ok !== true) {
    throw new Error(`起動時セルフチェックに失敗しました: Mermaidの図を描画できません (${diagram?.message ?? '結果がありません'})`);
  }
  return { chromium };
}
