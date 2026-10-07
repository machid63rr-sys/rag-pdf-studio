import React, { useEffect, useState } from 'react';
import { AssetStore } from '../../assets';
import { documentFromDraft, type Draft } from '../../draft';
import { draftStorage } from '../../draftStorage';
import type { ImportedDocument } from '../../documents';
import EditView from '../../EditView';
import HtmlEditView from '../../HtmlEditView';
import ImportView from '../../ImportView';
import type { PdfEditorFeatureProps } from '../handoff';

// ① MD/HTML → PDF。取り込み画面 → 編集画面。取り込むたびに編集画面を作り直すため、keyに連番を使う
const PdfEditorFeature: React.FC<PdfEditorFeatureProps> = ({ incoming }) => {
  const [session, setSession] = useState<{ id: number; document: ImportedDocument } | null>(null);
  // 自動保存してある、前回の下書き(取り込み画面で、再開・破棄を選べる)
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    let cancelled = false;
    void draftStorage.load().then((saved) => {
      if (!cancelled) {
        setDraft(saved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ② OCRの結果が渡されたら、編集画面で開く。編集中の文書があるときは、置き換えてよいか確認する
  useEffect(() => {
    if (incoming === null) {
      return;
    }
    if (session !== null && !window.confirm('① で編集中の文書があります。② のOCR結果で置き換えますか?')) {
      return;
    }
    setSession({
      id: incoming.id,
      document: { kind: 'markdown', markdown: incoming.markdown, sourceName: incoming.fileName, baseDir: '', assets: new AssetStore([], false) },
    });
    // incoming.id が変わったときだけ取り込む(session の変化では、取り込み直さない)
  }, [incoming?.id]);

  if (session === null) {
    return (
      <ImportView
        onImport={(document) => setSession({ id: Date.now(), document })}
        draft={draft}
        onResume={() => {
          if (draft !== null) {
            setSession({ id: Date.now(), document: documentFromDraft(draft) });
          }
        }}
        onDiscard={() => {
          void draftStorage.clear().then(() => setDraft(null));
        }}
      />
    );
  }
  // 閉じたあとの取り込み画面には、残っている下書き(編集していない文書を閉じたときは、前の下書き)を出す
  const close = (): void => {
    setSession(null);
    void draftStorage.load().then(setDraft);
  };
  return session.document.kind === 'html' ? (
    <HtmlEditView key={session.id} document={session.document} onClose={close} />
  ) : (
    <EditView key={session.id} document={session.document} onClose={close} />
  );
};

export default PdfEditorFeature;
