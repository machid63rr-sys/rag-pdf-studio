/** multipart/form-data の1つの項目 */
export interface MultipartPart {
  readonly name: string;
  // ファイルのときだけ、ファイル名がある
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly data: Buffer;
}

const HEADER_END = Buffer.from('\r\n\r\n');
const CRLF = Buffer.from('\r\n');

/** multipart/form-data の本文を、項目ごとに分ける(バイナリを壊さない。テストの偽サーバが、アップロードを読むために使う) */
export function parseMultipart(contentType: string, body: Buffer): MultipartPart[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const token = boundary?.[1] ?? boundary?.[2];
  if (token === undefined) {
    throw new Error(`multipart の boundary がありません: ${contentType}`);
  }
  const delimiter = Buffer.from(`--${token}`);
  const parts: MultipartPart[] = [];
  let position = body.indexOf(delimiter);
  while (position !== -1) {
    const start = position + delimiter.length;
    // 終端(--)なら終わり。そうでなければ、改行の後から、次の区切りまでが1項目
    if (body.subarray(start, start + 2).toString() === '--') {
      break;
    }
    const next = body.indexOf(delimiter, start);
    if (next === -1) {
      break;
    }
    const raw = body.subarray(start + CRLF.length, next - CRLF.length);
    const headerEnd = raw.indexOf(HEADER_END);
    const headers = raw.subarray(0, headerEnd).toString('utf8');
    const disposition = /Content-Disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
    const name = /name="([^"]*)"/.exec(disposition)?.[1];
    if (name !== undefined) {
      parts.push({
        name,
        filename: /filename="([^"]*)"/.exec(disposition)?.[1] ?? null,
        contentType: /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? null,
        data: raw.subarray(headerEnd + HEADER_END.length),
      });
    }
    position = next;
  }
  return parts;
}
