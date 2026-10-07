"""
src/manuals/table_repair.py のテスト

入力は、実際のOCR下書き(OHU-1.pdf、2026-10-02〜10-05)で確認した崩れ方を元にしている。
いずれも「表として認識されない」→画面でパイプ付きの生テキストになる原因だった。
"""
import pytest

from ocr_rag.ocr.table_repair import repair_markdown_tables

VALID_TABLE = (
    "| 表示 | エラー名称 | 表示 | エラー名称 |\n"
    "| --- | --- | --- | --- |\n"
    "| E001 | 圧縮機高圧異常 | E018 | 還気温度センサ異常 |\n"
    "| E017 | 給気温度センサ異常 |  |  |"
)

REPAIRED_HEADER = "| 表示 | エラー名称 | 表示 | エラー名称 |"


class TestTablesThatAreAlreadyValid:
    def test_valid_table_is_left_byte_identical(self):
        text = f"<エラー一覧表>\n{VALID_TABLE}\n\n※注記です。"
        assert repair_markdown_tables(text) == text

    def test_compact_delimiter_and_alignment_markers_are_left_alone(self):
        text = "| 原因 | 対策 |\n|---|:---:|\n| ①損傷 | 交換する |"
        assert repair_markdown_tables(text) == text

    def test_escaped_pipe_does_not_count_as_a_column_boundary(self):
        text = "| 式 \\| 値 | 説明 |\n| --- | --- |\n| a | b |"
        assert repair_markdown_tables(text) == text

    def test_delimiter_like_row_inside_a_table_does_not_split_it(self):
        """表の途中にある区切り行風の行を、新しい表のヘッダ判定に使って既存の表を分割しない"""
        text = "| a | b |\n| --- | --- |\n| c | d |\n| --- | --- |\n| e | f |"
        assert repair_markdown_tables(text) == text

    def test_text_without_tables_and_empty_text_are_unchanged(self):
        assert repair_markdown_tables("") == ""
        assert repair_markdown_tables("見出し\n\n本文です。| 1 | 2 |") == "見出し\n\n本文です。| 1 | 2 |"


class TestHeaderWithJunkDelimiterFragments:
    @pytest.mark.parametrize(
        "broken_header",
        [
            "| 表示 | エラー名称 | 表示 | エラー名称 | :--- | :--- | : |",  # 2026-10-05の下書き
            "| 表示 | エラー名称 | 表示 | エラー名称 | :--- | :--- | :--- | |",  # 2026-10-02の下書き
        ],
    )
    def test_trailing_fragments_are_removed_so_header_matches_delimiter(self, broken_header):
        text = (
            "<エラー一覧表>\n"
            f"{broken_header}\n"
            "| --- | --- | --- | --- |\n"
            "| E001 | 圧縮機高圧異常 | E018 | 還気温度センサ異常 |"
        )
        assert repair_markdown_tables(text) == (
            "<エラー一覧表>\n"
            f"{REPAIRED_HEADER}\n"
            "| --- | --- | --- | --- |\n"
            "| E001 | 圧縮機高圧異常 | E018 | 還気温度センサ異常 |"
        )

    def test_legitimate_empty_header_cell_within_delimiter_width_is_kept(self):
        text = "| 名称 | 値 |  |\n| --- | --- | --- |\n| a | b | c |"
        assert repair_markdown_tables(text) == text


class TestHeaderWithExtraCellThatHasContent:
    def test_delimiter_is_widened_and_no_text_is_dropped(self):
        """文言を持つ余分なセルを切り捨てると無言のデータ欠落になるため、区切り行の方を広げる"""
        text = (
            "| お知らせ | 名称 | 内容 | 補足です。 |\n"
            "| :--- | --- | --- |\n"
            "| お知らせ | 低下 | 発生します。 |"
        )
        assert repair_markdown_tables(text) == (
            "| お知らせ | 名称 | 内容 | 補足です。 |\n"
            "| :--- | --- | --- | --- |\n"
            "| お知らせ | 低下 | 発生します。 |"
        )

    def test_content_cell_followed_by_junk_keeps_the_content(self):
        text = "| a | b | 補足 | :--- |\n| --- | --- |\n| c | d |"
        assert repair_markdown_tables(text) == "| a | b | 補足 |\n| --- | --- | --- |\n| c | d |"


