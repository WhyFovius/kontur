import unittest
from datetime import timedelta

from churnrisk.domain import (
    alert_candidates,
    analyze,
    iso,
    payment_period,
    rescue_queue,
    utcnow,
)
from churnrisk.storage import SnapshotValidationError, validate_snapshot


class DomainTests(unittest.TestCase):
    def test_payment_periods_are_normalized_to_month(self):
        self.assertAlmostEqual(payment_period("hour"), 730.5)
        self.assertAlmostEqual(payment_period("week"), 365.25 / 7 / 12)
        self.assertEqual(payment_period("month"), 1)
        self.assertAlmostEqual(payment_period("year"), 1 / 12)

    def test_account_without_services_and_transactions_is_unrated(self):
        result = analyze(
            {
                "accounts": [{"id": 1, "email": "a@example.org"}],
                "services": [],
                "transactions": [],
            },
            {},
        )[0]
        self.assertIsNone(result["score"])
        self.assertEqual(result["riskLevel"], "unrated")

    def test_suspended_service_is_billable_and_bonus_balance_is_conditional(self):
        source = {
            "accounts": [
                {
                    "id": 1,
                    "email": "a@example.org",
                    "balance": 100,
                    "bonusBalance": 50,
                    "bonusState": True,
                }
            ],
            "services": [
                {
                    "id": "s1",
                    "accountId": "1",
                    "status": "suspended",
                    "price": 1000,
                    "paymentTerm": "month",
                }
            ],
            "transactions": [],
        }
        result = analyze(source, {})[0]
        self.assertEqual(result["availableBalance"], 150)
        self.assertEqual(result["monthlyRevenue"], 1000)

    def test_hourly_service_monthly_revenue_uses_correct_period(self):
        source = {
            "accounts": [{"id": 1, "email": "a@example.org", "balance": 0}],
            "services": [
                {
                    "id": "s1",
                    "accountId": 1,
                    "status": "active",
                    "price": 100,
                    "paymentTerm": "hour",
                }
            ],
            "transactions": [],
        }
        self.assertEqual(analyze(source, {})[0]["monthlyRevenue"], 73050)

    def test_rescue_queue_and_alert_candidates_are_actionable(self):
        now = utcnow()
        source = {
            "accounts": [
                {
                    "id": 77,
                    "email": "rescue@example.org",
                    "balance": 1000,
                    "totalReplenished": 12000,
                }
            ],
            "services": [
                {
                    "id": "svc-rescue",
                    "accountId": 77,
                    "name": "Critical VPS",
                    "status": "active",
                    "price": 9000,
                    "paymentTerm": "month",
                    "autoprolong": False,
                    "expiresAt": iso(now + timedelta(days=2)),
                }
            ],
            "transactions": [
                {
                    "id": "pay-rescue",
                    "accountId": 77,
                    "status": "not_performed",
                    "type": "prolong",
                    "amount": 9000,
                }
            ],
        }
        customers = analyze(source, {})
        queue = rescue_queue(customers, now=now)
        self.assertEqual(queue["totals"]["eligibleCustomers"], 1)
        item = queue["items"][0]
        self.assertEqual(item["actionType"], "top_up")
        self.assertEqual(item["requiredTopUp"], 8000)
        self.assertEqual(item["predictedScoreAfterAction"], 42)
        self.assertGreaterEqual(item["priorityIndex"], 80)
        self.assertLessEqual(item["rescueValue"], item["estimatedLoss"])

        types = {candidate["type"] for candidate in alert_candidates(customers, now)}
        self.assertIn("expiry_72h", types)
        self.assertIn("insufficient_funds", types)

    def test_snapshot_accepts_export_boolean_spellings(self):
        snapshot = {
            "accounts": [
                {"id": 1, "email": "active@example.org", "bonusState": "active"},
                {"id": 2, "email": "off@example.org", "bonusState": "off"},
                {"id": 3, "email": "numeric@example.org", "bonusStatus": 1},
                {
                    "id": 4,
                    "email": "object@example.org",
                    "bonusState": {"enabled": "yes"},
                },
                {
                    "id": 5,
                    "email": "mongo@example.org",
                    "bonusState": {"$numberInt": "1"},
                },
                {"id": 6, "email": "ru@example.org", "bonusState": "Подключена"},
                {"id": 7, "email": "negated@example.org", "bonusState": "не активна"},
                {"id": 8, "email": "float@example.org", "bonusState": "1.0"},
                {"id": 9, "email": "two@example.org", "bonusState": 2},
                {
                    "id": 10,
                    "email": "unknown@example.org",
                    "bonusState": "совершенно неизвестный статус",
                },
                {"id": 11, "email": "empty@example.org", "bonusState": []},
                {
                    "id": 12,
                    "email": "mongolong@example.org",
                    "bonusState": {"$numberLong": "0"},
                },
            ],
            "services": [
                {
                    "id": "s1",
                    "accountId": 1,
                    "status": "active",
                    "price": 100,
                    "paymentTerm": "month",
                    "autoprolong": "on",
                },
                {
                    "id": "s2",
                    "accountId": 2,
                    "status": "active",
                    "price": 100,
                    "paymentTerm": "month",
                    "autoprolong": "manual",
                },
            ],
            "transactions": [],
        }
        normalized = validate_snapshot(snapshot)
        self.assertEqual(
            [row["bonusState"] for row in normalized["accounts"]],
            [True, False, True, True, True, True, False, True, True, False, False, False],
        )
        self.assertIs(normalized["services"][0]["autoprolong"], True)
        self.assertIs(normalized["services"][1]["autoprolong"], False)

    def test_snapshot_accepts_service_linked_export_shape(self):
        snapshot = {
            "accounts": [
                {
                    "id": 1,
                    "email": "locked@example.org",
                    "balance": 10,
                    "bonusBalance": 500,
                    "bonusState": "locked",
                },
                {
                    "id": 2,
                    "email": "unlocked@example.org",
                    "balance": 20,
                    "bonusBalance": 500,
                    "bonusState": "unlocked",
                },
            ],
            "services": [
                {
                    "id": "s1",
                    "ownerId": 1,
                    "status": "active",
                    "price": 100,
                    "paymentTerm": "month",
                    "autoProlong": True,
                },
                {
                    "id": "s2",
                    "owner_id": 2,
                    "status": "active",
                    "price": 200,
                    "paymentTerm": "month",
                    "autoProlong": False,
                },
            ],
            "transactions": [
                {
                    "id": "p1",
                    "serviceId": "s2",
                    "status": "not_performed",
                    "type": "prolong",
                    "amount": 200,
                },
                {
                    "id": "p2",
                    "service_id": "s1",
                    "status": "performed",
                    "type": "order",
                    "amount": 100,
                },
            ],
        }
        normalized = validate_snapshot(snapshot)
        self.assertEqual(
            [row["bonusState"] for row in normalized["accounts"]],
            [False, True],
        )
        self.assertEqual(
            [row["accountId"] for row in normalized["services"]],
            ["1", "2"],
        )
        self.assertEqual(
            [row["autoprolong"] for row in normalized["services"]],
            [True, False],
        )
        self.assertTrue(
            all(
                "ownerId" not in row and "autoProlong" not in row
                for row in normalized["services"]
            )
        )
        self.assertEqual(
            [row["accountId"] for row in normalized["transactions"]],
            ["2", "1"],
        )
        self.assertEqual(
            [row["serviceId"] for row in normalized["transactions"]],
            ["s2", "s1"],
        )

        base = {
            "accounts": [
                {"id": 1, "email": "one@example.org"},
                {"id": 2, "email": "two@example.org"},
            ],
            "services": [
                {
                    "id": "s2",
                    "ownerId": 2,
                    "status": "active",
                    "price": 100,
                    "paymentTerm": "month",
                }
            ],
        }
        for transaction in (
            {
                "id": "missing-service",
                "serviceId": "missing",
                "status": "performed",
                "type": "order",
                "amount": 100,
            },
            {
                "id": "wrong-owner",
                "accountId": 1,
                "serviceId": "s2",
                "status": "performed",
                "type": "order",
                "amount": 100,
            },
        ):
            with (
                self.subTest(transaction=transaction),
                self.assertRaises(SnapshotValidationError),
            ):
                validate_snapshot({**base, "transactions": [transaction]})

    def test_invalid_relationship_rejects_whole_snapshot(self):
        with self.assertRaises(SnapshotValidationError):
            validate_snapshot(
                {
                    "accounts": [{"id": 1, "email": "a@example.org"}],
                    "services": [
                        {
                            "id": "s1",
                            "accountId": 999,
                            "status": "active",
                            "price": 100,
                            "paymentTerm": "month",
                        }
                    ],
                    "transactions": [],
                }
            )

    def test_nested_snapshot_matches_flat_snapshot(self):
        nested = {"data": {"customers": [{
            "_id": {"$oid": "customer-1"},
            "email_address": "a@example.org",
            "bonus_balance": 50,
            "subscriptions": [{"id": "s1", "status": "active", "price": 100,
                               "billing_period": "month", "auto_renew": True}],
            "payments": [{"id": "p1", "status": "performed", "type": "order", "amount": 100}],
        }]}}
        expected = {"accounts": [{"id": "customer-1", "email": "a@example.org", "bonusBalance": 50}],
                    "services": [{"id": "s1", "accountId": "customer-1", "status": "active",
                                  "price": 100, "paymentTerm": "month", "autoprolong": True}],
                    "transactions": [{"id": "p1", "accountId": "customer-1", "status": "performed",
                                      "type": "order", "amount": 100}]}
        self.assertEqual(validate_snapshot(nested), validate_snapshot(expected))
        from churnrisk.schemas import SnapshotRequest
        self.assertEqual(validate_snapshot(SnapshotRequest.model_validate(nested).model_dump()),
                         validate_snapshot(expected))

    def test_ambiguous_or_unknown_snapshot_is_rejected(self):
        for snapshot in (
            {}, {"records": []}, {"accounts": [], "users": []},
            {"data": {"accounts": []}, "accounts": []},
            {"accounts": [{"id": 1, "_id": 2}]},
            {"accounts": [{"id": 1, "services": [{"accountId": 2}]}]},
        ):
            with self.subTest(snapshot=snapshot), self.assertRaises(SnapshotValidationError):
                validate_snapshot(snapshot)

    def test_nested_records_obey_combined_limit(self):
        from unittest.mock import patch
        snapshot = {"accounts": [{"id": 1, "services": [{"id": "nested", "status": "active"}]}],
                    "services": [{"id": "flat", "accountId": 1, "status": "active"}]}
        with (
            patch("churnrisk.storage.MAX_SERVICES", 1),
            self.assertRaises(SnapshotValidationError),
        ):
            validate_snapshot(snapshot)

    def test_invalid_amounts_and_duplicate_ids_are_rejected(self):
        for snapshot in (
            {"accounts": [{"id": 1, "balance": float("nan")}]},
            {"accounts": [{"id": 1}, {"id": "1"}]},
        ):
            with (
                self.subTest(snapshot=snapshot),
                self.assertRaises(SnapshotValidationError),
            ):
                validate_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()
