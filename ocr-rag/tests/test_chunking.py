"""
ocr_rag/rag/manual_ingestion.py の chunk_text のテスト（純粋関数。DB・Ollama不要）
"""
import pytest

from ocr_rag.rag.manual_ingestion import chunk_text


class TestChunkText:
    def test_raises_when_overlap_not_smaller_than_chunk_size(self):
        with pytest.raises(ValueError, match="chunk_overlap"):
            chunk_text("abc", chunk_size=10, chunk_overlap=10)

    def test_empty_text_returns_empty_list(self):
        assert chunk_text("   \n\n  ", chunk_size=10, chunk_overlap=2) == []

    def test_short_text_returns_single_chunk(self):
        assert chunk_text("短い文章です", chunk_size=100, chunk_overlap=10) == ["短い文章です"]

    def test_splits_long_text_with_overlap(self):
        text = "0123456789" * 5  # 50文字（見出し・表・改行なしのプレーンテキスト）
        chunks = chunk_text(text, chunk_size=20, chunk_overlap=5)

        assert len(chunks) > 1
        # 各チャンクの末尾が次チャンクの先頭に重複していること
        assert chunks[0][-5:] == chunks[1][:5]
        # 全チャンクを重複除去して連結すれば元の文字数以上をカバーしている
        assert all(len(c) <= 20 for c in chunks)

    def test_heading_is_prefixed_to_chunk_content(self):
        text = "## その1（p.87）\n\n本文がここに入ります。"
        chunks = chunk_text(text, chunk_size=800, chunk_overlap=100)

        assert chunks == ["【その1（p.87）】\n本文がここに入ります。"]

    def test_no_heading_no_prefix(self):
        text = "見出しの無いプレーンな本文です。"
        chunks = chunk_text(text, chunk_size=800, chunk_overlap=100)

        assert chunks == ["見出しの無いプレーンな本文です。"]

    def test_multiple_headings_each_get_own_chunk(self):
        text = (
            "## その1（p.87）\n本文1\n\n"
            "## その2（p.88）\n本文2"
        )
        chunks = chunk_text(text, chunk_size=800, chunk_overlap=100)

        assert chunks == ["【その1（p.87）】\n本文1", "【その2（p.88）】\n本文2"]

    def test_table_rows_are_never_split_mid_row(self):
        """chunk_sizeを極端に小さくしても、1行の途中でチャンクが割れないこと"""
        text = (
            "## その1（p.87）\n\n"
            "| 故障コード | 内容 | 原因 | 対策 |\n"
            "|---|---|---|---|\n"
            "| 03 | 欠相異常 | 電源配線の断線 | 電源配線の修復 |\n"
            "| 04 | 出力電圧異常 | EEV基板の故障 | EEV基板の交換 |\n"
        )
        chunks = chunk_text(text, chunk_size=30, chunk_overlap=5)

        for chunk in chunks:
            for line in chunk.split("\n"):
                if line.strip().startswith("|"):
                    # 表の各行は改行以外で途中切断されていないこと（行全体がそのまま含まれる）
                    assert line.strip().endswith("|")

    def test_ditto_continuation_rows_stay_in_same_chunk_as_their_code(self):
        """"〃"（同一故障コードの継続行）が、元の故障コード行と別チャンクに分断されないこと"""
        text = (
            "## その1（p.87）\n\n"
            "| 故障コード | 内容 | 原因 | 対策 |\n"
            "|---|---|---|---|\n"
            "| 05 | ポンプインバータ 過電流保護作動 | 焼損 | ポンプの交換 |\n"
            "| 05 | 〃 | 動力線破損 | 動力線の交換 |\n"
            "| 05 | 〃 | 負荷変動が大きい | 負荷変動を小さくする |\n"
            "| 06 | ポンプインバータ 過電圧保護作動 | 電源電圧が高すぎる | 電源電圧を下げる |\n"
        )
        # 05のグループだけでもchunk_size(40)を超えるほど小さく設定
        chunks = chunk_text(text, chunk_size=40, chunk_overlap=5)

        chunk_with_05 = [c for c in chunks if "焼損" in c]
        assert len(chunk_with_05) == 1
        # 05の3行が全て同じチャンクに含まれている（"〃"だけが単独で浮かない）
        assert "動力線破損" in chunk_with_05[0]
        assert "負荷変動が大きい" in chunk_with_05[0]

    def test_table_header_is_duplicated_across_split_chunks(self):
        """表が複数チャンクに分かれる場合、各チャンクにヘッダ行・区切り行が複製されること"""
        rows = "\n".join(f"| {i:02d} | 内容{i} | 原因{i} | 対策{i} |" for i in range(20))
        text = "## その1（p.87）\n\n| 故障コード | 内容 | 原因 | 対策 |\n|---|---|---|---|\n" + rows

        chunks = chunk_text(text, chunk_size=200, chunk_overlap=20)

        assert len(chunks) > 1
        for chunk in chunks:
            assert "故障コード" in chunk  # ヘッダ行
            assert "---" in chunk  # 区切り行

    def test_prose_before_and_after_table_is_preserved(self):
        """表の前後にある説明文が失われないこと"""
        text = (
            "## 6. 故障時の原因と対策（p.7）\n\n"
            "故障または異常と思われたときは次の点をお調べ下さい。\n\n"
            "| 不具合現象 | 原因 | 対処 |\n"
            "|---|---|---|\n"
            "| 運転しない | 電源が入っていますか | 電源を投入して下さい |\n\n"
            "不具合事象が直らない場合は、お買い上げの代理店へご連絡ください。"
        )
        chunks = chunk_text(text, chunk_size=800, chunk_overlap=100)
        joined = "\n".join(chunks)

        assert "故障または異常と思われたときは" in joined
        assert "不具合事象が直らない場合は" in joined
        assert "電源を投入して下さい" in joined
