import React from 'react';
import type { SaveState } from './draftSaver';

interface DraftStatusProps {
  state: SaveState;
  // 文書が、元の文書から変わっているか(変わっていなければ、自動保存の状態は、出さない)
  changed: boolean;
}

const timeOf = (savedAt: number): string => new Date(savedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** 下書きの自動保存の状態。保存できていないときは、警告として出す */
const DraftStatus: React.FC<DraftStatusProps> = ({ state, changed }) => {
  if (state.error !== null) {
    return (
      <p role="alert" className="notice notice-error draft-status">
        編集内容を自動保存できません({state.error})。タブを閉じる前に、必要な内容を出力してください。
      </p>
    );
  }
  if (!changed) {
    return null;
  }
  return (
    <p className="draft-status" aria-live="polite">
      {state.pending || state.savedAt === null
        ? '自動保存: 保存中…'
        : `自動保存: このブラウザに保存しました(${timeOf(state.savedAt)})。画像・CSSのファイルは、保存されません。`}
    </p>
  );
};

export default DraftStatus;
