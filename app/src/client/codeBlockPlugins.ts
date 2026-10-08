import { codeBlockPlugin, codeMirrorPlugin, type RealmPlugin } from '@mdxeditor/editor';
import { isMermaidLanguage } from '../shared/mermaid';
import MermaidBlockEditor from './MermaidBlockEditor';

// 一覧に無い言語のコードブロックも、解釈エラーにならず通常どおり扱われる(実測済み)
const CODE_BLOCK_LANGUAGES = {
  txt: 'テキスト',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  python: 'Python',
  bash: 'Bash',
  sh: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  java: 'Java',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  go: 'Go',
  rust: 'Rust',
  diff: 'Diff',
  mermaid: 'Mermaid',
};

/**
 * 書式付きエディタの、コードブロックの設定(「コードブロックを入れる」ボタンと、既存のコードブロックの編集に必要)。
 * 言語ごとに色分けして表示し(言語は、ブロックの右上で選べる)、Mermaidのコードブロックは、コードの下に図も表示する。
 * 「① MD/HTML → PDF」と「② PDF → OCR → MD」の編集画面で、同じ設定を使う。
 * コードブロックを描画するエディタが無いと、ボタンで入れても、ブロックが表示されない。
 */
export function codeBlockPlugins(): RealmPlugin[] {
  return [
    // Mermaidのコードブロックだけ、図も表示するエディタにする(それ以外は、codeMirrorPluginの色分けつきエディタ)
    codeBlockPlugin({
      defaultCodeBlockLanguage: 'txt',
      codeBlockEditorDescriptors: [{ priority: 100, match: (language) => isMermaidLanguage(language), Editor: MermaidBlockEditor }],
    }),
    codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
  ];
}
