"""Database connection layer for Kontur.

SQLite remains the zero-configuration default for a single-host
deployment.  When ``DATABASE_URL`` points at PostgreSQL, the same
small SQL surface used by the application is translated to psycopg's
parameter style and connections are borrowed from a bounded pool.

This is intentionally not an ORM.  The project already has a compact,
explicit SQL layer; this module only makes that layer portable and
keeps SQLite/PostgreSQL connection policy in one place.
"""

from __future__ import annotations

import hashlib
import logging
import os
import queue
import re
import sqlite3
import threading
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .config import (
    DATABASE_CONNECT_TIMEOUT_SECONDS,
    DATABASE_PATH,
    DATABASE_POOL_MAX,
    DATABASE_URL,
    SQLITE_BUSY_TIMEOUT_MS,
    SQLITE_CACHE_SIZE_KIB,
    SQLITE_JOURNAL_MODE,
    SQLITE_SYNCHRONOUS,
)


class DatabaseError(RuntimeError):
    """A database operation failed in a dialect-neutral way."""


class DatabaseConfigurationError(DatabaseError):
    """The configured database target or driver is not usable."""


logger = logging.getLogger(__name__)


def _close_quietly(raw: Any) -> None:
    try:
        raw.close()
    except Exception:
        logger.debug("Failed to close a database connection", exc_info=True)


_IDENTITY_TABLES = {
    "reaction_outbox",
    "realtime_events",
    "risk_calculations",
    "risk_events",
}
_SQLITE_JOURNAL_MODES = {"DELETE", "MEMORY", "OFF", "PERSIST", "TRUNCATE", "WAL"}
_SQLITE_SYNCHRONOUS_MODES = {"EXTRA", "FULL", "NORMAL", "OFF"}


class Row:
    """A DB-API row supporting both positional and column-name access."""

    __slots__ = ("_columns", "_positions", "_values")

    def __init__(self, columns: Sequence[str], values: Sequence[Any]) -> None:
        self._columns = tuple(str(column) for column in columns)
        self._values = tuple(values)
        positions: dict[str, int] = {}
        for index, column in enumerate(self._columns):
            positions.setdefault(column, index)
        self._positions = positions

    def __getitem__(self, key: str | int | slice) -> Any:
        if isinstance(key, str):
            try:
                return self._values[self._positions[key]]
            except KeyError:
                raise KeyError(key) from None
        return self._values[key]

    def __iter__(self) -> Iterator[Any]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __contains__(self, key: object) -> bool:
        if isinstance(key, str) and key in self._positions:
            return True
        return key in self._values

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Row):
            return self._columns == other._columns and self._values == other._values
        if isinstance(other, Mapping):
            return dict(zip(self._columns, self._values, strict=False)) == dict(other)
        if isinstance(other, Sequence) and not isinstance(other, (str, bytes)):
            return self._values == tuple(other)
        return NotImplemented

    def __repr__(self) -> str:
        return f"Row(columns={self._columns!r}, values={self._values!r})"

    def keys(self) -> list[str]:
        return list(self._columns)

    def get(self, key: str, default: Any = None) -> Any:
        position = self._positions.get(key)
        return default if position is None else self._values[position]


def _column_names(description: Any) -> list[str]:
    names: list[str] = []
    for column in description or ():
        name = getattr(column, "name", None)
        names.append(str(name if name is not None else column[0]))
    return names


def _sqlite_row_factory(cursor: sqlite3.Cursor, values: tuple[Any, ...]) -> Row:
    return Row(_column_names(cursor.description), values)


def _adapt_params(params: Sequence[Any] | None, *, dialect: str) -> tuple[Any, ...]:
    if not params:
        return ()
    if dialect == "postgresql":
        # The portable schema stores flags in INTEGER columns, not BOOLEAN.
        return tuple(int(value) if isinstance(value, bool) else value for value in params)
    return tuple(params)


