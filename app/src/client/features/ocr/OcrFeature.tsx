import React, { useState } from 'react';
import type { OcrFeatureProps } from '../handoff';
import ReadinessBanner from '../shared/ReadinessBanner';
import { useReadiness } from '../shared/useReadiness';
import { clearCurrentDraftId, loadCurrentDraftId, saveCurrentDraftId } from './currentDraft';
import DraftScreen from './DraftScreen';
import StartScreen from './StartScreen';
import './ocr.css';

/**
 * ② PDF → OCR → MD。PDFをOCRして、結果(Markdown)を確認・修正し、保存する。
 * OCRはサーバー側でバックグラウンドで実行される。開いている下書きは、再読み込みしても、続きから見られる。
 */
const OcrFeature: React.FC<OcrFeatureProps> = ({ onSendToPdfEditor, onSendToRag }) => {
  const readiness = useReadiness();
  // 開いている下書き(無ければ、開始・履歴の画面)
  const [currentId, setCurrentId] = useState<string | null>(() => loadCurrentDraftId());
  // 履歴へ戻ったときの案内
  const [notice, setNotice] = useState<string | null>(null);

  const open = (id: string): void => {
    saveCurrentDraftId(id);
    setCurrentId(id);
    setNotice(null);
  };

  const leave = (message?: string): void => {
    clearCurrentDraftId();
    setCurrentId(null);
    setNotice(message ?? null);
  };

  const banner = <ReadinessBanner state={readiness} />;
  // サービスの状態を確認している間・使える間は、開始できる。使えないと分かったときだけ、開始を止める
  const canStart = readiness.readiness === null || readiness.readiness.ready;

  return currentId === null ? (
    <StartScreen banner={banner} canStart={canStart} notice={notice} onOpen={open} />
  ) : (
    <DraftScreen key={currentId} id={currentId} banner={banner} onLeave={leave} onSendToPdfEditor={onSendToPdfEditor} onSendToRag={onSendToRag} />
  );
};

export default OcrFeature;
