import React, { useRef, useState } from 'react';
import type { FeatureId, MarkdownHandoff, RagHandoff } from './features/handoff';
import ChatFeature from './features/chat/ChatFeature';
import OcrFeature from './features/ocr/OcrFeature';
import PdfEditorFeature from './features/pdf/PdfEditorFeature';
import RagFeature from './features/rag/RagFeature';
import './shell.css';

const FEATURES: readonly { readonly id: FeatureId; readonly label: string }[] = [
  { id: 'pdf', label: '① MD/HTML → PDF' },
  { id: 'ocr', label: '② PDF → OCR → MD' },
  { id: 'rag', label: '③ RAG(登録・確認)' },
  { id: 'chat', label: '④ AIチャット' },
];

/**
 * 画面全体。4つの機能(① MD/HTML → PDF、② PDF → OCR → MD、③ RAG、④ AIチャット)をタブで切り替える。
 *
 * - 機能は、最初に開いたときに作り、以降は(隠しても)作ったままにする。編集中の文書やOCRの
 *   進み具合が、タブを切り替えても消えないようにするため。
 * - ②の結果は、①(PDFにして出力)や③(RAGに登録)へ渡せる。渡す内容は、ここが持つ。
 */
const App: React.FC = () => {
  const [active, setActive] = useState<FeatureId>('pdf');
  const [visited, setVisited] = useState<ReadonlySet<FeatureId>>(() => new Set<FeatureId>(['pdf']));
  const [toPdfEditor, setToPdfEditor] = useState<MarkdownHandoff | null>(null);
  const [toRag, setToRag] = useState<RagHandoff | null>(null);
  const handoffCount = useRef(0);

  const show = (feature: FeatureId): void => {
    setActive(feature);
    setVisited((previous) => (previous.has(feature) ? previous : new Set(previous).add(feature)));
  };

  const sendToPdfEditor = (handoff: Omit<MarkdownHandoff, 'id'>): void => {
    handoffCount.current += 1;
    setToPdfEditor({ id: handoffCount.current, ...handoff });
    show('pdf');
  };

  const sendToRag = (handoff: Omit<RagHandoff, 'id'>): void => {
    handoffCount.current += 1;
    setToRag({ id: handoffCount.current, ...handoff });
    show('rag');
  };

  const content: Readonly<Record<FeatureId, React.ReactNode>> = {
    pdf: <PdfEditorFeature incoming={toPdfEditor} />,
    ocr: <OcrFeature onSendToPdfEditor={sendToPdfEditor} onSendToRag={sendToRag} />,
    rag: <RagFeature incoming={toRag} />,
    chat: <ChatFeature />,
  };

  return (
    <>
      <nav className="shell-nav" aria-label="機能の切り替え">
        <span className="shell-brand">rag-pdf-studio</span>
        <div role="tablist" className="shell-tabs">
          {FEATURES.map(({ id, label }) => (
            <button
              key={id}
              id={`feature-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={active === id}
              aria-controls={`feature-pane-${id}`}
              className={`shell-tab${active === id ? ' shell-tab-active' : ''}`}
              onClick={() => show(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>
      {FEATURES.map(({ id }) =>
        visited.has(id) ? (
          <div key={id} id={`feature-pane-${id}`} role="tabpanel" aria-labelledby={`feature-tab-${id}`} hidden={active !== id} className="feature-pane">
            {content[id]}
          </div>
        ) : null,
      )}
    </>
  );
};

export default App;
