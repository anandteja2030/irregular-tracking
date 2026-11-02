"""Phase 4: read-only repository connection error handling.

Regression cover for the context-manager bug found in the Phase 4 audit: an
error raised *inside* ``with connect() as conn:`` used to be caught at the
``yield`` and re-yielded, which Python reports as
``RuntimeError: generator didn't stop after throw()`` - a misleading 500 that
hid the real sqlite error.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from src.api import repository


@pytest.fixture()
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "app_data.db"
    monkeypatch.setattr(repository, "_db_path", lambda: path)
    return path


def _seed(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("INSERT INTO t (name) VALUES ('alpha')")
        conn.commit()
    finally:
        conn.close()


def test_missing_database_yields_none(db_path: Path):
    assert not db_path.exists()
    with repository.connect() as conn:
        assert conn is None


def test_corrupt_database_degrades_to_none(db_path: Path):
    db_path.write_bytes(b"this is definitely not a sqlite database\n" * 64)
    with repository.connect() as conn:
        assert conn is None


def test_valid_database_is_readable_and_closed(db_path: Path):
    _seed(db_path)
    with repository.connect() as conn:
        assert conn is not None
        assert conn.execute("SELECT name FROM t").fetchone()["name"] == "alpha"
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_statement_error_is_not_masked_by_a_runtime_error(db_path: Path):
    _seed(db_path)
    with pytest.raises(sqlite3.DatabaseError) as excinfo:
        with repository.connect() as conn:
            assert conn is not None
            conn.execute("SELECT * FROM missing_table")
    assert not isinstance(excinfo.value, RuntimeError), excinfo.value


def test_connection_is_read_only(db_path: Path):
    _seed(db_path)
    with pytest.raises(sqlite3.DatabaseError) as excinfo:
        with repository.connect() as conn:
            assert conn is not None
            conn.execute("INSERT INTO t (name) VALUES ('beta')")
    assert "readonly" in str(excinfo.value).lower(), excinfo.value