class TestNoteWedgedBetweenHeaderAndDelimiter:
    def test_note_is_moved_below_the_table_with_a_blank_line(self):
        """2026-10-05の下書きの実例: 注記行が表のヘッダと区切り行の間に割り込んでいた"""
        text = (
            "■その他お知らせ（警報とは異なる）\n"
            "| お知らせ | フィルター目詰り | フィルターが目詰りすると発生します。 | 制御盤内温度の規定値以上になると発生します。 |\n"
            "※お知らせは発生時に運転画面に表示されます。装置は停止しませんが、早急に対応するべき内容です。 |\n"
            "| --- | --- | --- |\n"
            "| お知らせ | シーケンサ バッテリ電圧低下 | シーケンサのバッテリ電圧が一定以下になると発生します。 |\n"
            "| お知らせ | 制御盤高温異常 | 制御盤内温度が規定値以上になると発生します。 |\n"
            "\n"
            "※お知らせは発生時に運転画面に表示されます。装置は停止しませんが、早急に対応すべき内容です。"
        )
        assert repair_markdown_tables(text) == (
            "■その他お知らせ（警報とは異なる）\n"
            "| お知らせ | フィルター目詰り | フィルターが目詰りすると発生します。 | 制御盤内温度の規定値以上になると発生します。 |\n"
            "| --- | --- | --- | --- |\n"
            "| お知らせ | シーケンサ バッテリ電圧低下 | シーケンサのバッテリ電圧が一定以下になると発生します。 |\n"
            "| お知らせ | 制御盤高温異常 | 制御盤内温度が規定値以上になると発生します。 |\n"
            "\n"
            "※お知らせは発生時に運転画面に表示されます。装置は停止しませんが、早急に対応するべき内容です。\n"
            "\n"
            "※お知らせは発生時に運転画面に表示されます。装置は停止しませんが、早急に対応すべき内容です。"
        )

    def test_blank_line_is_added_when_text_follows_the_table_directly(self):
        """表の直後の文章行はGFMでは表の行として取り込まれるため、移した注記と後続の文章を分ける"""
        text = "| a | b |\n注記です。 |\n| --- | --- |\n| c | d |\n次の段落です。"
        assert repair_markdown_tables(text) == "| a | b |\n| --- | --- |\n| c | d |\n\n注記です。\n\n次の段落です。"

    def test_note_without_trailing_pipe_is_not_treated_as_wedged(self):
        """行末が`|`でない行は表の断片と断定できないため触らない（警告表示に委ねる）"""
        text = "| a | b |\n注記です。\n| --- | --- |\n| c | d |"
        assert repair_markdown_tables(text) == text


class TestUnrepairableTablesAreLeftUntouched:
    def test_delimiter_with_empty_cell_is_not_guessed(self):
        """2026-10-04の下書き(結合セルを無理に書いた表)の実例。どの列が正しいか判断できない"""
        text = "| 症状 | 調べるところ | 運転再開するとき |\n| :--- | :--- | |\n| 運転しない | 電源は入っていますか。 | 電源を入れてください。 |"
        assert repair_markdown_tables(text) == text

    def test_header_shorter_than_delimiter_is_not_guessed(self):
        text = "| a | b |\n| --- | --- | --- |\n| c | d | e |"
        assert repair_markdown_tables(text) == text


class TestCodeFences:
    def test_table_like_text_inside_code_fence_is_untouched(self):
        text = "```\n| a | b | :--- |\n| --- | --- |\n```"
        assert repair_markdown_tables(text) == text

    def test_table_after_closed_fence_is_repaired(self):
        text = "```\ncode\n```\n| a | b | : |\n| --- | --- |\n| c | d |"
        assert repair_markdown_tables(text) == "```\ncode\n```\n| a | b |\n| --- | --- |\n| c | d |"


class TestIdempotence:
    @pytest.mark.parametrize(
        "text",
        [
            "| a | b | :--- | : |\n| --- | --- |\n| c | d |",
            "| a | b | 補足 |\n| --- | --- |\n| c | d |",
            "| a | b |\n注記です。 |\n| --- | --- |\n| c | d |",
        ],
    )
    def test_repairing_twice_equals_repairing_once(self, text):
        once = repair_markdown_tables(text)
        assert repair_markdown_tables(once) == once
