import React from 'react';
import type { EmbedNotice } from './embedImage';

/** 画像を埋め込んだ結果の表示(成功は通知、失敗は警告として読み上げる) */
const EmbedStatus: React.FC<{ notice: EmbedNotice | null }> = ({ notice }) =>
  notice === null ? null : (
    <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`notice notice-${notice.kind}`}>
      {notice.text}
    </p>
  );

export default EmbedStatus;
