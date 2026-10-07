/*
 * 「どのファイルを保存するか」の選択に関する、画面の部品から切り離した純粋関数。
 * 保存するファイルの数にかかわらず、先にファイル名を決めてからフォルダを選んで保存する。
 */

export type OutputContent =
  | { readonly type: 'text'; readonly text: string; readonly mimeType: string }
  // PDF。保存の直前に、サーバで生成する
  | { readonly type: 'pdf' };

export interface OutputFile {
  readonly id: string;
  // チェックボックスの表示(例: "Markdown (.md)")
  readonly label: string;
  // ボタンの文言に使う短い名前(例: "MD")
  readonly shortLabel: string;
  // 拡張子(ドットなし)。fixedName が無ければ「<利用者が決めた名前>.<拡張子>」で保存する
  readonly extension: string;
  // 固定のファイル名。HTMLから参照されているCSSなど、名前を変えられないもの
  readonly fixedName?: string;
  readonly content: OutputContent;
}

export const NO_SELECTION_HINT = '保存するファイルを1つ以上選んでください。';

export const fileNameOf = (file: OutputFile, baseName: string): string => file.fixedName ?? `${baseName}.${file.extension}`;

// 利用者が決める名前(拡張子なし)を使うファイルが、選ばれているか
export const usesBaseName = (chosen: readonly OutputFile[]): boolean => chosen.some((file) => file.fixedName === undefined);

export const chosenFiles = (files: readonly OutputFile[], selected: ReadonlySet<string>): OutputFile[] =>
  files.filter((file) => selected.has(file.id));

// 「選んだフォルダへ出力」ボタンの文言(例: "選んだフォルダへMDとPDFを出力")
export function folderOutputLabel(chosen: readonly OutputFile[]): string {
  const labels = [...new Set(chosen.map((file) => file.shortLabel))];
  return `選んだフォルダへ${labels.join('と')}を出力`;
}

// ファイル名欄の横に示す、保存されるファイルの種類(例: ".md / .pdf")。固定名のファイルは、その名前を示す
export function selectedExtensions(chosen: readonly OutputFile[]): string {
  return chosen.map((file) => file.fixedName ?? `.${file.extension}`).join(' / ');
}
