import type { PageSettings } from '../shared/pageSettings';
import type { AssetStore } from './assets';

/** HTMLと一緒に取り込んだCSS */
export interface Stylesheet {
  // 取り込んだ一式の中でのパス(タブの表示にも使う)
  readonly path: string;
  // 保存するときの、HTMLのフォルダからの相対パス。HTMLの <link> が指している位置に合わせる
  readonly outputPath: string;
  readonly text: string;
}

/** 取り込んだ文書。Markdownは1ファイル、HTMLはCSS(0個以上)と一緒に取り込む。画像などは assets から参照する */
interface DocumentBase {
  // 取り込んだファイル名(フォルダを除く)。貼り付けの場合はnull
  readonly sourceName: string | null;
  // 文書があるフォルダ(取り込んだ一式のルートからの相対パス。ルートは '')。文書内の相対パスの基準
  readonly baseDir: string;
  // 取り込んだファイル一式(画像・CSSなど)
  readonly assets: AssetStore;
  // 自動保存した下書きから復元した文書か(復元した内容は、取り込んだ文書と違い、元のファイルが無い。「変更あり」として扱う)
  readonly restored?: boolean;
  // 下書きから復元した、ページ設定(取り込んだ文書は、前回の設定で始まるため、持たない)
  readonly pageSettings?: PageSettings;
}

export interface MarkdownDocument extends DocumentBase {
  readonly kind: 'markdown';
  readonly markdown: string;
}

export interface HtmlDocument extends DocumentBase {
  readonly kind: 'html';
  readonly html: string;
  // HTMLの<link>が参照している(または、一緒に選んだ)CSS
  readonly stylesheets: readonly Stylesheet[];
}

export type ImportedDocument = MarkdownDocument | HtmlDocument;
