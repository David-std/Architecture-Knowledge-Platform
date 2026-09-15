from __future__ import annotations

from types import SimpleNamespace

from app.adapters.docling_native import _table_data


def test_docling_table_mapper_accepts_current_offset_idx_fields() -> None:
    item = SimpleNamespace(
        data=SimpleNamespace(
            table_cells=[
                {
                    "start_row_offset_idx": 0,
                    "end_row_offset_idx": 1,
                    "start_col_offset_idx": 0,
                    "end_col_offset_idx": 1,
                    "text": "topic",
                    "column_header": True,
                },
                {
                    "start_row_offset_idx": 0,
                    "end_row_offset_idx": 1,
                    "start_col_offset_idx": 1,
                    "end_col_offset_idx": 2,
                    "text": "strategy",
                    "column_header": True,
                },
                {
                    "start_row_offset_idx": 1,
                    "end_row_offset_idx": 2,
                    "start_col_offset_idx": 0,
                    "end_col_offset_idx": 1,
                    "text": "architecture",
                },
                {
                    "start_row_offset_idx": 1,
                    "end_row_offset_idx": 2,
                    "start_col_offset_idx": 1,
                    "end_col_offset_idx": 2,
                    "text": "deterministic",
                },
            ]
        )
    )

    headers, rows, metadata = _table_data(item)

    assert headers == ["topic", "strategy"]
    assert rows == [["architecture", "deterministic"]]
    assert metadata["docling_table_cells"][0]["row_start"] == 0
    assert metadata["docling_table_cells"][3]["col_end"] == 2
