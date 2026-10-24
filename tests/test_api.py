import hashlib
import unittest
from pathlib import Path

import yaml
from fastapi.testclient import TestClient

from churnrisk.api import app
from churnrisk.storage import db, replace_snapshot

SNAPSHOT = {
    "accounts": [
        {"id": 10, "email": "low@example.org", "balance": 0, "totalReplenished": 2000},
        {"id": 20, "email": "high@example.org", "balance": 0, "totalReplenished": 3000},
        {"id": 30, "email": "unrated@example.org", "balance": 100},
    ],
    "services": [
        {
            "id": "s-10",
            "accountId": 10,
            "name": "Monthly",
            "status": "active",
            "price": 100,
            "paymentTerm": "month",
            "autoprolong": True,
        },
        {
            "id": "s-20",
            "accountId": 20,
            "name": "Expiring",
            "status": "active",
            "price": 9000,
            "paymentTerm": "month",
            "autoprolong": False,
            "expiresAt": "2026-10-24T00:00:00Z",
        },
    ],
    "transactions": [],
}


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()
        response = cls.client.post(
            "/api/v1/auth/login",
            json={"username": "test-admin", "password": "test-only-password-2026"},
        )
        if response.status_code != 200:
            raise AssertionError(
                f"test login failed: {response.status_code} {response.text}"
            )

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)

    def setUp(self):
        self.client.post(
            "/api/v1/auth/login",
            json={"username": "test-admin", "password": "test-only-password-2026"},
        )
        with db() as connection:
            replace_snapshot(connection, SNAPSHOT)

    def test_authentication_and_private_endpoints(self):
        anonymous = TestClient(app)
        self.assertEqual(anonymous.get("/", follow_redirects=False).status_code, 303)
        self.assertEqual(anonymous.get("/login").status_code, 200)
        self.assertEqual(anonymous.get("/api/v1/customers").status_code, 401)
        self.assertEqual(anonymous.get("/api/v1/model/settings").status_code, 401)
        self.assertTrue(self.client.cookies.get("churn_session"))

    def test_customer_sort_filter_and_data_minimization(self):
        response = self.client.get("/api/v1/customers?sort=id&order=asc")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([row["id"] for row in payload["items"]], ["10", "20", "30"])
        self.assertTrue(
            all(
                "account" not in row and "password" not in row
                for row in payload["items"]
            )
        )
        self.assertEqual(
            self.client.get("/api/v1/customers?risk=unrated").json()["total"], 1
        )
        self.assertEqual(
            self.client.get("/api/v1/customers?risk=bogus").status_code, 422
        )
        page = self.client.get(
            "/api/v1/customers?sort=id&order=asc&limit=1&offset=1"
        ).json()
        self.assertEqual(page["items"][0]["id"], "20")
        self.assertEqual(page["total"], 3)

    def test_weight_change_is_persisted_and_metrics_match_summary(self):
        response = self.client.patch(
            "/api/v1/model/settings", json={"weights": {"prolong_wait": 40}}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["weights"]["prolong_wait"], 40)
        self.assertEqual(
            self.client.get("/api/v1/model/settings").json()["weights"]["prolong_wait"],
            40,
        )
        self.assertEqual(
            self.client.patch(
                "/api/v1/model/settings", json={"weights": {"unknown": 3}}
            ).status_code,
            422,
        )
        summary = self.client.get("/api/v1/analytics/summary").json()
        metrics = self.client.get("/metrics").text
        self.assertIn(
            f'churn_customers_total{{risk="high"}} {summary["highRisk"]}', metrics
        )
        self.assertIn(
            f"churn_estimated_loss_eur {summary['estimatedLoss'] / 100:.2f}", metrics
        )

    def test_nested_snapshot_import_and_unknown_shape_preserves_data(self):
        response = self.client.put("/api/v1/source/snapshot", json={
            "snapshot": {"clients": [{
                "id": 42, "email_address": "nested@example.org", "balance": 0,
                "subscriptions": [{"status": "active", "price": 250, "payment_term": "month"}],
            }]},
        })
        self.assertEqual(response.status_code, 200, response.text)
        customers = self.client.get("/api/v1/customers").json()
        self.assertEqual(customers["total"], 1)
        self.assertEqual(customers["items"][0]["monthlyRevenue"], 250)
        for invalid in ({"records": []}, {"accounts": [], "users": []}):
            with self.subTest(invalid=invalid):
                response = self.client.put("/api/v1/source/snapshot", json=invalid)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.client.get("/api/v1/customers").json()["total"], 1)

    def test_invalid_snapshot_does_not_delete_current_data(self):
        response = self.client.put(
            "/api/v1/source/snapshot",
            json={
                "accounts": [{"id": 1, "email": "client@example.org"}],
                "services": [
                    {
                        "id": "bad",
                        "accountId": 2,
                        "status": "active",
                        "price": 100,
                        "paymentTerm": "month",
                    }
                ],
                "transactions": [],
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get("/api/v1/customers").json()["total"], 3)

    def test_security_headers_health_and_logout(self):
        response = self.client.get("/health")
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertIn("content-security-policy", response.headers)
        self.assertEqual(
            self.client.get("/api/v1/customers").headers["cache-control"], "no-store"
        )
        self.assertEqual(self.client.post("/api/v1/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/v1/auth/me").status_code, 401)

    def test_checked_in_openapi_matches_the_live_route_contract(self):
        generated = self.client.get("/api/v1/openapi.json").json()
        checked_in = yaml.safe_load(Path("openapi.yaml").read_text(encoding="utf-8"))
        self.assertEqual(set(checked_in["paths"]), set(generated["paths"]))
        self.assertIn("AdminSession", generated["components"]["securitySchemes"])
        self.assertEqual(
            checked_in["paths"]["/api/v1/customers"]["get"]["security"],
            generated["paths"]["/api/v1/customers"]["get"]["security"],
        )

    def test_swagger_ui_assets_are_self_hosted(self):
        response = self.client.get("/api/v1/docs")
        self.assertEqual(response.status_code, 200)
        self.assertIn("/static/vendor/swagger-ui/swagger-ui-bundle.js", response.text)
        self.assertNotIn("cdn.jsdelivr.net", response.text)

    def test_login_rate_limit_and_snapshot_body_limit(self):
        test_ip = "198.51.100.42"
        with TestClient(app, client=(test_ip, 12345)) as client:
            for _ in range(8):
                response = client.post(
                    "/api/v1/auth/login",
                    json={"username": "test-admin", "password": "wrong"},
                )
                self.assertEqual(response.status_code, 401)
            limited = client.post(
                "/api/v1/auth/login",
                json={"username": "test-admin", "password": "wrong"},
            )
            self.assertEqual(limited.status_code, 429)
            self.assertIn("retry-after", limited.headers)
            oversized = client.put(
                "/api/v1/source/snapshot",
                headers={"Content-Length": str(32 * 1024 * 1024 + 1)},
            )
            self.assertEqual(oversized.status_code, 413)
        rate_key = hashlib.sha256(test_ip.encode("utf-8")).hexdigest()
        with db() as connection:
            connection.execute("DELETE FROM login_attempts WHERE key=?", (rate_key,))


if __name__ == "__main__":
    unittest.main()
