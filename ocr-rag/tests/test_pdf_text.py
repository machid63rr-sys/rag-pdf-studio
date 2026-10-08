"""ocr_rag/ocr/pdf_text.py のテスト(PDFのテキスト層の取り出しと照合)"""
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from ocr_rag.ocr import pdf_text
from ocr_rag.ocr.pdf_text import appears_in_page, extract_page_texts, has_text_layer, squash_for_search


class TestSquashForSearch:
    def test_ignores_whitespace_newlines_and_width(self):
        assert squash_for_search("ＡＢＣ 12\n3 ４５") == "ABC12345"

    def test_ignores_markdown_marks_and_dot_leaders(self):
        assert squash_for_search("| **点検方法**…………パネル |") == "点検方法パネル"
        assert squash_for_search("# 4.5【点検について】") == "4.5【点検について】"


class TestAppearsInPage:
    PAGE = squash_for_search("4.5【点検について】 定期的に点検を行い、結果を記録します。")

    def test_found_even_when_markup_and_whitespace_differ(self):
        assert appears_in_page(self.PAGE, "# 4.5【点検 について】\n") is True

    def test_not_found(self):
        assert appears_in_page(self.PAGE, "# 4.5【点検ついて】") is False

    def test_too_short_to_be_evidence_is_none(self):
        # 短い文字列は、ページのどこにでも見つかるため、根拠にしない
        assert appears_in_page(self.PAGE, "異常") is None
        assert appears_in_page(self.PAGE, " | ") is None


class TestHasTextLayer:
    def test_threshold(self):
        assert has_text_layer("あ" * pdf_text.TEXT_LAYER_MIN_CHARS) is True
        assert has_text_layer("あ" * (pdf_text.TEXT_LAYER_MIN_CHARS - 1)) is False
        assert has_text_layer("") is False


def _fake_run(stdout="", returncode=0, stderr=""):
    calls = []

    def _run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(stdout=stdout, returncode=returncode, stderr=stderr)

    return _run, calls


class TestExtractPageTexts:
    def test_splits_pages_and_drops_the_trailing_separator(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_text.shutil, "which", lambda name: "/usr/bin/pdftotext")
        run, calls = _fake_run(stdout="1ページ目の文字\f\f3ページ目の文字\f")
        monkeypatch.setattr(pdf_text.subprocess, "run", run)

        pages = extract_page_texts(tmp_path / "a.pdf")

        assert pages == ["1ページ目の文字", "", "3ページ目の文字"]  # 2ページ目は、テキスト層が無い
        assert calls[0][:3] == ["pdftotext", "-enc", "UTF-8"] and calls[0][-1] == "-"

    def test_password_is_passed_for_both_user_and_owner(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_text.shutil, "which", lambda name: "/usr/bin/pdftotext")
        run, calls = _fake_run(stdout="x\f")
        monkeypatch.setattr(pdf_text.subprocess, "run", run)

        extract_page_texts(tmp_path / "a.pdf", password="secret")

        assert ["-upw", "secret", "-opw", "secret"] == calls[0][3:7]

    def test_returns_none_when_pdftotext_is_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_text.shutil, "which", lambda name: None)
        assert extract_page_texts(tmp_path / "a.pdf") is None

    def test_returns_none_when_pdftotext_fails(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pdf_text.shutil, "which", lambda name: "/usr/bin/pdftotext")
        run, _ = _fake_run(returncode=1, stderr="Syntax Error: Couldn't read xref table")
        monkeypatch.setattr(pdf_text.subprocess, "run", run)
        assert extract_page_texts(tmp_path / "a.pdf") is None


def _minimal_pdf(page_texts):
    """英数字だけの、最小のPDF(1ページ1行)。pdftotextの実物で、取り出しと区切りを確かめるため"""
    objects = []
    page_ids = []
    next_id = 3
    for text in page_texts:
        page_ids.append(next_id)
        objects.append((next_id, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents {next_id + 1} 0 R "
                                  f"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>"))
        stream = f"BT /F1 18 Tf 20 100 Td ({text}) Tj ET"
        objects.append((next_id + 1, f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"))
        next_id += 2
    kids = " ".join(f"{i} 0 R" for i in page_ids)
    objects = [(1, "<< /Type /Catalog /Pages 2 0 R >>"), (2, f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>")] + objects
    body = b"%PDF-1.4\n"
    offsets = {}
    for number, content in sorted(objects):
        offsets[number] = len(body)
        body += f"{number} 0 obj\n{content}\nendobj\n".encode("ascii")
    xref = len(body)
    size = max(offsets) + 1
    body += f"xref\n0 {size}\n0000000000 65535 f \n".encode("ascii")
    for number in range(1, size):
        body += f"{offsets[number]:010d} 00000 n \n".encode("ascii")
    body += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    return body


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="pdftotext(poppler-utils)が無い環境")
class TestWithRealPdftotext:
    def test_extracts_each_page_in_order(self, tmp_path):
        pdf = tmp_path / "two.pdf"
        pdf.write_bytes(_minimal_pdf(["First page text", "Second page text"]))

        pages = extract_page_texts(pdf)

        assert pages is not None and len(pages) == 2
        assert "First page text" in pages[0] and "Second page text" in pages[1]

    def test_returns_none_for_a_file_that_is_not_a_pdf(self, tmp_path):
        broken = tmp_path / "broken.pdf"
        broken.write_bytes(b"not a pdf")
        assert extract_page_texts(broken) is None
