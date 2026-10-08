import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createChatSession, deleteChatSession, listChatMessages, listChatSessions, RagApiError, streamChatMessage, type ChatMessage, type ChatSession, type ManualReference } from '../../ragApi';
import { useRegisteredDocuments } from '../rag/useRegisteredDocuments';
import { errorMessage, MAX_QUERY_LENGTH, validateQuery } from '../rag/ragRules';
import ReadinessBanner from '../shared/ReadinessBanner';
import { useReadiness } from '../shared/useReadiness';
import ChatBubble from './ChatBubble';
import { appendDelta, completeAnswer, dropEmptyAnswer, INTERRUPTED_MESSAGE, isNearBottom, markStopped, shouldSendOnEnter, withPendingTurn } from './chatRules';
import SessionList from './SessionList';
import './chat.css';

const isAbort = (cause: unknown): boolean => cause instanceof DOMException && cause.name === 'AbortError';

/**
 * ④ AIチャット。質問に関係する、登録済みマニュアルの抜粋を探し、それだけを根拠に、ローカルのモデルが回答する。
 * 回答は、できた分から順に表示する。根拠にした抜粋は、回答の下に出す(原本PDFが登録されていれば、開ける)。
 */
const ChatFeature: React.FC = () => {
  const readinessState = useReadiness();
  const { readiness } = readinessState;
  // 確認が終わるまで(readiness が null の間)は、使えるものとして扱う
  const unavailable = readiness !== null && !readiness.ready;
  const registered = useRegisteredDocuments(readiness !== null && readiness.ready);
  const reloadRegistered = registered.reload;

  const [sessions, setSessions] = useState<readonly ChatSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  // 開いている会話。null は、まだ作っていない新しい会話
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // 新しい会話の、タグ名の絞り込み(空=すべて)
  const [newEquipment, setNewEquipment] = useState('');
  const [question, setQuestion] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const rootRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  // 生成中の質問を、停止ボタン・ESCで中断するためのもの。送信している間だけ、値を持つ
  const abortRef = useRef<AbortController | null>(null);
  // 画面が、すでに中身を持っている会話。新しく作った会話は、質問・回答を画面に出しながら作るため、
  // 開いた直後にサーバーから読み直すと、生成中の吹き出しが(まだ保存されていない空の一覧で)消えてしまう
  const shownSessionRef = useRef<string | null>(null);
  // 新しい断片が届くたびに、最下部へ追従するか。上へ読み返している間は、強制的に戻さない
  const followRef = useRef(true);
  const wasSendingRef = useRef(false);

  const refreshSessions = useCallback((signal?: AbortSignal): Promise<void> => {
    return listChatSessions(signal).then(
      (rows) => {
        if (signal?.aborted !== true) {
          setSessions(rows);
          setSessionsError(null);
        }
      },
      (cause: unknown) => {
        if (signal?.aborted !== true) {
          setSessionsError(`会話の履歴を取得できませんでした: ${errorMessage(cause)}`);
        }
      },
    );
  }, []);

  useEffect(() => {
    if (unavailable || readiness === null) {
      return;
    }
    const controller = new AbortController();
    void refreshSessions(controller.signal);
    return () => controller.abort();
  }, [readiness, unavailable, refreshSessions]);

  // 会話を切り替えたら、その内容を読み込む
  useEffect(() => {
    if (selectedId === shownSessionRef.current) {
      return;
    }
    shownSessionRef.current = selectedId;
    followRef.current = true;
    setMessages([]);
    if (selectedId === null) {
      return;
    }
    const controller = new AbortController();
    setLoadingMessages(true);
    void listChatMessages(selectedId, controller.signal).then(
      (rows) => {
        if (!controller.signal.aborted) {
          setMessages(rows);
          setLoadingMessages(false);
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(`会話の内容を取得できませんでした: ${errorMessage(cause)}`);
          setLoadingMessages(false);
        }
      },
    );
    return () => controller.abort();
  }, [selectedId]);

  // 新しい発言・断片が届いたら、最下部の近くにいる間だけ、追従する
  useEffect(() => {
    const container = messagesRef.current;
    if (container !== null && followRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, loadingMessages]);

  // 生成が終わったら、続けて質問できるよう、入力欄に戻る(他のタブを見ているときは、動かさない)
  useEffect(() => {
    if (wasSendingRef.current && !sending && rootRef.current?.closest('[hidden]') === null) {
      questionRef.current?.focus();
    }
    wasSendingRef.current = sending;
  }, [sending]);

  const stop = useCallback((): void => abortRef.current?.abort(), []);

  // ESCで、生成中の回答を止める。入力欄にフォーカスがあっても効くよう、windowで受ける。
  // このタブを隠している間は、他のタブでのESCで止めてしまわないよう、受けない
  useEffect(() => {
    if (!sending) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && rootRef.current?.closest('[hidden]') === null) {
        stop();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sending, stop]);

  // 画面を離れるときは、生成中の回答の受信を止める
  useEffect(() => () => abortRef.current?.abort(), []);

  const openNewChat = (): void => {
    setSelectedId(null);
    setNewEquipment('');
    setError(null);
    setInputError(null);
    // ③で登録したタグ名を、絞り込みの候補に反映する
    reloadRegistered();
  };

  const openSession = (sessionId: string): void => {
    setError(null);
    setInputError(null);
    setSelectedId(sessionId);
  };

  const removeSession = async (sessionId: string): Promise<void> => {
    try {
      await deleteChatSession(sessionId);
    } catch (cause) {
      // 既に無い会話(別のタブで削除済みなど)は、削除できたものとして、一覧から外す
      if (!(cause instanceof RagApiError && cause.status === 404)) {
        setError(`チャットを削除できませんでした: ${errorMessage(cause)}`);
        return;
      }
    }
    setSessions((previous) => previous.filter((session) => session.session_id !== sessionId));
    if (selectedId === sessionId) {
      setSelectedId(null);
    }
  };

  const send = async (): Promise<void> => {
    if (unavailable || sending) {
      return;
    }
    const problem = validateQuery(question);
    setInputError(problem);
    if (problem !== null) {
      return;
    }
    const asked = question.trim();
    const controller = new AbortController();
    abortRef.current = controller;
    // セッションを作る間の二重送信を防ぐため、検証の直後に立てる
    setSending(true);
    setError(null);

    let sessionId = selectedId;
    if (sessionId === null) {
      try {
        const created = await createChatSession(newEquipment === '' ? null : newEquipment, controller.signal);
        sessionId = created.session_id;
        shownSessionRef.current = sessionId;
        setSelectedId(sessionId);
        void refreshSessions();
      } catch (cause) {
        if (!isAbort(cause)) {
          setError(`新しいチャットを作れませんでした: ${errorMessage(cause)}`);
        }
        abortRef.current = null;
        setSending(false);
        return;
      }
    }

    // 質問と、回答を書き込んでいく空の吹き出しを、先に表示する
    const stamp = Date.now();
    const turn = { userId: `pending-user-${stamp}`, assistantId: `pending-assistant-${stamp}`, question: asked, now: new Date().toISOString() };
    followRef.current = true;
    setMessages((previous) => withPendingTurn(previous, turn));
    setQuestion('');

    // 参照マニュアルは、回答より先に届く。引用は回答の下に出したいので、回答の完了まで持っておく
    const received: { references: readonly ManualReference[] | null; finished: boolean } = { references: null, finished: false };
    try {
      await streamChatMessage(
        sessionId,
        asked,
        (event) => {
          if (event.type === 'manual_references') {
            received.references = event.manual_references;
          } else if (event.type === 'delta') {
            setMessages((previous) => appendDelta(previous, turn.assistantId, event.text));
          } else if (event.type === 'done') {
            received.finished = true;
            setMessages((previous) => completeAnswer(previous, turn.assistantId, event, received.references));
          } else {
            received.finished = true;
            setMessages((previous) => dropEmptyAnswer(previous, turn.assistantId));
            setError(`回答の生成に失敗しました: ${event.detail}`);
          }
        },
        controller.signal,
      );
      if (!received.finished) {
        // 完了もエラーも届かずに終わった。サーバーは、この回答を保存していない
        setMessages((previous) => dropEmptyAnswer(previous, turn.assistantId));
        setError(INTERRUPTED_MESSAGE);
      }
    } catch (cause) {
      if (isAbort(cause)) {
        setMessages((previous) => markStopped(previous, turn.assistantId));
      } else {
        setMessages((previous) => dropEmptyAnswer(previous, turn.assistantId));
        setError(`回答の生成に失敗しました: ${errorMessage(cause)}`);
      }
    } finally {
      abortRef.current = null;
      setSending(false);
      // 最初の質問が、会話の題名になる
      void refreshSessions();
    }
  };

  const onMessagesScroll = (): void => {
    const container = messagesRef.current;
    if (container !== null) {
      followRef.current = isNearBottom(container);
    }
  };

  const isNewChat = selectedId === null && messages.length === 0;
  const inputDisabled = unavailable || sending;

  return (
    <main ref={rootRef} className="app app-wide chat-feature">
      <header className="app-header">
        <h1>AIチャット</h1>
      </header>
      <ReadinessBanner state={readinessState} />
      {sessionsError !== null && (
        <p role="alert" className="notice notice-error">
          {sessionsError}
        </p>
      )}
      <div className="chat-layout">
        <aside className="chat-sidebar" aria-label="会話の履歴">
          <button id="chat-new" type="button" className="button button-primary" disabled={inputDisabled} onClick={openNewChat}>
            ＋ 新規チャット
          </button>
          {sessions.length === 0 ? (
            <p id="chat-sessions-empty" className="hint">
              まだ会話はありません。
            </p>
          ) : (
            <SessionList sessions={sessions} selectedId={selectedId} disabled={inputDisabled} onSelect={openSession} onDelete={(sessionId) => void removeSession(sessionId)} />
          )}
        </aside>

        <section className="chat-conversation" aria-label="会話">
          <div id="chat-messages" ref={messagesRef} className="chat-messages" onScroll={onMessagesScroll}>
            {isNewChat && (
              <div className="chat-new">
                <div className="chat-new-options">
                  <label htmlFor="chat-equipment">タグ名で絞り込む(任意)</label>
                  <select id="chat-equipment" className="text-input select-input" value={newEquipment} disabled={inputDisabled} onChange={(event) => setNewEquipment(event.target.value)}>
                    <option value="">すべて</option>
                    {registered.equipmentNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">絞り込むと、そのタグ名の資料と、共通(タグなし)の資料だけを根拠にします。質問にタグ名が書かれていれば、それを優先します。</p>
                </div>
                <p className="chat-empty">質問を入力して、チャットを始めてください。</p>
              </div>
            )}
            {loadingMessages && <p className="hint">会話を読み込んでいます…</p>}
            {messages.map((message) => (
              <ChatBubble key={message.message_id} message={message} />
            ))}
            {sending && (
              <p id="chat-pending" role="status" className="chat-pending">
                回答を生成しています…
              </p>
            )}
          </div>

          {error !== null && (
            <p id="chat-error" role="alert" className="notice notice-error">
              {error}
            </p>
          )}
          <p className="hint">回答は、登録済みのマニュアルの抜粋だけを根拠にします。該当する記載が無いときは、無いと答えます。回答の生成には、時間がかかることがあります。</p>
          <div className="chat-input-row">
            <textarea
              id="chat-question"
              ref={questionRef}
              className="text-input chat-input"
              rows={3}
              value={question}
              maxLength={MAX_QUERY_LENGTH}
              disabled={inputDisabled}
              placeholder="質問を入力(Enterで送信、Shift+Enterで改行)"
              aria-invalid={inputError !== null}
              onChange={(event) => {
                setInputError(null);
                setQuestion(event.target.value);
              }}
              onKeyDown={(event) => {
                if (shouldSendOnEnter({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode, shiftKey: event.shiftKey })) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {/* 「送信」の位置に「停止」を出すと、ダブルクリックの2回目が「停止」に当たり、送信した直後に止まってしまう。
                送信は無効にして残し、停止は別のボタンにする */}
            <button id="chat-send" type="button" className="button button-primary" disabled={unavailable || sending} onClick={() => void send()}>
              送信
            </button>
            {sending && (
              <button id="chat-stop" type="button" className="button" title="生成を停止(ESC)" onClick={stop}>
                ■ 停止
              </button>
            )}
          </div>
          {inputError !== null && (
            <p role="alert" className="field-error">
              {inputError}
            </p>
          )}
        </section>
      </div>
    </main>
  );
};

export default ChatFeature;
