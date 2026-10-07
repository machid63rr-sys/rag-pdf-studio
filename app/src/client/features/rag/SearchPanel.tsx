import React, { useEffect, useRef, useState } from 'react';
import { documentPdfUrl, searchManuals, type DocumentSummary, type SearchResult } from '../../ragApi';
import MarkdownContent from './MarkdownContent';
import {
  allLowRelevance, DEFAULT_TOP_K, errorMessage, formatSimilarity, isLowRelevance, LOW_SIMILARITY_THRESHOLD, MAX_QUERY_LENGTH, SEARCH_TOP_K_OPTIONS, shouldSubmitOnEnter, similarityPercent,
  validateQuery,
} from './ragRules';

interface SearchPanelProps {
  readonly unavailable: boolean;
  // 機器名の絞り込みの候補
  readonly equipmentNames: readonly string[];
  // 結果の文書に、原本PDFがあるか(リンクを出すか)の判定に使う
  readonly documents: readonly DocumentSummary[];
}

type SearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'done'; readonly query: string; readonly results: readonly SearchResult[] }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 簡易検索。質問文で、登録した内容を検索する(埋め込み検索のみ)。
 * 検索は、該当が無い質問でも、上位の結果を返す(足切りしない)。そのため、類似度が低い結果には
 * 「関連度が低い」と表示し、全件が低いときは、該当する記載が無い可能性を示す。
 */
const SearchPanel: React.FC<SearchPanelProps> = ({ unavailable, equipmentNames, documents }) => {
  const [query, setQuery] = useState('');
  const [equipment, setEquipment] = useState('');
  const [topK, setTopK] = useState<number>(DEFAULT_TOP_K);
  const [inputError, setInputError] = useState<string | null>(null);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  // 古い検索の応答が、新しい検索の結果を上書きしないよう、検索ごとに世代と中止の指示を持つ
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  // 画面を離れるときは、実行中の検索を止める
  useEffect(() => () => controller.current?.abort(), []);

  const pdfAvailable = new Set(documents.filter((document) => document.has_pdf).map((document) => document.id));

  const search = async (): Promise<void> => {
    if (unavailable) {
      return;
    }
    const problem = validateQuery(query);
    setInputError(problem);
    if (problem !== null) {
      return;
    }
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    generation.current += 1;
    const mine = generation.current;
    const asked = query.trim();
    setState({ kind: 'searching' });
    try {
      const results = await searchManuals({ query: asked, equipmentName: equipment, topK }, current.signal);
      if (mine === generation.current) {
        setState({ kind: 'done', query: asked, results });
      }
    } catch (cause) {
      if (mine === generation.current && !current.signal.aborted) {
        setState({ kind: 'failed', message: errorMessage(cause) });
      }
    }
  };

  const searching = state.kind === 'searching';

  return (
    <section className="rag-search" aria-labelledby="rag-search-heading">
      <h2 id="rag-search-heading">簡易検索</h2>
      <p className="hint">登録した内容が、質問文で見つかるかを確認します。質問文は、探したい内容を普通の文章で入力してください。</p>
      <div className="rag-search-form">
        <div className="rag-field rag-field-query">
          <label htmlFor="rag-search-query">質問文</label>
          <input
            id="rag-search-query"
            type="text"
            className="text-input rag-wide-input"
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            disabled={unavailable}
            placeholder="例: ポンプの異常振動の原因と対策は?"
            aria-invalid={inputError !== null}
            onChange={(event) => {
              setInputError(null);
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              // 日本語入力の変換を確定するEnterでは、検索しない
              if (shouldSubmitOnEnter({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) {
                event.preventDefault();
                void search();
              }
            }}
          />
        </div>
        <div className="rag-field">
          <label htmlFor="rag-search-equipment">機器名で絞り込む</label>
          <select id="rag-search-equipment" className="text-input select-input" value={equipment} disabled={unavailable} onChange={(event) => setEquipment(event.target.value)}>
            <option value="">すべて</option>
            {equipmentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="rag-field">
          <label htmlFor="rag-search-top-k">表示件数</label>
          <select id="rag-search-top-k" className="text-input select-input" value={topK} disabled={unavailable} onChange={(event) => setTopK(Number(event.target.value))}>
            {SEARCH_TOP_K_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count}件
              </option>
            ))}
          </select>
        </div>
        <button id="rag-search-submit" type="button" className="button button-primary" disabled={unavailable || searching} onClick={() => void search()}>
          {searching ? '検索中…' : '検索'}
        </button>
      </div>
      {inputError !== null && (
        <p role="alert" className="field-error">
          {inputError}
        </p>
      )}
      <p className="field-hint">類似度は、質問に近い内容ほど1に近づきます。「関連度が低い」の判定のしきい値({LOW_SIMILARITY_THRESHOLD})は暫定です。</p>

      <div id="rag-search-results" aria-live="polite">
        {state.kind === 'failed' && (
          <p role="alert" className="notice notice-error">
            検索に失敗しました: {state.message}
          </p>
        )}
        {state.kind === 'done' && (
          <>
            {state.results.length === 0 && <p className="notice notice-info rag-no-results">「{state.query}」に該当する登録内容は見つかりませんでした。文書が登録されているか、機器名の絞り込みを確認してください。</p>}
            {allLowRelevance(state.results) && (
              <p role="status" className="notice notice-warning rag-all-low">
                該当する記載が見つからない可能性があります。上位の結果も、類似度が{LOW_SIMILARITY_THRESHOLD}未満です。
              </p>
            )}
            {state.results.length > 0 && (
              <>
                <h3 className="rag-results-heading">「{state.query}」の検索結果({state.results.length}件)</h3>
                <ol className="rag-results">
                  {state.results.map((result, index) => {
                    const low = isLowRelevance(result.similarity);
                    return (
                      <li key={`${result.document_id}-${index}`} className={`rag-result${low ? ' rag-result-low' : ''}`}>
                        <header className="rag-result-header">
                          <span className="rag-rank">{index + 1}</span>
                          <h4 className="rag-result-title">{result.document_title}</h4>
                          <span className="rag-similarity" role="img" aria-label={`類似度 ${formatSimilarity(result.similarity)}`}>
                            <span className="rag-similarity-bar">
                              <span className="rag-similarity-fill" style={{ width: `${similarityPercent(result.similarity)}%` }} />
                            </span>
                            <span className="rag-similarity-value">{formatSimilarity(result.similarity)}</span>
                          </span>
                          {low && <span className="rag-low-badge">関連度が低い</span>}
                          {pdfAvailable.has(result.document_id) && (
                            <a className="rag-result-pdf" href={documentPdfUrl(result.document_id)} target="_blank" rel="noopener noreferrer">
                              原本PDFを開く
                            </a>
                          )}
                        </header>
                        <MarkdownContent>{result.content}</MarkdownContent>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
};

export default SearchPanel;
