import React, { useState } from 'react';
import { addEquipmentNames, shouldSubmitOnEnter } from './ragRules';

interface EquipmentNameInputProps {
  readonly id: string;
  readonly names: readonly string[];
  readonly onNamesChange: (names: string[]) => void;
  // 入力欄に入力中で、まだ追加されていない文字列(登録するときに、追加し忘れを確認するため、親が持つ)
  readonly pending: string;
  readonly onPendingChange: (pending: string) => void;
  // 既存のタグ名(入力の候補として提示する)
  readonly candidates: readonly string[];
  readonly disabled: boolean;
}

const SEPARATOR = /[,，、]/;

/**
 * タグ名の入力。Enterまたはカンマで追加し、チップの「×」で外す。既存のタグ名は、候補として提示する。
 * 追加できない入力(空・長すぎる・重複)は、黙って捨てず、理由を表示する。
 */
const EquipmentNameInput: React.FC<EquipmentNameInputProps> = ({ id, names, onNamesChange, pending, onPendingChange, candidates, disabled }) => {
  const [message, setMessage] = useState<string | null>(null);

  const commit = (text: string): boolean => {
    const outcome = addEquipmentNames(names, text);
    if (!outcome.ok) {
      setMessage(outcome.message);
      return false;
    }
    setMessage(null);
    onNamesChange(outcome.names);
    return true;
  };

  const addPending = (): void => {
    if (commit(pending)) {
      onPendingChange('');
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.value;
    // 日本語入力の変換中は、途中の文字をタグ名として扱わない
    const composing = (event.nativeEvent as InputEvent).isComposing;
    if (!composing && SEPARATOR.test(value)) {
      // カンマまでを追加し、その後ろを入力中として残す(「A,B,」の貼り付けにも対応)
      const parts = value.split(SEPARATOR);
      const rest = parts[parts.length - 1] ?? '';
      const complete = parts.slice(0, -1).join(',');
      if (complete.trim() === '' || commit(complete)) {
        onPendingChange(rest);
      } else {
        onPendingChange(value);
      }
      return;
    }
    setMessage(null);
    onPendingChange(value);
  };

  const available = candidates.filter((candidate) => !names.includes(candidate));

  return (
    <div className="rag-equipment">
      {names.length > 0 && (
        <ul className="rag-chips" aria-label="追加したタグ名">
          {names.map((name) => (
            <li key={name} className="rag-chip">
              {name}
              <button type="button" className="rag-chip-remove" aria-label={`${name}を外す`} disabled={disabled} onClick={() => onNamesChange(names.filter((n) => n !== name))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rag-equipment-row">
        <input
          id={id}
          type="text"
          className="text-input"
          list={`${id}-candidates`}
          value={pending}
          disabled={disabled}
          placeholder="例: R-1(Enterまたはカンマで追加)"
          autoComplete="off"
          aria-invalid={message !== null}
          onChange={handleChange}
          onKeyDown={(event) => {
            if (shouldSubmitOnEnter({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
              // Enterで、フォームの送信(登録)まで実行しない
              event.preventDefault();
              addPending();
            }
          }}
        />
        <datalist id={`${id}-candidates`}>
          {available.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
        <button type="button" className="button" disabled={disabled || pending.trim() === ''} onClick={addPending}>
          追加
        </button>
      </div>
      {message !== null && (
        <p role="alert" className="field-error">
          {message}
        </p>
      )}
      {names.length === 0 && <p className="field-hint">タグ名を付けないと、共通(タグなし)の資料として扱います(どのタグ名で絞り込んだ検索でも対象になります)。</p>}
    </div>
  );
};

export default EquipmentNameInput;
