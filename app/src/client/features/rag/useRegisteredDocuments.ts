import { useCallback, useEffect, useState } from 'react';
import { listDocuments, listEquipmentNames, type DocumentSummary } from '../../ragApi';
import { errorMessage } from './ragRules';

export interface RegisteredData {
  // 登録済みの文書(新しい順)と、登録済みのタグ名(絞り込みの候補)
  readonly documents: readonly DocumentSummary[];
  readonly equipmentNames: readonly string[];
  readonly loading: boolean;
  // 取得に失敗したときの理由(成功すれば null)。失敗しても、前回取得できた内容は残す
  readonly error: string | null;
  // 取得し直す(登録のあとの反映・「更新」ボタン用)
  readonly reload: () => void;
}

/**
 * 登録済みの文書とタグ名を取得する。enabled が false の間(OCR・RAGサービスが使えない間)は、
 * 取得しない。使えるようになったとき(enabled が true になったとき)と、reload() のときに取得する。
 */
export function useRegisteredDocuments(enabled: boolean): RegisteredData {
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>([]);
  const [equipmentNames, setEquipmentNames] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([listDocuments(controller.signal), listEquipmentNames(controller.signal)])
      .then(([loadedDocuments, loadedNames]) => {
        if (!controller.signal.aborted) {
          setDocuments(loadedDocuments);
          setEquipmentNames(loadedNames);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [enabled, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { documents, equipmentNames, loading, error, reload };
}
