import React, { useState } from 'react';
import type { ChatSession } from '../../ragApi';
import { describeSessionEquipment, formatSessionDate, sessionTitle } from './chatRules';

interface SessionListProps {
  readonly sessions: readonly ChatSession[];
  readonly selectedId: string | null;
  // 回答の生成中は、会話の切り替え・削除をさせない(生成中の回答が、別の会話に書き込まれるのを防ぐ)
  readonly disabled: boolean;
  readonly onSelect: (sessionId: string) => void;
  readonly onDelete: (sessionId: string) => void;
}

/**
 * 会話の履歴。削除は、その項目の中で「このチャットを削除しますか?」と確認する
 * (window.confirm は、画面の中央に出て、どの項目の確認か分かりにくいため使わない)。
 */
const SessionList: React.FC<SessionListProps> = ({ sessions, selectedId, disabled, onSelect, onDelete }) => {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  return (
    <ul id="chat-session-list" className="chat-sessions">
      {sessions.map((session) => {
        const confirming = confirmingId === session.session_id;
        const selected = selectedId === session.session_id;
        const title = sessionTitle(session);
        return (
          <li key={session.session_id} className={`chat-session${selected ? ' chat-session-selected' : ''}${confirming ? ' chat-session-confirming' : ''}`}>
            {/* 確認中も、題名は消さない(どの会話の削除の確認か、常に分かるようにする) */}
            <button type="button" className="chat-session-main" disabled={disabled || confirming} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(session.session_id)}>
              <span className="chat-session-title">{title}</span>
              {confirming ? (
                <span className="chat-session-confirm-text">このチャットを削除しますか?</span>
              ) : (
                <span className="chat-session-meta">
                  {describeSessionEquipment(session.equipment_name)} ・ {formatSessionDate(session.created_at)}
                </span>
              )}
            </button>
            {confirming ? (
              <div className="chat-session-actions">
                <button
                  type="button"
                  className="button button-small chat-session-confirm-delete"
                  onClick={() => {
                    setConfirmingId(null);
                    onDelete(session.session_id);
                  }}
                >
                  削除
                </button>
                <button type="button" className="button button-small chat-session-cancel" onClick={() => setConfirmingId(null)}>
                  キャンセル
                </button>
              </div>
            ) : (
              <button type="button" className="chat-session-delete" disabled={disabled} aria-label={`「${title}」を削除`} title="削除" onClick={() => setConfirmingId(session.session_id)}>
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export default SessionList;
