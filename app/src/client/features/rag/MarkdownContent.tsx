import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  readonly children: string;
}

/**
 * Markdownを、書式(見出し・表・箇条書き)つきで表示する。
 * 生のHTMLは描画しない(react-markdownの既定。rehype-rawは使わない)ため、本文に <script> などが
 * 含まれていても、文字として表示されるだけで実行されない。リンクは、新しいタブで開く。
 */
const MarkdownContent: React.FC<MarkdownContentProps> = ({ children }) => (
  <div className="rag-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

export default MarkdownContent;
