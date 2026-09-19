"""Build a validated, read-only SQLite derivative; never edit the input CSV."""

import argparse
import csv
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import stat
import sys
import tempfile
import time
from datetime import datetime, timezone

COLUMNS = (
    "line_id", "timestamp", "source", "event_type", "subject", "detail",
    "payload", "source_file", "raw_ref",
)
SELECT_COLUMNS = ", ".join(COLUMNS)


class BuildError(Exception):
    pass


def fingerprint(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return {"size_bytes": size, "sha256": digest.hexdigest()}


def csv_records(path, encoding):
    # newline="" preserves embedded CR, LF and CRLF verbatim in cell values.
    # No stripping, NULL conversion, timestamp parsing or JSON reserialization.
    with path.open("r", encoding=encoding, errors="strict", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        if next(reader, None) != list(COLUMNS):
            raise BuildError("CSV header must exactly match the nine normalized columns")
        header_lines = reader.line_num
        number = 0
        while True:
            physical_row = reader.line_num - header_lines + 1
            values = next(reader, None)
            if values is None:
                break
            number += 1
            if len(values) != len(COLUMNS):
                raise BuildError(
                    f"Record {number}, physical_row {physical_row}: expected nine fields, "
                    f"found {len(values)} (blank records are not silently skipped)"
                )
            yield (number, physical_row, *values)


def fts5_available():
    with closing(sqlite3.connect(":memory:")) as probe:
        try:
            probe.execute("CREATE VIRTUAL TABLE probe USING fts5(value)")
        except sqlite3.OperationalError as exc:
            if "no such module: fts5" in str(exc).lower():
                return False
            raise
    return True


def readonly_connection(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def verify_database(source, database, encoding, expected_count, sample_size):
    rng = random.SystemRandom()
    sample_rows = set(rng.sample(range(1, expected_count + 1), min(sample_size, expected_count)))
    samples = []
    first = last = None
    csv_count = 0
    connection = readonly_connection(database)
    try:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise BuildError("SQLite integrity_check failed")
        db_count = connection.execute("SELECT count(*) FROM records").fetchone()[0]
        duplicates = connection.execute(
            "SELECT count(*), coalesce(sum(n - 1), 0) FROM "
            "(SELECT count(*) AS n FROM records GROUP BY line_id HAVING count(*) > 1)"
        ).fetchone()
        if duplicates[0]:
            raise BuildError(
                f"Duplicate line_id: {duplicates[0]} groups, {duplicates[1]} extra records"
            )
        cursor = connection.execute(
            f"SELECT record_number, physical_row, {SELECT_COLUMNS} "
            "FROM records ORDER BY record_number"
        )
        for expected in csv_records(source, encoding):
            actual = cursor.fetchone()
            if actual != expected:
                raise BuildError(f"CSV/DB mismatch at record {expected[0]}")
            csv_count += 1
            if first is None:
                first = expected[2]
            last = expected[2]
            if expected[0] in sample_rows:
                samples.append(expected)
        if cursor.fetchone() is not None or csv_count != db_count or csv_count != expected_count:
            raise BuildError("CSV and SQLite record counts differ")
        for expected in samples:
            actual = connection.execute(
                f"SELECT record_number, physical_row, {SELECT_COLUMNS} "
                "FROM records WHERE record_number=?", (expected[0],)
            ).fetchone()
            if actual != expected:
                raise BuildError(f"Random sample mismatch at record {expected[0]}")
        db_first = connection.execute(
            "SELECT line_id FROM records ORDER BY record_number LIMIT 1"
        ).fetchone()
        db_last = connection.execute(
            "SELECT line_id FROM records ORDER BY record_number DESC LIMIT 1"
        ).fetchone()
        if (db_first[0] if db_first else None) != first or (db_last[0] if db_last else None) != last:
            raise BuildError("First or last line_id mismatch")
        return {
            "passed": True, "csv_rows": csv_count, "sqlite_rows": db_count,
            "first_line_id": first, "last_line_id": last,
            "duplicate_line_id_groups": duplicates[0],
            "duplicate_line_id_extra_rows": duplicates[1],
            "all_rows_equal": True, "random_samples_equal": len(samples),
            "sample_record_numbers": sorted(sample_rows), "sqlite_integrity": "ok",
        }
    finally:
        connection.close()


def build_database(source, destination, encoding="utf-8-sig", sample_size=32):
    started = time.perf_counter()
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    if not source.is_file():
        raise BuildError("Source must be a regular CSV file")
    if destination.exists() or destination.is_symlink():
        raise BuildError("Output already exists; refusing to overwrite any file")
    if not destination.parent.is_dir():
        raise BuildError("Output parent directory must already exist")
    if sample_size < 1:
        raise BuildError("sample_size must be positive")
    # The csv module's default field limit is too small for forensic payloads.
    field_limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(field_limit)
            break
        except OverflowError:
            field_limit //= 10
    before = fingerprint(source)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=destination.name + ".", suffix=".building", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    connection = None
    published = False
    try:
        connection = sqlite3.connect(temporary)
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA cache_size=-32768")
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute("PRAGMA user_version=1")
        column_definitions = ", ".join(f"{column} TEXT NOT NULL" for column in COLUMNS)
        connection.execute(
            "CREATE TABLE records (record_number INTEGER PRIMARY KEY, "
            "physical_row INTEGER NOT NULL UNIQUE CHECK (physical_row >= 1), "
            + column_definitions + ")"
        )
        connection.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        count = 0
        batch = []
        insert_sql = "INSERT INTO records VALUES (" + ",".join("?" for _ in range(11)) + ")"
        for row in csv_records(source, encoding):
            batch.append(row)
            count += 1
            if len(batch) == 1000:
                connection.executemany(insert_sql, batch)
                batch.clear()
        if batch:
            connection.executemany(insert_sql, batch)
        for column in ("line_id", "timestamp", "source", "event_type"):
            connection.execute(f"CREATE INDEX idx_records_{column} ON records ({column})")
        has_fts = fts5_available()
        if has_fts:
            connection.execute(
                "CREATE VIRTUAL TABLE records_fts USING fts5("
                "subject, detail, payload, content='records', content_rowid='record_number', "
                "tokenize='unicode61')"
            )
            connection.execute("INSERT INTO records_fts(records_fts) VALUES ('rebuild')")
            # rank=1 compares the external-content index with the original table.
            connection.execute(
                "INSERT INTO records_fts(records_fts, rank) VALUES ('integrity-check', 1)"
            )
        connection.commit()
        connection.close()
        connection = None
        build_seconds = time.perf_counter() - started
        validation = verify_database(source, temporary, encoding, count, sample_size)
        after = fingerprint(source)
        if after != before:
            raise BuildError("Source CSV changed during build or verification")
        validation["source_unchanged"] = True
        validation["fts_integrity"] = "ok" if has_fts else "unavailable"
        metadata = {
            "schema_version": 1,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "source_csv_path": str(source), "source_csv_size_bytes": before["size_bytes"],
            "source_csv_sha256": before["sha256"], "encoding": encoding,
            "columns": list(COLUMNS), "data_rows": count,
            "physical_row_definition": "1-based record start line after CSV header; embedded newlines count",
            "record_number_definition": "1-based logical CSV record ordinal after header",
            "sqlite_version": sqlite3.sqlite_version, "fts5_applied": has_fts,
            "fts5_tokenizer": "unicode61" if has_fts else None,
            "build_seconds": round(build_seconds, 6),
            "validation_seconds": round(time.perf_counter() - started - build_seconds, 6),
            "validation": validation,
        }
        connection = sqlite3.connect(temporary)
        connection.executemany("INSERT INTO metadata VALUES (?, ?)", [
            (key, json.dumps(value, ensure_ascii=True)) for key, value in metadata.items()
        ])
        connection.commit()
        connection.close()
        connection = None
        check = readonly_connection(temporary)
        try:
            if check.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise BuildError("Final database integrity_check failed")
            saved = {key: json.loads(value) for key, value in check.execute("SELECT * FROM metadata")}
            if saved != metadata:
                raise BuildError("Metadata read-back mismatch")
        finally:
            check.close()
        # Publish only validated output, without overwriting a competing output.
        # On Windows rename fails if destination exists. POSIX uses an exclusive link.
        if os.name == "nt":
            os.rename(temporary, destination)
        else:
            os.link(temporary, destination)
            temporary.unlink()
        published = True
        destination.chmod(stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
        return {
            "status": "passed", **metadata, "database_path": str(destination),
            "database_size_bytes": destination.stat().st_size,
            "total_seconds": round(time.perf_counter() - started, 6),
            "read_only_file": True,
        }
    finally:
        if connection is not None:
            connection.close()
        # Cleanup only this invocation's privately-created staging files.
        if not published:
            for path in (temporary, Path(str(temporary) + "-journal")):
                path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("database_path", type=Path)
    parser.add_argument("--encoding", default="utf-8-sig")
    parser.add_argument("--samples", type=int, default=32)
    args = parser.parse_args()
    try:
        report = build_database(args.csv_path, args.database_path, args.encoding, args.samples)
    except (BuildError, OSError, UnicodeError, LookupError, csv.Error, sqlite3.Error, ValueError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
