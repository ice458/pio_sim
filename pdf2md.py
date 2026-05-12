import pymupdf4llm
import pathlib

# PDFファイルのパス
pdf_path = "RP-008373-DS-2-rp2350-datasheet.pdf"

# Markdownテキストとして抽出
md_text = pymupdf4llm.to_markdown(pdf_path)

# ファイルに保存
pathlib.Path("RP-008373-DS-2-rp2350-datasheet.md").write_bytes(md_text.encode())