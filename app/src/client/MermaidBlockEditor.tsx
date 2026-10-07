import React, { useEffect, useState } from 'react';
import { CodeMirrorEditor, useCodeBlockEditorContext, type CodeBlockEditorProps } from '@mdxeditor/editor';
import { diagramViewOf, withDiagramView, type DiagramView } from '../shared/mermaid';
import { drawDiagram, type DrawnDiagram } from './mermaidRender';

// PDFでの表示の選択肢(並び順は、表示のとおり)
const VIEW_OPTIONS: readonly { readonly view: DiagramView; readonly label: string }[] = [
  { view: 'diagram', label: '図のみ' },
  { view: 'code', label: 'コードのみ' },
  { view: 'both', label: 'コードと図' },
];

/** PDFに、図だけ・コードだけ・両方のどれを出すか。選択は、コードブロックの言語名の後ろ(show=○○)に保存される */
const ViewSelector: React.FC<{ nodeKey: string; meta: string }> = ({ nodeKey, meta }) => {
  const { setMeta } = useCodeBlockEditorContext();
  const current = diagramViewOf(meta);
  return (
    <fieldset className="mermaid-view">
      <legend>PDFでの表示</legend>
      {VIEW_OPTIONS.map(({ view, label }) => (
        <label key={view}>
          <input type="radio" name={`mermaid-view-${nodeKey}`} checked={current === view} onChange={() => setMeta(withDiagramView(meta, view))} /> {label}
        </label>
      ))}
    </fieldset>
  );
};

// 入力のたびに図を描き直すと重いため、入力が止まってから描く
const DRAW_DELAY_MS = 300;

const MermaidPreview: React.FC<{ code: string }> = ({ code }) => {
  const [drawn, setDrawn] = useState<DrawnDiagram | null>(null);
  const empty = code.trim() === '';

  useEffect(() => {
    if (empty) {
      return undefined;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void drawDiagram(code).then((result) => {
        if (current) {
          setDrawn(result);
        }
      });
    }, DRAW_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [code, empty]);

  if (empty) {
    return <p className="mermaid-status">Mermaidのコードを入力すると、ここに図が表示されます。</p>;
  }
  if (drawn === null) {
    return <p className="mermaid-status">図を描画しています…</p>;
  }
  if (!drawn.ok) {
    return (
      <p role="alert" className="mermaid-error">
        図を描画できません: {drawn.message}
      </p>
    );
  }
  return <img className="mermaid-image" src={drawn.uri} width={drawn.width} height={drawn.height} alt="Mermaidの図" />;
};

/**
 * Mermaidのコードブロックの編集。コードは通常のコードブロックと同じように編集でき、その下に、描画した図を表示する
 * (編集中は、コードと図のどちらも見えるようにしておく)。PDFにどれを出すかは、「PDFでの表示」で選ぶ。
 * 図は表示だけで、Markdownの本文には、コードと、表示の選択(show=○○)だけが入る。
 */
const MermaidBlockEditor: React.FC<CodeBlockEditorProps> = (props) => (
  <div className="mermaid-block">
    <CodeMirrorEditor {...props} />
    <div className="mermaid-preview">
      <MermaidPreview code={props.code} />
    </div>
    <ViewSelector nodeKey={props.nodeKey} meta={props.meta} />
  </div>
);

export default MermaidBlockEditor;
