from __future__ import annotations

import json
import sqlite3
import unittest
from unittest.mock import patch

from churnrisk import database
from churnrisk.database import (
    Connection,
    DatabaseConfigurationError,
    _connect_sqlite,
    _database_target,
    _prepare_postgres_sql,
    _split_sql_script,
    _sqlite_row_factory,
    _sqlite_target_from_url,
)
from churnrisk.storage import (
    _ensure_snapshot_fact_columns,
    load_account,
    load_prepared_source,
)


class DatabaseTranslationTests(unittest.TestCase):
    def test_postgres_placeholders_and_literal_percent(self) -> None:
        statement, returning = _prepare_postgres_sql(
            "SELECT * FROM realtime_events "
            "WHERE customer_email LIKE ? AND episode_key LIKE 'realtime:%' "
            "AND note='what?'"
        )
        self.assertFalse(returning)
        self.assertIn("customer_email ILIKE %s", statement)
        self.assertIn("'realtime:%%'", statement)
        self.assertIn("'what?'", statement)

    def test_postgres_insert_ignore_identity_and_metadata_increment(self) -> None:
        statement, returning = _prepare_postgres_sql(
            "INSERT OR IGNORE INTO risk_events (episode_key) VALUES (?)"
        )
        self.assertTrue(returning)
        self.assertTrue(statement.endswith("ON CONFLICT DO NOTHING RETURNING id"))

        statement, returning = _prepare_postgres_sql(
            "INSERT INTO metadata (key, value) VALUES ('model_version', '1') "
            "ON CONFLICT(key) DO UPDATE SET value=CAST(metadata.value AS INTEGER)+1"
        )
        self.assertFalse(returning)
        self.assertIn("(CAST(metadata.value AS INTEGER)+1)::TEXT", statement)

    def test_sqlite_url_and_script_splitting(self) -> None:
        self.assertEqual(_sqlite_target_from_url("sqlite:///:memory:"), ":memory:")
        self.assertEqual(_sqlite_target_from_url("sqlite:///data/app.db"), "data/app.db")
        self.assertEqual(
            _sqlite_target_from_url("sqlite:////var/lib/app.db"), "/var/lib/app.db"
        )
        self.assertEqual(
            _split_sql_script("CREATE TABLE x (a TEXT DEFAULT ';'); SELECT 'a;''b';"),
            ["CREATE TABLE x (a TEXT DEFAULT ';');", "SELECT 'a;''b';"],
        )

    def test_postgres_socket_identity_and_invalid_port(self) -> None:
        with patch.object(
            database,
            "DATABASE_URL",
            "postgresql://postgres@/postgres?host=/tmp/kontur-socket",
        ):
            target = _database_target()
        self.assertIn("@/tmp/kontur-socket/postgres#", target.identity)

        with (
            patch.object(
                database,
                "DATABASE_URL",
                "postgresql://postgres@db:not-a-port/postgres",
            ),
            self.assertRaises(DatabaseConfigurationError),
        ):
            _database_target()

    def test_memory_sqlite_is_shared_between_short_lived_connections(self) -> None:
        first = _connect_sqlite(":memory:")
        second = _connect_sqlite(":memory:")
        try:
            first.execute("CREATE TABLE shared_memory_probe (value INTEGER)")
            first.execute("INSERT INTO shared_memory_probe (value) VALUES (42)")
            first.commit()
            row = second.execute(
                "SELECT value FROM shared_memory_probe"
            ).fetchone()
            self.assertEqual(row[0], 42)
            second.execute("DROP TABLE shared_memory_probe")
            second.commit()
        finally:
            first.close()
            second.close()


class PreparedStorageTests(unittest.TestCase):
    def test_legacy_json_snapshot_is_migrated_to_typed_facts(self) -> None:
        raw = sqlite3.connect(":memory:")
        raw.row_factory = _sqlite_row_factory
        connection = Connection(raw, dialect="sqlite", identity="sqlite:test")
        try:
            connection.executescript(
                """
                CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE services (
                    id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE transactions (
                    id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                """
            )
            account = {"id": "a1", "email": "a@example.test", "balance": 0}
            service = {
                "id": "s1",
                "accountId": "a1",
                "status": "active",
                "price": 1200,
                "paymentTerm": "year",
                "autoprolong": True,
                "expiresAt": "2030-01-01T00:00:00Z",
            }
            transaction = {
                "id": "t1",
                "accountId": "a1",
                "status": "not_performed",
                "type": "prolong",
                "amount": 1200,
            }
            connection.execute(
                "INSERT INTO accounts (id, data) VALUES (?, ?)",
                ("a1", json.dumps(account)),
            )
            connection.execute(
                "INSERT INTO services (id, account_id, data) VALUES (?, ?, ?)",
                ("s1", "a1", json.dumps(service)),
            )
            connection.execute(
                "INSERT INTO transactions (id, account_id, data) VALUES (?, ?, ?)",
                ("t1", "a1", json.dumps(transaction)),
            )

            _ensure_snapshot_fact_columns(connection)
            accounts, services_by_account, transactions_by_account = (
                load_prepared_source(connection)
            )

            self.assertEqual(accounts, [account])
            self.assertEqual(load_account(connection, "a1"), account)
            raw_services, facts = services_by_account["a1"]
            self.assertEqual(raw_services, [service])
            self.assertEqual(len(facts), 1)
            self.assertEqual(facts[0].status, "active")
            self.assertEqual(facts[0].monthly_revenue, 100)
            self.assertTrue(facts[0].autoprolong)
            self.assertEqual(transactions_by_account["a1"].total, 1)
            self.assertTrue(transactions_by_account["a1"].has_failed)

            typed = connection.execute(
                "SELECT status, price_cents FROM services WHERE id='s1'"
            ).fetchone()
            self.assertEqual((typed["status"], typed["price_cents"]), ("active", 1200))
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
