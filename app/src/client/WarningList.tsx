import React from 'react';
import type { LintWarning } from './lint';

const MAX_LISTED_LINES = 5;

function formatLines(lines: readonly number[]): string {
  const listed = lines.slice(0, MAX_LISTED_LINES).join('、');
  const rest = lines.length - MAX_LISTED_LINES;
  return rest > 0 ? `${listed} ほか${rest}件` : listed;
}

/** 出力前の確認事項(警告)の一覧。無ければ何も表示しない */
const WarningList: React.FC<{ warnings: readonly LintWarning[] }> = ({ warnings }) => {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <ul className="notice notice-warning warning-list" aria-label="確認してください">
      {warnings.map((warning) => (
        <li key={warning.code}>
          {warning.message}
          {warning.lines.length > 0 && <span className="warning-lines"> (行: {formatLines(warning.lines)})</span>}
        </li>
      ))}
    </ul>
  );
};

export default WarningList;
