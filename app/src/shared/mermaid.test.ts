import { describe, expect, it } from 'vitest';
import { diagramErrorMessage, diagramViewOf, isMermaidLanguage, sizedSvg, withDiagramView } from './mermaid.js';

describe('isMermaidLanguage', () => {
  it('mermaid(大文字・前後の空白を含む)だけがtrue', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true);
    expect(isMermaidLanguage('Mermaid')).toBe(true);
    expect(isMermaidLanguage(' mermaid ')).toBe(true);
    expect(isMermaidLanguage('mermaidjs')).toBe(false);
    expect(isMermaidLanguage('python')).toBe(false);
    expect(isMermaidLanguage('')).toBe(false);
    expect(isMermaidLanguage(null)).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
  });
});

describe('sizedSvg', () => {
  const mermaidSvg =
    '<svg id="mmd0" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 360px;" viewBox="4 4 360 430.5"><g stroke-width="2"></g></svg>';

  it('幅100%のSVGに、viewBoxの大きさを幅・高さとして付ける(小数は切り上げ)', () => {
    const sized = sizedSvg(mermaidSvg);
    expect(sized?.width).toBe(360);
    expect(sized?.height).toBe(431);
    expect(sized?.svg).toContain('<svg width="360" height="431" id="mmd0" xmlns="http://www.w3.org/2000/svg"');
    expect(sized?.svg).not.toContain('width="100%"');
  });

  it('ルート要素以外の属性(stroke-widthなど)や中身は変えない', () => {
    const sized = sizedSvg(mermaidSvg);
    expect(sized?.svg).toContain('<g stroke-width="2"></g></svg>');
    expect(sized?.svg).toContain('style="max-width: 360px;"');
  });

  it('XML宣言があっても扱える', () => {
    const sized = sizedSvg(`<?xml version="1.0"?>\n${mermaidSvg}`);
    expect(sized?.width).toBe(360);
    expect(sized?.svg.startsWith('<?xml version="1.0"?>')).toBe(true);
  });

  it('負の原点を持つviewBoxも読める', () => {
    expect(sizedSvg('<svg viewBox="-50 -10 450 347"></svg>')).toMatchObject({ width: 450, height: 347 });
  });

  it('viewBoxが無い・大きさが不正なら null', () => {
    expect(sizedSvg('<svg width="100%"></svg>')).toBeNull();
    expect(sizedSvg('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
    expect(sizedSvg('<div viewBox="0 0 10 10"></div>')).toBeNull();
    expect(sizedSvg('')).toBeNull();
  });
});

describe('diagramErrorMessage', () => {
  it('複数行のエラーは、先頭の1行だけにする', () => {
    expect(diagramErrorMessage(new Error('Parse error on line 2:\n...\n-----^\nExpecting X'))).toBe('Parse error on line 2:');
  });

  it('空のメッセージは、定型の文にする', () => {
    expect(diagramErrorMessage(new Error(''))).toBe('図の記法を解釈できません');
  });

  it('Errorでない値も文字にする。長すぎるメッセージは切り詰める', () => {
    expect(diagramErrorMessage('失敗')).toBe('失敗');
    expect(diagramErrorMessage('あ'.repeat(500))).toHaveLength(200);
  });
});

describe('diagramViewOf', () => {
  it('show=diagram / code / both を読む(大文字も可)', () => {
    expect(diagramViewOf('show=diagram')).toBe('diagram');
    expect(diagramViewOf('show=code')).toBe('code');
    expect(diagramViewOf('show=both')).toBe('both');
    expect(diagramViewOf('SHOW=Both')).toBe('both');
  });

  it('書かれていない・空・読めない値は、既定の「図のみ」', () => {
    for (const meta of [undefined, null, '', '   ', 'show=', 'show=none', 'show', 'xshow=code', 'showcode']) {
      expect(diagramViewOf(meta), String(meta)).toBe('diagram');
    }
  });

  it('ほかのメタ情報と並んでいても読める', () => {
    expect(diagramViewOf('title="a" show=code {1,3}')).toBe('code');
  });
});

describe('withDiagramView', () => {
  it('選択を書き込む。既定(図のみ)のときは、書かない', () => {
    expect(withDiagramView('', 'both')).toBe('show=both');
    expect(withDiagramView(null, 'code')).toBe('show=code');
    expect(withDiagramView(undefined, 'diagram')).toBe('');
  });

  it('既存の選択を置き換える。ほかのメタ情報は残す', () => {
    expect(withDiagramView('show=both', 'code')).toBe('show=code');
    expect(withDiagramView('show=both', 'diagram')).toBe('');
    expect(withDiagramView('title=a show=code x', 'both')).toBe('title=a x show=both');
    expect(withDiagramView('title=a', 'diagram')).toBe('title=a');
  });

  it('書いた結果を、読み直すと同じになる', () => {
    for (const view of ['diagram', 'code', 'both'] as const) {
      expect(diagramViewOf(withDiagramView('title=a', view))).toBe(view);
    }
  });
});
