import React, { useState } from 'react';
import { documentPdfUrl, type ChatMessage, type ManualReference } from '../../ragApi';
import MarkdownContent from '../rag/MarkdownContent';
import { formatSimilarity, isLowRelevance, similarityPercent } from '../rag/ragRules';
import { excerptPreview } from './chatRules';

interface ReferenceItemProps {
  readonly reference: ManualReference;
}

/**
 * 参照マニュアルの1件。長い抜粋は、先頭だけを書式なしの文字で見せ、「続きを読む」で全文をMarkdownとして開く
 * (文字数で切った抜粋は、Markdownの記法の途中で切れうるため、書式を解釈すると表示が崩れる)。
 */
const ReferenceItem: React.FC<ReferenceItemProps> = ({ reference }) => {
  const [expanded, setExpanded] = useState(false);
  const preview = excerptPreview(reference.content);
  const low = isLowRelevance(reference.similarity);

  return (
    <li className={`chat-ref${low ? ' chat-ref-low' : ''}`}>
      <div className="chat-ref-meta">
        <span className="chat-ref-title">『{reference.document_title}』</span>
        <span className="chat-ref-similarity" role="img" aria-label={`類似度 ${formatSimilarity(reference.similarity)}`}>
          <span className="chat-ref-similarity-bar">
            <span className="chat-ref-similarity-fill" style={{ width: `${similarityPercent(reference.similarity)}%` }} />
          </span>
          <span className="chat-ref-similarity-value">{formatSimilarity(reference.similarity)}</span>
        </span>
        {low && <span className="chat-ref-low-badge">関連度が低い</span>}
        {reference.has_pdf && (
          <a className="chat-ref-pdf" href={documentPdfUrl(reference.document_id)} target="_blank" rel="noopener noreferrer">
            原本PDFを開く
          </a>
        )}
      </div>
      <div className="chat-ref-content">
        {preview.truncated && !expanded ? <p className="chat-ref-preview">{preview.text}</p> : <MarkdownContent>{reference.content}</MarkdownContent>}
        {preview.truncated && (
          <button type="button" className="chat-ref-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? '折りたたむ▴' : '続きを読む▾'}
          </button>
        )}
      </div>
    </li>
  );
};

interface ChatBubbleProps {
  readonly message: ChatMessage;
}

/** 会話の1発言。回答は、書式を付けないプレーンテキストで表示し、根拠にした参照マニュアルを、その下に並べる */
const ChatBubble: React.FC<ChatBubbleProps> = ({ message }) => {
  const references = message.manual_references;
  return (
    <div className={`chat-bubble chat-bubble-${message.role}`}>
      <div className="chat-bubble-content">{message.content}</div>
      {references !== null && references.length > 0 && (
        <section className="chat-refs" aria-label="参照マニュアル">
          <h3 className="chat-refs-title">📚 参照マニュアル({references.length}件)</h3>
          <ol className="chat-refs-list">
            {references.map((reference, index) => (
              <ReferenceItem key={`${reference.document_id}-${index}`} reference={reference} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
};

export default ChatBubble;
