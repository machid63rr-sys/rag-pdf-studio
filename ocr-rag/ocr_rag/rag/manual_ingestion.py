"""
マニュアルのチャンク分割・DB取り込み

chunk_text()は、Markdownの見出し・表の構造を考慮した分割（元システムのv2ロジックを
そのまま移したもの）。ingest_manual_text()は、分割→埋め込み→DB格納を行う。
"""
import logging
import re
from typing import Dict, List, Optional, Tuple
from uuid import UUID

from psycopg2.extras import RealDictCursor

from ocr_rag.rag.manual_pdf import fetch_manual_pdf, save_manual_pdf
from ocr_rag.rag.rag_retriever import ManualRetriever, to_pgvector_literal

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 800
DEFAULT_CHUNK_OVERLAP = 100


_HEADING_PATTERN = re.compile(r'^(#{1,6})[ \t]+(.+?)[ \t]*$', re.MULTILINE)


def _split_by_headings(text: str) -> List[Tuple[str, str]]:
    """
    Markdown見出し(#〜######)ごとにテキストを分割する

    Returns:
        [(見出しテキスト（#記号を除いた本文、無ければ""）, 見出し直下の本文), ...]
    """
    matches = list(_HEADING_PATTERN.finditer(text))
    if not matches:
        return [("", text)]

    sections = []
    if matches[0].start() > 0:
        preamble = text[:matches[0].start()]
        if preamble.strip():
            sections.append(("", preamble))

    for i, m in enumerate(matches):
        heading_text = m.group(2).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append((heading_text, text[body_start:body_end]))

    return sections


def _is_table_line(line: str) -> bool:
    return line.strip().startswith('|')


def _split_runs(lines: List[str]) -> List[Tuple[bool, List[str]]]:
    """連続する行を「表行の連続」と「非表行の連続」のランに分割する（順序を保持）"""
    runs: List[Tuple[bool, List[str]]] = []
    for line in lines:
        is_table = _is_table_line(line)
        if runs and runs[-1][0] == is_table:
            runs[-1][1].append(line)
        else:
            runs.append((is_table, [line]))
    return runs


def _group_table_data_rows(data_rows: List[str]) -> List[List[str]]:
    """
    表のデータ行を「先頭列（故障コード等）が同じ」まとまりでグループ化する

    書き起こし規約（docs/reports/manual_transcripts/*.md参照）: 同一故障コードに
    複数の原因・対策がある場合、先頭列（故障コード欄）はそのまま繰り返し、
    2列目以降（内容欄）を"〃"にしている（例: "| 05 | 〃 | 動力線破損... |"）。
    先頭列自体が"〃"または空になる書き方をされた場合も直前グループへの継続として扱う
    （念のための保険）。このグループを跨いでチャンクを分割すると、"〃"行だけが単独で
    参照され、どの故障コードの話か分からなくなるため、グループ単位でチャンク化する。
    """
    groups: List[List[str]] = []
    prev_first_col: Optional[str] = None
    for row in data_rows:
        cols = [c.strip() for c in row.strip().strip('|').split('|')]
        first_col = cols[0] if cols else ""
        if groups and (first_col in ("", "〃") or first_col == prev_first_col):
            groups[-1].append(row)
        else:
            groups.append([row])
        if first_col not in ("", "〃"):
            prev_first_col = first_col
    return groups


def _chunk_table_rows(rows: List[str], chunk_size: int) -> List[str]:
    """
    マークダウン表の行リスト（ヘッダ行・区切り行込み）を、行の途中で切らずに
    chunk_size文字を目安にまとめる。ヘッダ行・区切り行は各チャンクに複製し、
    どのチャンク単体を見ても列の意味が分かるようにする。
    """
    if len(rows) < 2:
        return ["\n".join(rows)] if rows else []

    header_lines = rows[:2]
    header_text = "\n".join(header_lines)
    groups = _group_table_data_rows(rows[2:])
    if not groups:
        return [header_text]

    chunks = []
    current_groups: List[List[str]] = []
    current_len = len(header_text)
    for group in groups:
        group_len = sum(len(r) + 1 for r in group)
        # 現チャンクが空でなく、このグループを足すとchunk_sizeを超える場合は確定して次へ
        # （グループ自体がchunk_sizeを超える場合でも、単独チャンクとしてそのまま採用する
        # ＝故障コードの分断より多少のサイズ超過を優先する）
        if current_groups and current_len + group_len > chunk_size:
            chunks.append("\n".join(header_lines + [r for g in current_groups for r in g]))
            current_groups = []
            current_len = len(header_text)
        current_groups.append(group)
        current_len += group_len

    if current_groups:
        chunks.append("\n".join(header_lines + [r for g in current_groups for r in g]))

    return chunks


