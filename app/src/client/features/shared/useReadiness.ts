import { useCallback, useEffect, useState } from 'react';
import { getReadiness, type Readiness } from '../../ragApi';

export interface ReadinessState {
  // 確認中(最初の確認が終わるまで)は null
  readonly readiness: Readiness | null;
  // もう一度確認する(「再確認」ボタン用)
  readonly recheck: () => void;
}

/** OCR・RAGサービスが使える状態か(DB・Ollamaのモデルが揃っているか)を、画面を開いたときに確認する */
export function useReadiness(): ReadinessState {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReadiness(null);
    void getReadiness().then((result) => {
      if (!cancelled) {
        setReadiness(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [round]);

  const recheck = useCallback(() => setRound((n) => n + 1), []);
  return { readiness, recheck };
}
