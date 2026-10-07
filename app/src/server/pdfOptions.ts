import type { PDFOptions } from 'puppeteer-core';
import { DEFAULT_PAGE_SETTINGS, MARGINS_MM, PAPER_MM, type PageSettings, type PaperSize } from '../shared/pageSettings.js';

// フッターにはページ本文のCSSが効かないため、フォント指定はインラインで行う
export const FOOTER_TEMPLATE =
  '<div style="font-size:9px;font-family:\'Noto Sans CJK JP\',sans-serif;width:100%;text-align:center;color:#555;">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

// Chromiumの用紙の名前で渡せるもの。それ以外(JIS B列)は、大きさ(mm)で渡す
const NAMED_PAPERS: Partial<Record<PaperSize, NonNullable<PDFOptions['format']>>> = { A4: 'A4', A3: 'A3', Letter: 'Letter' };

/**
 * PDFを作るときの、Chromiumへの指定(用紙・向き・余白・ページ番号)。
 * @param preferCssPageSize 文書のCSS(@page)が決める用紙を優先するか(利用者のHTML)。そのとき、用紙・向き・余白の設定は使わず
 *   (既定のA4・標準のまま、CSSが、あれば上書きする)、ページ番号の有無だけが、設定に従う
 */
export function pdfOptionsFor(settings: PageSettings, preferCssPageSize: boolean, timeoutMs: number): PDFOptions {
  const layout = preferCssPageSize ? { ...DEFAULT_PAGE_SETTINGS, pageNumbers: settings.pageNumbers } : settings;
  const margins = MARGINS_MM[layout.margin];
  const named = NAMED_PAPERS[layout.paper];
  const paper = PAPER_MM[layout.paper];
  return {
    ...(named === undefined ? { width: `${paper.width}mm`, height: `${paper.height}mm` } : { format: named }),
    ...(layout.orientation === 'landscape' ? { landscape: true } : {}),
    margin: { top: `${margins.top}mm`, bottom: `${margins.bottom}mm`, left: `${margins.side}mm`, right: `${margins.side}mm` },
    printBackground: true,
    preferCSSPageSize: preferCssPageSize,
    displayHeaderFooter: layout.pageNumbers,
    ...(layout.pageNumbers ? { headerTemplate: '<span></span>', footerTemplate: FOOTER_TEMPLATE } : {}),
    timeout: timeoutMs,
  };
}
