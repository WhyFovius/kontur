import unittest

from churnrisk.domain import analyze, payment_period
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
