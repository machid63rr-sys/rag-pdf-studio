import React, { useEffect, useState } from 'react';
import ReadinessBanner from '../shared/ReadinessBanner';
import { useReadiness } from '../shared/useReadiness';
import type { RagFeatureProps } from '../handoff';
import DocumentList from './DocumentList';
import RegisterPanel from './RegisterPanel';
import SearchPanel from './SearchPanel';
import { useRegisteredDocuments } from './useRegisteredDocuments';
import './rag.css';

type RagTab = 'register' | 'browse';

const TABS: readonly { readonly id: RagTab; readonly label: string }[] = [
  { id: 'register', label: '登録' },
  { id: 'browse', label: '確認(一覧・検索)' },
];

/**
 * ③ RAG(登録・確認)。「登録」で、Markdown(②のOCR結果を含む)をRAGに登録し、
 * 「確認」で、登録済みの文書の一覧と、簡易検索で登録内容を確かめる。
 * 2つのタブは、切り替えても入力・検索結果が消えないよう、どちらも作ったまま、片方を隠す。
 */
const RagFeature: React.FC<RagFeatureProps> = ({ incoming }) => {
  const readinessState = useReadiness();
  const { readiness } = readinessState;
  // 確認が終わるまで(readiness が null の間)は、使えるものとして扱う
  const unavailable = readiness !== null && !readiness.ready;
  const registered = useRegisteredDocuments(readiness !== null && readiness.ready);
  const [tab, setTab] = useState<RagTab>('register');

  // ② から渡されたら、取り込み先の「登録」タブを開く
  useEffect(() => {
    if (incoming !== null) {
      setTab('register');
    }
  }, [incoming?.id]);

  return (
    <main className="app rag-feature">
      <header className="app-header">
        <h1>RAG(登録・確認)</h1>
      </header>
      <ReadinessBanner state={readinessState} />
      <div role="tablist" className="rag-tabs" aria-label="RAGの操作">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            id={`rag-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`rag-panel-${id}`}
            className={`rag-tab${tab === id ? ' rag-tab-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div id="rag-panel-register" role="tabpanel" aria-labelledby="rag-tab-register" hidden={tab !== 'register'} className="rag-panel">
        <RegisterPanel
          unavailable={unavailable}
          documents={registered.documents}
          documentsError={registered.error}
          equipmentCandidates={registered.equipmentNames}
          incoming={incoming}
          onRegistered={registered.reload}
          onShowBrowse={() => setTab('browse')}
        />
      </div>
      <div id="rag-panel-browse" role="tabpanel" aria-labelledby="rag-tab-browse" hidden={tab !== 'browse'} className="rag-panel">
        <DocumentList documents={registered.documents} loading={registered.loading} error={registered.error} unavailable={unavailable} onReload={registered.reload} />
        <SearchPanel unavailable={unavailable} equipmentNames={registered.equipmentNames} documents={registered.documents} />
      </div>
    </main>
  );
};

export default RagFeature;