def _replace_qmark_placeholders(sql: str) -> str:
    """Replace qmark placeholders outside quoted strings with ``%s``."""

    result: list[str] = []
    in_single = False
    in_double = False
    index = 0
    while index < len(sql):
        char = sql[index]
        if char == "%":
            # psycopg performs client-side placeholder parsing even inside
            # SQL string literals, so a literal percent (for example in a
            # LIKE pattern) must be doubled.
            result.append("%%")
            index += 1
            continue
        if in_single:
            result.append(char)
            if char == "'":
                if index + 1 < len(sql) and sql[index + 1] == "'":
                    result.append(sql[index + 1])
                    index += 1
                else:
                    in_single = False
            index += 1
            continue
        if in_double:
            result.append(char)
            if char == '"':
                in_double = False
            index += 1
            continue
        if char == "'":
            in_single = True
            result.append(char)
        elif char == '"':
            in_double = True
            result.append(char)
        elif char == "?":
            result.append("%s")
        else:
            result.append(char)
        index += 1
    return "".join(result)


def _prepare_postgres_sql(sql: str) -> tuple[str, bool]:
    statement = sql.strip()
    if statement.upper().startswith("PRAGMA"):
        raise DatabaseConfigurationError("SQLite PRAGMA used with PostgreSQL")

    ignore_conflicts = False
    statement, replacements = re.subn(
        r"^\s*INSERT\s+OR\s+IGNORE\s+INTO\b",
        "INSERT INTO",
        statement,
        count=1,
        flags=re.IGNORECASE,
    )
    ignore_conflicts = bool(replacements)
    statement = re.sub(
        r"\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b",
        "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
        statement,
        flags=re.IGNORECASE,
    )
    statement = re.sub(r"\bREAL\b", "DOUBLE PRECISION", statement, flags=re.IGNORECASE)
    statement = re.sub(
        r"CAST\(\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)?value)\s+AS\s+INTEGER\s*\)\s*\+\s*1",
        r"(CAST(\1 AS INTEGER)+1)::TEXT",
        statement,
        flags=re.IGNORECASE,
    )
    statement = re.sub(r"\bLIKE\b", "ILIKE", statement, flags=re.IGNORECASE)
    statement = _replace_qmark_placeholders(statement)

    returning_id = False
    table_match = re.match(
        r"\s*INSERT\s+INTO\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?",
        statement,
        flags=re.IGNORECASE,
    )
    if table_match:
        statement = statement.rstrip().rstrip(";")
        if ignore_conflicts and "ON CONFLICT" not in statement.upper():
            statement += " ON CONFLICT DO NOTHING"
        if (
            table_match.group(1).lower() in _IDENTITY_TABLES
            and "RETURNING" not in statement.upper()
        ):
            statement += " RETURNING id"
            returning_id = True
    return statement, returning_id


