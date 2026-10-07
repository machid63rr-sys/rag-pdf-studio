import { classifyReference } from '../shared/assetPath';
import { isImagePath, type AssetStore } from './assets';
import { candidateImageReferences } from './markdownRefs';

/**
 * PDF生成のために、Markdownが参照している、取り込んだ画像を読み込み、サーバへ渡す形にする。
 * キーは、Markdownに書かれた参照を、Markdownのフォルダを基準に解決したパス(サーバも同じ規則で解決して探す)。
 * 値は、実際に見つかった画像ファイルの data: URI(ファイルを個別に選んだ場合は、フォルダ名が違っても、ファイル名で見つけたもの)。
 */
export async function collectMarkdownAssets(markdown: string, baseDir: string, assets: AssetStore): Promise<Record<string, string>> {
  const found: { key: string; path: string }[] = [];
  for (const reference of candidateImageReferences(markdown)) {
    const parsed = classifyReference(reference, baseDir);
    const path = assets.resolve(reference, baseDir);
    if (parsed.kind === 'local' && parsed.path !== null && path !== undefined && isImagePath(path)) {
      found.push({ key: parsed.path, path });
    }
  }
  await assets.ensure(found.map((entry) => entry.path));
  const result: Record<string, string> = {};
  for (const { key, path } of found) {
    const uri = assets.dataUri(path);
    if (uri !== undefined) {
      result[key] = uri;
    }
  }
  return result;
}