def _chunk_fixed_length(text: str, chunk_size: int, chunk_overlap: int) -> List[str]:
    """文字数ベース固定長分割（表ではない、単一段落がchunk_sizeを超える場合のフォールバック）"""
    stripped = text.strip()
    if not stripped:
        return []

    chunks = []
    step = chunk_size - chunk_overlap
    start = 0
    while start < len(stripped):
        chunk = stripped[start:start + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        start += step
    return chunks


def _chunk_prose(text: str, chunk_size: int, chunk_overlap: int) -> List[str]:
    """表ではない本文を段落単位でchunk_size以内にまとめる"""
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', text.strip()) if p.strip()]
    if not paragraphs:
        return []

    chunks = []
    current: List[str] = []
    current_len = 0
    for para in paragraphs:
        if len(para) > chunk_size:
            if current:
                chunks.append("\n\n".join(current))
                current, current_len = [], 0
            chunks.extend(_chunk_fixed_length(para, chunk_size, chunk_overlap))
            continue

        added_len = len(para) + (2 if current else 0)
        if current and current_len + added_len > chunk_size:
            chunks.append("\n\n".join(current))
            current, current_len = [], 0
        current.append(para)
        current_len += len(para) + (2 if len(current) > 1 else 0)

    if current:
        chunks.append("\n\n".join(current))
    return chunks


def chunk_text(text: str, chunk_size: int, chunk_overlap: int) -> List[str]:
    """
    Markdownの見出し・表構造を考慮してテキストを分割する（v2）

    見出し(#〜######)ごとにセクション分割し、各チャンクの先頭に直近の見出しを
    "【見出し】"の形で付与する。セクション内が表の場合は行・故障コードグループの
    途中で切らず、表以外は段落単位でまとめる。

    Args:
        text: 分割対象の全文
        chunk_size: チャンクの目安文字数（表のグループ単位分割等では多少超過しうる）
        chunk_overlap: チャンク間で重複させる文字数（0以上、chunk_size未満。表のグループ
            単位分割には適用されない＝プレーンテキストのフォールバック分割のみで使う）

    Returns:
        チャンク文字列のリスト（空になるチャンクは除外）
    """
    if chunk_overlap >= chunk_size:
        raise ValueError(
            f"chunk_overlap({chunk_overlap})はchunk_size({chunk_size})未満である必要があります"
        )

    stripped = text.strip()
    if not stripped:
        return []

    chunks = []
    for heading, body in _split_by_headings(stripped):
        body = body.strip()
        if not body:
            continue

        for is_table, run_lines in _split_runs(body.split('\n')):
            run_text = "\n".join(run_lines).strip()
            if not run_text:
                continue

            if is_table and len(run_lines) >= 2:
                body_chunks = _chunk_table_rows(run_lines, chunk_size)
            elif len(run_text) <= chunk_size:
                body_chunks = [run_text]
            else:
                body_chunks = _chunk_prose(run_text, chunk_size, chunk_overlap)

            for body_chunk in body_chunks:
                if not body_chunk.strip():
                    continue
                chunks.append(f"【{heading}】\n{body_chunk}" if heading else body_chunk)

    return chunks


def ingest_manual_text(
    db,
    retriever: ManualRetriever,
    *,
    source_file_name: str,
    title: str,
    equipment_names: List[str],
    text: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    pdf_file_name: Optional[str] = None,
    pdf_content: Optional[bytes] = None,
) -> UUID:
    """
    テキストをチャンク分割→埋め込み→m_manual_document/m_manual_chunkへ格納する。

    equipment_namesは対象タグ名(複数可、空ならタグ名未設定の汎用マニュアル扱い)。
    同一source_file_nameの既存documentがあれば削除してから作り直す
    （配下chunkはON DELETE CASCADEで自動削除、部分更新はしない）。

    埋め込み（Ollama呼び出し、チャンク数に比例して時間がかかる）は、DBの
    トランザクションを開く前に全チャンク分まとめて行う。Ollamaの停止などで失敗した
    場合は、既存の登録済み文書に触れる前に停止する。

    pdf_file_name/pdf_content: 原本PDF（両方指定か両方None）。指定時はm_manual_pdfへ
    保存する。未指定で再登録する場合、既存documentに紐づく原本PDFは新documentへ
    引き継ぐ（削除のCASCADEで原本が黙って消えるのを防ぐ）。
    """
    if (pdf_file_name is None) != (pdf_content is None):
        raise ValueError("pdf_file_nameとpdf_contentは両方指定するか、両方とも省略してください")

    chunks_text = chunk_text(text, chunk_size, chunk_overlap)
    if not chunks_text:
        raise RuntimeError(f"{source_file_name}: 有効なテキストが抽出できませんでした（空ファイル？）")

    vector_literals = [to_pgvector_literal(retriever.embed(chunk)) for chunk in chunks_text]

    with db.get_cursor(cursor_factory=RealDictCursor) as cursor:
        previous_pdf = None
        if pdf_content is None:
            cursor.execute(
                "SELECT id FROM m_manual_document WHERE source_file_name = %s", (source_file_name,)
            )
            previous = cursor.fetchone()
            if previous:
                previous_pdf = fetch_manual_pdf(cursor, previous['id'])

        cursor.execute(
            "DELETE FROM m_manual_document WHERE source_file_name = %s", (source_file_name,)
        )
        cursor.execute(
            "INSERT INTO m_manual_document (title, source_file_name) VALUES (%s, %s) RETURNING id",
            (title, source_file_name)
        )
        document_id = cursor.fetchone()['id']

        for equipment_name in dict.fromkeys(equipment_names):
            cursor.execute(
                "INSERT INTO r_manual_document_equipment (document_id, equipment_name) VALUES (%s, %s)",
                (str(document_id), equipment_name)
            )

        if pdf_file_name is not None and pdf_content is not None:
            save_manual_pdf(cursor, document_id, pdf_file_name, pdf_content)
        elif previous_pdf is not None:
            save_manual_pdf(cursor, document_id, previous_pdf['file_name'], previous_pdf['content'])

        for index, (chunk, vector_literal) in enumerate(zip(chunks_text, vector_literals)):
            cursor.execute(
                """
                INSERT INTO m_manual_chunk (document_id, chunk_index, content, embedding)
                VALUES (%s, %s, %s, %s::vector)
                """,
                (str(document_id), index, chunk, vector_literal)
            )

    logger.info(f"{source_file_name}: {len(chunks_text)}チャンク登録完了（document_id={document_id}）")
    return document_id
