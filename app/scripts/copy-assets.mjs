// サーバのビルド成果物(dist/server)へ、実行時に読み込むファイルをコピーする。
// - 共有CSS: プレビュー(クライアント)とPDF(サーバ)が同じCSSを使うことで見た目を揃えるため
// - Mermaid: PDFに入れる図を、サーバのChromiumで描画するため(実行用のイメージには開発依存を入れないので、ここへ置く)
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/server', { recursive: true });
for (const [from, to] of [
  ['src/shared/document.css', 'dist/server/document.css'],
  ['node_modules/mermaid/dist/mermaid.min.js', 'dist/server/mermaid.min.js'],
]) {
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
