import React from 'react';
import type { ReadinessState } from './useReadiness';

interface ReadinessBannerProps {
  readonly state: ReadinessState;
}

/**
 * OCR・RAGサービスが使えないときだけ表示する案内。使えない理由(サービス未設定・接続できない・
 * モデル未取得)を示し、「再確認」で、もう一度確認できる。使えるときは何も表示しない。
 */
const ReadinessBanner: React.FC<ReadinessBannerProps> = ({ state }) => {
  const { readiness, recheck } = state;
  if (readiness === null || readiness.ready) {
    return null;
  }
  return (
    <div role="alert" className="notice notice-warning readiness-banner">
      <p>
        <strong>この機能は、いまは使えません。</strong>
        {readiness.message}
      </p>
      {readiness.code === 'models_missing' && <p className="readiness-hint">初回の起動では、モデルの取得(約10GB)に時間がかかります。取得が終わると、使えるようになります。</p>}
      <button type="button" className="button" onClick={recheck}>
        再確認
      </button>
    </div>
  );
};

export default ReadinessBanner;