def _split_sql_script(script: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    index = 0
    while index < len(script):
        char = script[index]
        current.append(char)
        if in_single:
            if char == "'":
                if index + 1 < len(script) and script[index + 1] == "'":
                    current.append(script[index + 1])
                    index += 1
                else:
                    in_single = False
        elif in_double:
            if char == '"':
                in_double = False
        elif char == "'":
            in_single = True
        elif char == '"':
            in_double = True
        elif char == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
        index += 1
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


class Cursor:
    """Small wrapper giving SQLite-like cursor behaviour on both drivers."""

    def __init__(self, raw: Any, *, dialect: str, returning_id: bool = False) -> None:
        self._raw = raw
        self._dialect = dialect
        self._returning_id = returning_id
        self._lastrowid_loaded = False
        self._lastrowid: int | None = None

    def _convert(self, row: Any) -> Row | None:
        if row is None:
            return None
        if isinstance(row, Row):
            return row
        return Row(_column_names(getattr(self._raw, "description", None)), row)

    def fetchone(self) -> Row | None:
        try:
            return self._convert(self._raw.fetchone())
        except Exception as error:
            raise DatabaseError(str(error)) from error

    def fetchall(self) -> list[Row]:
        try:
            return [row for row in (self._convert(item) for item in self._raw.fetchall()) if row is not None]
        except Exception as error:
            raise DatabaseError(str(error)) from error

    def __iter__(self) -> Iterator[Row]:
        while True:
            row = self.fetchone()
            if row is None:
                return
            yield row

    @property
    def rowcount(self) -> int:
        return int(getattr(self._raw, "rowcount", 0) or 0)

    @property
    def lastrowid(self) -> int | None:
        if self._dialect == "sqlite":
            value = getattr(self._raw, "lastrowid", None)
            return int(value) if value is not None else None
        if not self._returning_id:
            return None
        if not self._lastrowid_loaded:
            self._lastrowid_loaded = True
            row = self.fetchone()
            self._lastrowid = int(row[0]) if row is not None else None
        return self._lastrowid

    def close(self) -> None:
        _close_quietly(self._raw)


class Connection:
    """Dialect-neutral connection used by the storage/domain SQL code."""

    def __init__(
        self,
        raw: Any,
        *,
        dialect: str,
        identity: str,
        release: Callable[[Any, bool], None] | None = None,
    ) -> None:
        self._raw = raw
        self.dialect = dialect
        self.identity = identity
        self._release = release
        self._closed = False

    @property
    def raw(self) -> Any:
        return self._raw

    def _ensure_open(self) -> None:
        if self._closed:
            raise DatabaseError("Database connection is closed")

    def cursor(self) -> Cursor:
        self._ensure_open()
        try:
            return Cursor(self._raw.cursor(), dialect=self.dialect)
        except Exception as error:
            raise DatabaseError(str(error)) from error

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> Cursor:
        self._ensure_open()
        adapted = _adapt_params(params, dialect=self.dialect)
        try:
            if self.dialect == "postgresql":
                statement, returning_id = _prepare_postgres_sql(sql)
                raw_cursor = self._raw.execute(statement, adapted)
            else:
                returning_id = False
                raw_cursor = self._raw.execute(sql, adapted)
        except DatabaseError:
            raise
        except Exception as error:
            raise DatabaseError(str(error)) from error
        return Cursor(raw_cursor, dialect=self.dialect, returning_id=returning_id)

    def executemany(
        self, sql: str, params_seq: Iterable[Sequence[Any]]
    ) -> Cursor:
        self._ensure_open()
        try:
            raw_cursor = self._raw.cursor()
            if self.dialect == "postgresql":
                statement, _returning = _prepare_postgres_sql(sql)
                adapted_seq = [
                    _adapt_params(params, dialect=self.dialect) for params in params_seq
                ]
                raw_cursor.executemany(statement, adapted_seq)
            else:
                raw_cursor.executemany(sql, params_seq)
        except DatabaseError:
            raise
        except Exception as error:
            raise DatabaseError(str(error)) from error
        return Cursor(raw_cursor, dialect=self.dialect)

    def executescript(self, script: str) -> None:
        self._ensure_open()
        try:
            if self.dialect == "sqlite":
                self._raw.executescript(script)
            else:
                for statement in _split_sql_script(script):
                    self.execute(statement)
        except DatabaseError:
            raise
        except Exception as error:
            raise DatabaseError(str(error)) from error

    def commit(self) -> None:
        if self._closed:
            return
        try:
            self._raw.commit()
        except Exception as error:
            raise DatabaseError(str(error)) from error

    def rollback(self) -> None:
        if self._closed:
            return
        try:
            self._raw.rollback()
        except Exception as error:
            raise DatabaseError(str(error)) from error

    def _finalize(self, *, healthy: bool = True) -> None:
        if self._closed:
            return
        self._closed = True
        if self._release is not None:
            self._release(self._raw, healthy=healthy)
            return
        _close_quietly(self._raw)

    def close(self) -> None:
        self._finalize(healthy=True)


@dataclass(frozen=True)
class _DatabaseTarget:
    dialect: str
    target: str
    identity: str


def _sqlite_target_from_url(url: str) -> str:
    if url in {"sqlite:///:memory:", "sqlite://:memory:"}:
        return ":memory:"
    prefix = "sqlite://"
    rest = url.removeprefix(prefix)
    if rest.startswith("//"):
        return unquote(rest[1:])
    if rest.startswith("/"):
        return unquote(rest[1:])
    parsed = urlparse(url)
    if parsed.netloc:
        return unquote(f"{parsed.netloc}{parsed.path}")
    return unquote(rest)


def _database_target() -> _DatabaseTarget:
    url = DATABASE_URL.strip()
    if not url:
        target = str(DATABASE_PATH)
        return _DatabaseTarget("sqlite", target, f"sqlite:{target}")
    lowered = url.lower()
    if lowered.startswith("sqlite://"):
        target = _sqlite_target_from_url(url)
        return _DatabaseTarget("sqlite", target, f"sqlite:{target}")
    if lowered.startswith(("postgresql://", "postgres://")):
        parsed = urlparse(url)
        user = unquote(parsed.username or "")
        host = parsed.hostname or ""
        if not host:
            # libpq also accepts the Unix-socket directory as ?host=/path.
            host = parse_qs(parsed.query).get("host", [""])[0]
        try:
            port_value = parsed.port
        except ValueError as error:
            raise DatabaseConfigurationError(
                "DATABASE_URL contains an invalid PostgreSQL port"
            ) from error
        port = f":{port_value}" if port_value else ""
        # The readable part helps debugging; the short fingerprint keeps
        # schema-cache identities distinct for URLs that differ only in
        # query options (socket directory, search_path, TLS mode, ...),
        # without retaining the password in the identity string.
        fingerprint = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
        identity = (
            f"postgresql://{user}@{host}{port}{parsed.path or ''}#{fingerprint}"
        )
        return _DatabaseTarget("postgresql", url, identity)
    raise DatabaseConfigurationError(
        "DATABASE_URL must start with sqlite://, postgresql:// or postgres://"
    )


def database_dialect() -> str:
    return _database_target().dialect


def database_identity() -> str:
    return _database_target().identity


# Registered preview users work in isolated SQLite workspace files.
# Authentication resolves the session's workspace once per request and
# publishes it through this context variable; every ordinary ``db()``
# call in that request (including ``asyncio.to_thread`` workers, which
# inherit the context) then transparently uses the user's workspace.
# Registry/authentication queries explicitly opt out with
# ``ignore_active=True`` so sessions and accounts always live in the
# configured main database.
_ACTIVE_TARGET: ContextVar[_DatabaseTarget | None] = ContextVar(
    "kontur_active_database_target", default=None
)


def sqlite_database_target(path: Path | str) -> _DatabaseTarget:
    target = str(Path(path).expanduser())
    return _DatabaseTarget("sqlite", target, f"sqlite:{target}")


def active_database_target() -> _DatabaseTarget:
    return _ACTIVE_TARGET.get() or _database_target()


def active_database_identity() -> str:
    return active_database_target().identity


def set_active_database_target(
    target: _DatabaseTarget | None,
) -> Token[_DatabaseTarget | None]:
    return _ACTIVE_TARGET.set(target)


def reset_active_database_target(token: Token[_DatabaseTarget | None]) -> None:
    _ACTIVE_TARGET.reset(token)


@contextmanager
def use_database_target(
    target: _DatabaseTarget | None,
) -> Iterator[_DatabaseTarget]:
    token = set_active_database_target(target)
    try:
        yield active_database_target()
    finally:
        reset_active_database_target(token)


@contextmanager
def use_sqlite_database(path: Path | str) -> Iterator[_DatabaseTarget]:
    with use_database_target(sqlite_database_target(path)) as target:
        yield target


_SQLITE_MEMORY_URI = "file:kontur-memory?mode=memory&cache=shared"
_SQLITE_MEMORY_ANCHOR: sqlite3.Connection | None = None
_SQLITE_MEMORY_LOCK = threading.Lock()


def _ensure_sqlite_memory_anchor() -> None:
    """Keep one shared in-memory SQLite database alive for the process.

    The application intentionally uses short-lived connections, so a
    plain ``:memory:`` target would give every ``db()`` block a different
    empty database.  A shared-cache URI plus this anchor makes the
    explicit in-memory configuration behave like one ephemeral database.
    """

    global _SQLITE_MEMORY_ANCHOR
    with _SQLITE_MEMORY_LOCK:
        if _SQLITE_MEMORY_ANCHOR is None:
            try:
                _SQLITE_MEMORY_ANCHOR = sqlite3.connect(
                    _SQLITE_MEMORY_URI, uri=True, check_same_thread=False
                )
            except Exception as error:
                raise DatabaseError(str(error)) from error


def _connect_sqlite(target: str) -> sqlite3.Connection:
    if target != ":memory:" and not target.startswith("file:"):
        Path(target).expanduser().parent.mkdir(parents=True, exist_ok=True)
    journal_mode = SQLITE_JOURNAL_MODE
    synchronous = SQLITE_SYNCHRONOUS
    if journal_mode not in _SQLITE_JOURNAL_MODES:
        raise DatabaseConfigurationError(
            f"Unsupported SQLITE_JOURNAL_MODE: {journal_mode}"
        )
    if synchronous not in _SQLITE_SYNCHRONOUS_MODES:
        raise DatabaseConfigurationError(
            f"Unsupported SQLITE_SYNCHRONOUS: {synchronous}"
        )
    effective_target = target
    if target == ":memory:":
        _ensure_sqlite_memory_anchor()
        effective_target = _SQLITE_MEMORY_URI
    try:
        raw = sqlite3.connect(
            effective_target,
            timeout=max(0.1, SQLITE_BUSY_TIMEOUT_MS / 1000),
            uri=effective_target.startswith("file:"),
        )
        raw.row_factory = _sqlite_row_factory
        raw.execute("PRAGMA foreign_keys = ON")
        raw.execute(f"PRAGMA busy_timeout = {int(SQLITE_BUSY_TIMEOUT_MS)}")
        raw.execute(f"PRAGMA journal_mode = {journal_mode}")
        raw.execute(f"PRAGMA synchronous = {synchronous}")
        raw.execute("PRAGMA temp_store = MEMORY")
        raw.execute(f"PRAGMA cache_size = {-abs(int(SQLITE_CACHE_SIZE_KIB))}")
        if journal_mode == "WAL":
            raw.execute("PRAGMA wal_autocheckpoint = 1000")
    except DatabaseConfigurationError:
        raise
    except Exception as error:
        raise DatabaseError(str(error)) from error
    return raw


def _connect_postgres(url: str) -> Any:
    try:
        import psycopg
    except ImportError as error:
        raise DatabaseConfigurationError(
            "PostgreSQL DATABASE_URL requires the psycopg package"
        ) from error
    try:
        return psycopg.connect(
            url,
            autocommit=False,
            connect_timeout=max(1, int(DATABASE_CONNECT_TIMEOUT_SECONDS)),
            application_name="kontur",
        )
    except Exception as error:
        raise DatabaseError(str(error)) from error


class _PostgresPool:
    def __init__(self, url: str, *, max_size: int) -> None:
        self._url = url
        self._idle: queue.LifoQueue[Any] = queue.LifoQueue()
        self._slots = threading.BoundedSemaphore(max(1, max_size))
        self._closed = False

    def acquire(self) -> Any:
        self._slots.acquire()
        try:
            if self._closed:
                raise DatabaseError("PostgreSQL connection pool is closed")
            try:
                raw = self._idle.get_nowait()
            except queue.Empty:
                raw = _connect_postgres(self._url)
            if getattr(raw, "closed", False):
                raw = _connect_postgres(self._url)
            return raw
        except BaseException:
            self._slots.release()
            raise

    def release(self, raw: Any, *, healthy: bool) -> None:
        try:
            if self._closed or not healthy or getattr(raw, "closed", False):
                _close_quietly(raw)
            else:
                self._idle.put(raw)
        finally:
            self._slots.release()

    def close(self) -> None:
        self._closed = True
        while True:
            try:
                raw = self._idle.get_nowait()
            except queue.Empty:
                return
            _close_quietly(raw)


_POSTGRES_POOLS: dict[tuple[str, int], _PostgresPool] = {}
_POSTGRES_POOLS_LOCK = threading.Lock()


def _postgres_pool(url: str) -> _PostgresPool:
    key = (url, DATABASE_POOL_MAX)
    with _POSTGRES_POOLS_LOCK:
        pool = _POSTGRES_POOLS.get(key)
        if pool is None:
            pool = _PostgresPool(url, max_size=DATABASE_POOL_MAX)
            _POSTGRES_POOLS[key] = pool
        return pool


@contextmanager
def database_connection(
    *,
    target: _DatabaseTarget | None = None,
    ignore_active: bool = False,
) -> Iterator[Connection]:
    """Open a short-lived transaction and always release its connection.

    With no arguments this uses the request's active workspace target
    when one is set (registered preview users), otherwise the
    configured main database.  ``ignore_active=True`` always selects
    the configured main/registry database.
    """

    if target is not None:
        chosen = target
    elif ignore_active:
        chosen = _database_target()
    else:
        chosen = active_database_target()
    target = chosen
    release = None
    if target.dialect == "sqlite":
        raw: Any = _connect_sqlite(target.target)
    else:
        pool = _postgres_pool(target.target)
        raw = pool.acquire()
        release = pool.release

    connection = Connection(
        raw,
        dialect=target.dialect,
        identity=target.identity,
        release=release,
    )
    healthy = True
    try:
        yield connection
        connection.commit()
    except BaseException:
        try:
            connection.rollback()
        except DatabaseError:
            healthy = False
        raise
    finally:
        connection._finalize(healthy=healthy)


_SCHEMA_READY: set[tuple[str, str]] = set()
_SCHEMA_READY_LOCK = threading.Lock()


def acquire_schema_lock(connection: Connection) -> None:
    """Serialize first-time DDL across PostgreSQL app replicas.

    ``CREATE ... IF NOT EXISTS`` is not a concurrency protocol: two
    replicas starting against an empty database can still race in the
    system catalogs.  A transaction-scoped advisory lock makes the
    second initializer wait and then observe the committed schema.
    SQLite deployments are single-host and rely on the database writer
    lock instead.
    """

    if connection.dialect == "postgresql":
        connection.execute(
            "SELECT pg_advisory_xact_lock(hashtext('kontur-schema-v1'))"
        ).fetchone()


def schema_is_ready(connection: Connection, name: str) -> bool:
    with _SCHEMA_READY_LOCK:
        return (connection.identity, name) in _SCHEMA_READY


def mark_schema_ready(connection: Connection, name: str) -> None:
    with _SCHEMA_READY_LOCK:
        _SCHEMA_READY.add((connection.identity, name))


def reset_schema_ready_cache() -> None:
    with _SCHEMA_READY_LOCK:
        _SCHEMA_READY.clear()


def checkpoint_database() -> None:
    """Best-effort SQLite WAL checkpoint; a no-op for PostgreSQL."""

    if database_dialect() != "sqlite":
        return
    with database_connection(ignore_active=True) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()


def close_database_pools() -> None:
    with _POSTGRES_POOLS_LOCK:
        pools = list(_POSTGRES_POOLS.values())
        _POSTGRES_POOLS.clear()
    for pool in pools:
        pool.close()
    reset_schema_ready_cache()


def database_healthcheck() -> None:
    with database_connection(ignore_active=True) as connection:
        connection.execute("SELECT 1").fetchone()


def configured_database_label() -> str:
    target = _database_target()
    return "PostgreSQL" if target.dialect == "postgresql" else "SQLite"


def database_url_from_env() -> str:
    return os.getenv("DATABASE_URL", DATABASE_URL).strip()
