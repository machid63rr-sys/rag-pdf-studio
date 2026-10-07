import React from 'react';
import {
  MARGIN_LABELS,
  MARGIN_PRESETS,
  ORIENTATION_LABELS,
  ORIENTATIONS,
  PAPER_LABELS,
  PAPER_SIZES,
  type MarginPreset,
  type Orientation,
  type PageSettings,
  type PaperSize,
} from '../shared/pageSettings';

interface PageSettingsPanelProps {
  value: PageSettings;
  onChange: (next: PageSettings) => void;
  // 用紙・向き・余白を選べるか(Markdown)。false(HTML)のときは、それらは文書のCSS(@page)が決めるため、ページ番号だけ選べる
  layoutEditable: boolean;
}

/** PDFのページ設定(用紙・向き・余白・ページ番号)を選ぶ */
const PageSettingsPanel: React.FC<PageSettingsPanelProps> = ({ value, onChange, layoutEditable }) => (
  <section className="page-settings" aria-label="ページ設定">
    <h2>ページ設定</h2>

    {layoutEditable ? (
      <div className="field page-settings-row">
        <label htmlFor="page-paper">用紙</label>
        <select id="page-paper" className="text-input select-input" value={value.paper} onChange={(event) => onChange({ ...value, paper: event.target.value as PaperSize })}>
          {PAPER_SIZES.map((paper) => (
            <option key={paper} value={paper}>
              {PAPER_LABELS[paper]}
            </option>
          ))}
        </select>
        <label htmlFor="page-orientation">向き</label>
        <select
          id="page-orientation"
          className="text-input select-input"
          value={value.orientation}
          onChange={(event) => onChange({ ...value, orientation: event.target.value as Orientation })}
        >
          {ORIENTATIONS.map((orientation) => (
            <option key={orientation} value={orientation}>
              {ORIENTATION_LABELS[orientation]}
            </option>
          ))}
        </select>
        <label htmlFor="page-margin">余白</label>
        <select id="page-margin" className="text-input select-input" value={value.margin} onChange={(event) => onChange({ ...value, margin: event.target.value as MarginPreset })}>
          {MARGIN_PRESETS.map((margin) => (
            <option key={margin} value={margin}>
              {MARGIN_LABELS[margin]}
            </option>
          ))}
        </select>
      </div>
    ) : (
      <p className="field-hint">用紙の大きさ・向き・余白は、HTMLのCSS(<code>@page</code>)で決まります(CSSに書かなければ、A4縦です)。</p>
    )}

    <div className="field">
      <label className="page-number-toggle">
        <input type="checkbox" checked={value.pageNumbers} onChange={(event) => onChange({ ...value, pageNumbers: event.target.checked })} /> フッターにページ番号(1 / 3 など)を付ける
      </label>
    </div>
  </section>
);

export default PageSettingsPanel;
