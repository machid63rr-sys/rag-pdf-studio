import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PageLayout } from '../shared/pageLayout';
import { locatePageBreaks, type LocatedPageBreaks } from './pageBreaks';
import type { PageLayoutState } from './usePageLayout';

interface PageBreakOverlayProps {
  // プレビューを含む要素(この中の .md-editor-content に、線を重ねる)
  container: React.RefObject<HTMLElement>;
  state: PageLayoutState;
  // いまのMarkdown(測定した内容と違えば、測定結果は古い)
  markdown: string;
}

const ROOT_SELECTOR = '.md-editor-content';
const NO_BREAKS: LocatedPageBreaks = { markers: [], unplaced: 0 };

interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * プレビューの上に、PDFのページの区切りを線で重ねて、常に表示する。
 * 区切りは、サーバが、PDFと同じ文書・同じフォントで測った位置(どの内容の前で、次のページになるか)で、
 * プレビューの文字の折り返しが、PDFと違っても、同じ内容の前に線が入る。
 * 編集した直後は、測り直すまでの間、線を薄くして、古い位置であることを示す。
 */
const PageBreakOverlay: React.FC<PageBreakOverlayProps> = ({ container, state, markdown }) => {
  const [breaks, setBreaks] = useState<LocatedPageBreaks>(NO_BREAKS);
  const [box, setBox] = useState<Box | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const layout: PageLayout | null = state.layout;
  const frame = useRef<number | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // プレビューの位置・大きさと、線の位置を、計算し直す(続けて呼ばれても、描画の直前に1回だけ)
  const recompute = useCallback((): void => {
    if (frame.current !== null) {
      return;
    }
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      const wrapper = container.current;
      const root = wrapper?.querySelector<HTMLElement>(ROOT_SELECTOR);
      if (!wrapper || !root) {
        setBox(null);
        setBreaks(NO_BREAKS);
        return;
      }
      const wrapperRect = wrapper.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      setBox({ top: rootRect.top - wrapperRect.top, left: rootRect.left - wrapperRect.left, width: rootRect.width, height: rootRect.height });
      setScrollTop(root.scrollTop);
      setBreaks(layoutRef.current === null ? NO_BREAKS : locatePageBreaks(root, layoutRef.current));
    });
  }, [container]);

  // 測定結果が変わったとき
  useLayoutEffect(() => {
    recompute();
  }, [layout, recompute]);

  // プレビューの内容・大きさが変わったとき(編集・画像の読み込み・ウィンドウの大きさの変更)と、スクロールしたとき
  useEffect(() => {
    const wrapper = container.current;
    if (!wrapper) {
      return undefined;
    }
    let root: HTMLElement | null = null;
    const observers: { disconnect(): void }[] = [];
    const attach = (): void => {
      const found = wrapper.querySelector<HTMLElement>(ROOT_SELECTOR);
      if (!found || found === root) {
        return;
      }
      root = found;
      const mutation = new MutationObserver(recompute);
      mutation.observe(found, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'width', 'height', 'src'] });
      const resize = new ResizeObserver(recompute);
      resize.observe(found);
      resize.observe(wrapper);
      observers.push(mutation, resize);
      found.addEventListener('scroll', recompute, { passive: true });
      // 画像・図が読み込まれると、高さが変わる
      found.addEventListener('load', recompute, true);
      recompute();
    };
    attach();
    // エディタが、あとから作られる場合に備える
    const appear = new MutationObserver(attach);
    appear.observe(wrapper, { childList: true, subtree: true });
    window.addEventListener('resize', recompute);
    void document.fonts?.ready.then(recompute);
    return () => {
      appear.disconnect();
      observers.forEach((observer) => observer.disconnect());
      root?.removeEventListener('scroll', recompute);
      root?.removeEventListener('load', recompute, true);
      window.removeEventListener('resize', recompute);
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [container, recompute]);

  if (layout === null) {
    return state.status === 'error' ? <p className="page-status page-status-error">ページの区切りを測れませんでした({state.error})</p> : null;
  }
  const stale = state.measuredMarkdown !== markdown;
  const unplaced = breaks.unplaced > 0 && breaks.markers.length < layout.starts.length ? breaks.unplaced : 0;
  return (
    <>
      {box !== null && (
        <div className="page-overlay" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} data-testid="page-overlay">
          <div className="page-overlay-inner" style={{ transform: `translateY(${-scrollTop}px)` }}>
            {breaks.markers.map((marker) => (
              <div key={marker.page} className={`page-break${stale ? ' page-break-stale' : ''}`} style={{ top: marker.y }} data-page={marker.page}>
                <span className="page-break-label">{marker.page}ページ目</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className={`page-status${stale ? ' page-status-stale' : ''}${state.status === 'error' ? ' page-status-error' : ''}`}>
        赤い点線が、PDFのページの区切りです(全{layout.pages}ページ・A4)
        {stale && state.status !== 'error' ? ' ・測り直し中…' : ''}
        {state.status === 'error' ? ` ・更新できませんでした(${state.error})` : ''}
        {unplaced > 0 ? ` ・${unplaced}か所は、プレビューの上に表示できません` : ''}
      </p>
    </>
  );
};

export default PageBreakOverlay;
