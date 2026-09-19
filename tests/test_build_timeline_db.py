"""Synthetic data only: preservation, validation failures, and read-only output."""

import csv
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_timeline_db as builder


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "input.csv"
        self.output = self.root / "output.sqlite"
        fixture = Path(__file__).parent / "fixtures" / "timeline.csv"
        self.source.write_bytes(fixture.read_bytes())

    def tearDown(self):
        for path in self.root.iterdir():
            if path.is_file():
                path.chmod(stat.S_IREAD | stat.S_IWRITE)
        self.temp.cleanup()

    def write_rows(self, rows):
        with self.source.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(builder.COLUMNS)
            writer.writerows(rows)

    def assert_failure(self):
        with self.assertRaises((builder.BuildError, csv.Error, UnicodeError)):
            builder.build_database(self.source, self.output)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob("*.building*")))

    def test_fixture_roundtrip_and_fts(self):
        before = self.source.read_bytes()
        report = builder.build_database(self.source, self.output)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(report["data_rows"], 5)
        self.assertEqual(report["database_size_bytes"], self.output.stat().st_size)
        self.assertTrue(report["validation"]["all_rows_equal"])
        self.assertEqual(report["validation"]["random_samples_equal"], 5)
        self.assertEqual(report["validation"]["first_line_id"], "sample-a")
        self.assertEqual(report["validation"]["last_line_id"], "sample-e")
        self.assertEqual(report["validation"]["duplicate_line_id_groups"], 0)
        self.assertFalse(self.output.stat().st_mode & stat.S_IWRITE)
        db = builder.readonly_connection(self.output)
        try:
            self.assertEqual(db.execute("SELECT physical_row FROM records ORDER BY record_number").fetchall(),
                             [(1,), (2,), (4,), (5,), (6,)])
            self.assertEqual(db.execute("SELECT timestamp, subject, payload FROM records WHERE record_number=3").fetchone(),
                             ("  unchanged  ", "  preserve spaces  ", "null"))
            indexes = {row[1] for row in db.execute("PRAGMA index_list(records)")}
            for column in ("line_id", "timestamp", "source", "event_type"):
                self.assertIn("idx_records_" + column, indexes)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM records")
            if report["fts5_applied"]:
                self.assertEqual(db.execute("SELECT rowid FROM records_fts WHERE records_fts MATCH ?",
                                            ("quartz",)).fetchall(), [(1,)])
        finally:
            db.close()

    def test_bom_crlf_large_cell_nul_and_exact_text(self):
        rows = [
            ["000001", "", "test", "", "one\r\ntwo\rthree\nfour", "\t spacing ", "x" * 150000 + "\x00", "", ""],
            ["000002", "", "test", "", "", "", "", "", ""],
        ]
        self.write_rows(rows)
        report = builder.build_database(self.source, self.output)
        self.assertEqual(report["data_rows"], 2)
        db = builder.readonly_connection(self.output)
        try:
            self.assertEqual(db.execute(f"SELECT {builder.SELECT_COLUMNS} FROM records ORDER BY record_number").fetchall(),
                             [tuple(row) for row in rows])
            self.assertEqual(db.execute("SELECT physical_row FROM records ORDER BY record_number").fetchall(),
                             [(1,), (5,)])
        finally:
            db.close()

    def test_duplicates_fail_without_output(self):
        row = ["duplicate", "", "", "", "", "", "", "", ""]
        self.write_rows([row, row])
        self.assert_failure()

    def test_wrong_header_short_long_and_blank_rows_fail(self):
        header = ",".join(builder.COLUMNS) + "\n"
        for text in ("wrong\n", header + "short,row\n", header + "," * 9 + "\n", header + "\n"):
            with self.subTest(text=text):
                self.source.write_text(text, encoding="utf-8")
                self.assert_failure()

    def test_invalid_utf8_and_unclosed_quote_fail(self):
        header = (",".join(builder.COLUMNS) + "\n").encode()
        for suffix in (b"\xff\n", b'"unterminated\n'):
            with self.subTest(suffix=suffix):
                self.source.write_bytes(header + suffix)
                self.assert_failure()

    def test_existing_output_and_source_are_never_overwritten(self):
        original = self.source.read_bytes()
        with self.assertRaises(builder.BuildError):
            builder.build_database(self.source, self.source)
        self.output.write_bytes(b"existing output")
        with self.assertRaises(builder.BuildError):
            builder.build_database(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing output")
        self.assertEqual(self.source.read_bytes(), original)

    def test_empty_dataset(self):
        self.write_rows([])
        report = builder.build_database(self.source, self.output)
        self.assertEqual(report["data_rows"], 0)
        self.assertIsNone(report["validation"]["first_line_id"])
        self.assertIsNone(report["validation"]["last_line_id"])

    def test_fts_unavailable_is_explicit(self):
        with patch.object(builder, "fts5_available", return_value=False):
            report = builder.build_database(self.source, self.output)
        self.assertFalse(report["fts5_applied"])
        self.assertEqual(report["validation"]["fts_integrity"], "unavailable")

    def test_source_change_fails(self):
        before = builder.fingerprint(self.source)
        after = {**before, "sha256": "changed"}
        with patch.object(builder, "fingerprint", side_effect=[before, after]):
            self.assert_failure()

    def test_validation_detects_corruption_and_count_mismatch(self):
        builder.build_database(self.source, self.output)
        with self.assertRaises(builder.BuildError):
            builder.verify_database(self.source, self.output, "utf-8-sig", 6, 3)
        self.output.chmod(stat.S_IREAD | stat.S_IWRITE)
        db = sqlite3.connect(self.output)
        try:
            db.execute("UPDATE records SET detail='changed' WHERE record_number=2")
            db.commit()
        finally:
            db.close()
        with self.assertRaises(builder.BuildError):
            builder.verify_database(self.source, self.output, "utf-8-sig", 5, 3)


if __name__ == "__main__":
    unittest.main()
