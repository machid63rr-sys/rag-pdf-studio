import { useEffect, useRef, useState } from 'react';
import type { PageLayout } from '../shared/pageLayout';
import type { PageSettings } from '../shared/pageSettings';
import type { AssetStore } from './assets';
import { createBrowserImageSizer, withImagePlaceholders, type ImageSizer } from './layoutPayload';
import { collectMarkdownAssets } from './markdownAssets';
import { requestPageLayout } from './pageLayoutClient';

// 編集が止まってから測る(入力のたびに、サーバへ頼まない)。最初の1回は、すぐに
const FIRST_DELAY_MS = 150;
const EDIT_DELAY_MS = 700;

export interface PageLayoutState {
  // 最後に測れた結果と、そのときのMarkdown(いまのMarkdownと違えば、結果は古い)
  readonly layout: PageLayout | null;
  readonly measuredMarkdown: string | null;
  readonly status: 'idle' | 'measuring' | 'error';
  readonly error: string | null;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * MarkdownをPDFにしたときの、ページの区切り位置を、サーバに測ってもらう(用紙・向き・余白は、ページ設定どおり)。
 * Markdownの編集が止まるたびと、ページ設定を変えたときに、測り直す(測っている最中に編集されたら、その測定は捨てる)。
 */
export function usePageLayout(markdown: string, enabled: boolean, baseDir: string, assets: AssetStore, pageSettings: PageSettings): PageLayoutState {
  const [state, setState] = useState<PageLayoutState>({ layout: null, measuredMarkdown: null, status: 'idle', error: null });
  const first = useRef(true);
  const sizer = useRef<ImageSizer | null>(null);

  useEffect(() => {
    if (!enabled || markdown.trim() === '') {
      setState((current) => ({ ...current, status: 'idle' }));
      return undefined;
    }
    setState((current) => (current.status === 'measuring' ? current : { ...current, status: 'measuring' }));
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        first.current = false;
        sizer.current ??= createBrowserImageSizer();
        void (async () => {
          try {
            const files = await collectMarkdownAssets(markdown, baseDir, assets);
            const light = await withImagePlaceholders(markdown, files, sizer.current as ImageSizer);
            const layout = await requestPageLayout({ kind: 'markdown', text: light.markdown, baseDir, assets: light.assets, pageSettings }, controller.signal);
            if (!controller.signal.aborted) {
              setState({ layout, measuredMarkdown: markdown, status: 'idle', error: null });
            }
          } catch (cause) {
            if (!controller.signal.aborted) {
              setState((current) => ({ ...current, status: 'error', error: messageOf(cause) }));
            }
          }
        })();
      },
      first.current ? FIRST_DELAY_MS : EDIT_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [markdown, enabled, baseDir, assets, pageSettings]);

  return state;
}
