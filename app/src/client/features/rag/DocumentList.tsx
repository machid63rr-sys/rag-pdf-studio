import React from 'react';
import { documentPdfUrl, type DocumentSummary } from '../../ragApi';
import { formatDateTime } from './ragRules';

interface DocumentListProps {
  readonly documents: readonly DocumentSummary[];
  readonly loading: boolean;
  // 取得に失敗した理由(成功していれば null)
  readonly error: string | null;
  readonly unavailable: boolean;
  readonly onReload: () => void;
}

/** 登録済みの文書の一覧(題名・機器名・チャンク数・原本PDF・登録日時) */
const DocumentList: React.FC<DocumentListProps> = ({ documents, loading, error, unavailable, onReload }) => (
  <section className="rag-documents" aria-labelledby="rag-documents-heading">
    <div className="rag-section-header">
      <h2 id="rag-documents-heading">登録済みの文書({documents.length}件)</h2>
      <button id="rag-refresh-documents" type="button" className="button" disabled={unavailable || loading} onClick={onReload}>
        {loading ? '更新中…' : '更新'}
      </button>
    </div>
    {error !== null && (
      <p role="alert" className="notice notice-error">
        登録済みの文書を取得できませんでした: {error}
      </p>
    )}
    {documents.length === 0 && error === null && !loading && (
      <p className="notice notice-info rag-empty">まだ文書が登録されていません。「登録」タブからMarkdownを登録してください。</p>
    )}
    {documents.length > 0 && (
      <table id="rag-documents-table" className="rag-table">
        <thead>
          <tr>
            <th scope="col">題名</th>
            <th scope="col">機器名</th>
            <th scope="col">チャンク数</th>
            <th scope="col">原本PDF</th>
            <th scope="col">登録日時</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id}>
              <th scope="row">
                {document.title}
                <span className="rag-source-name">{document.source_file_name}</span>
              </th>
              <td>
                {document.equipment_names.length === 0 ? (
                  <span className="hint">全機器共通</span>
                ) : (
                  <ul className="rag-chips rag-chips-static">
                    {document.equipment_names.map((name) => (
                      <li key={name} className="rag-chip">
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="rag-number">{document.chunk_count}</td>
              <td>
                {document.has_pdf ? (
                  <a href={documentPdfUrl(document.id)} target="_blank" rel="noopener noreferrer">
                    開く
                  </a>
                ) : (
                  <span className="hint">なし</span>
                )}
              </td>
              <td>{formatDateTime(document.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

export default DocumentList;
