import hashlib
import time
import unittest
from datetime import timedelta
from pathlib import Path

import yaml
from fastapi.testclient import TestClient

from churnrisk.api import app
from churnrisk.domain import iso, utcnow
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

    def test_realtime_notifications_and_rescue_queue(self):
        self.client.patch(
            "/api/v1/model/settings",
            json={
                "weights": {
                    "expiring_without_autoprolong": 25,
                    "insufficient_funds": 25,
                    "prolong_wait": 25,
                    "failed_transactions": 12,
                    "deleted_services": 8,
                    "balance_pressure": 5,
                }
            },
        )
        now = utcnow()
        snapshot = {
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
        with db() as connection:
            connection.execute("DELETE FROM risk_events")
            connection.execute("DELETE FROM risk_monitor_state")
            replace_snapshot(connection, snapshot)

        queue = self.client.get("/api/v1/analytics/rescue-queue")
        self.assertEqual(queue.status_code, 200, queue.text)
        queue_payload = queue.json()
        self.assertEqual(queue_payload["items"][0]["customerId"], "77")
        self.assertEqual(queue_payload["items"][0]["requiredTopUp"], 8000)

        notifications = self.client.get("/api/v1/notifications?limit=20")
        self.assertEqual(notifications.status_code, 200, notifications.text)
        payload = notifications.json()
        self.assertGreater(payload["unreadCount"], 0)
        self.assertTrue(
            any(item["customerId"] == "77" for item in payload["items"])
        )
        first = payload["items"][0]
        read = self.client.post(f"/api/v1/notifications/{first['id']}/read")
        self.assertEqual(read.status_code, 200, read.text)
        self.assertTrue(read.json()["notification"]["isRead"])

        read_folder = self.client.get(
            "/api/v1/notifications?limit=20&read_only=true"
        )
        self.assertEqual(read_folder.status_code, 200, read_folder.text)
        read_payload = read_folder.json()
        self.assertEqual(read_payload["readCount"], 1)
        self.assertEqual(
            [item["id"] for item in read_payload["items"]], [first["id"]]
        )
        unread = self.client.post(
            f"/api/v1/notifications/{first['id']}/unread"
        )
        self.assertEqual(unread.status_code, 200, unread.text)
        self.assertFalse(unread.json()["notification"]["isRead"])

        with self.client.stream("GET", "/api/v1/events/stream") as stream:
            self.assertEqual(stream.status_code, 200)
            self.assertTrue(
                stream.headers["content-type"].startswith("text/event-stream")
            )
            lines = []
            for line in stream.iter_lines():
                if line:
                    lines.append(line)
                if len(lines) >= 2:
                    break
            self.assertTrue(any("snapshot" in line for line in lines))

        anonymous = TestClient(app)
        self.assertEqual(anonymous.get("/api/v1/notifications").status_code, 401)
        self.assertEqual(
            anonymous.get("/api/v1/analytics/rescue-queue").status_code, 401
        )

    def test_demo_realtime_pipeline_is_idempotent_and_reset_isolated(self):
        reset = self.client.post("/api/v1/demo/reset")
        self.assertEqual(reset.status_code, 200, reset.text)
        try:
            status = self.client.get("/api/v1/realtime/status")
            self.assertEqual(status.status_code, 200, status.text)
            status_payload = status.json()
            self.assertFalse(status_payload["liveAvailable"])
            self.assertTrue(
                any(
                    source["name"] == "demo" and source["available"]
                    for source in status_payload["sources"]
                )
            )
            generated_before = status_payload["simulator"]["generatedCount"]

            invalid = self.client.post(
                "/api/v1/demo/generate", json={"scenario": "BOGUS"}
            )
            self.assertEqual(invalid.status_code, 422)

            payload = {
                "scenario": "HIGH_RISK_THRESHOLD",
                "customerId": "20",
                "eventId": "evt-test-high-1",
            }
            generated = self.client.post("/api/v1/demo/generate", json=payload)
            self.assertEqual(generated.status_code, 200, generated.text)
            event = generated.json()
            self.assertEqual(event["mode"], "DEMO")
            self.assertGreaterEqual(event["riskPercent"], 80)
            self.assertTrue(event["notificationCreated"])
            self.assertEqual(event["actions"][0]["channel"], "email")
            self.assertEqual(event["actions"][0]["status"], "simulated_sent")

            duplicate = self.client.post("/api/v1/demo/generate", json=payload)
            self.assertEqual(duplicate.status_code, 200, duplicate.text)
            self.assertTrue(duplicate.json()["duplicate"])
            listed = self.client.get("/api/v1/realtime/events?q=evt-test-high-1")
            self.assertEqual(listed.json()["total"], 1)

            new_customer = self.client.post(
                "/api/v1/demo/generate",
                json={
                    "scenario": "NEW_CUSTOMER_ACTIVITY",
                    "eventId": "evt-test-new-1",
                },
            )
            self.assertEqual(new_customer.status_code, 200, new_customer.text)
            self.assertEqual(new_customer.json()["actions"][0]["channel"], "telegram")

            history = self.client.get("/api/v1/realtime/customers/20/history")
            self.assertEqual(history.status_code, 200, history.text)
            self.assertEqual(history.json()["calculations"][0]["eventId"], "evt-test-high-1")

            dashboard = self.client.get("/api/v1/realtime/dashboard")
            self.assertEqual(dashboard.status_code, 200, dashboard.text)
            self.assertGreaterEqual(dashboard.json()["eventsInPeriod"], 2)
            self.assertEqual(dashboard.json()["trackedCustomers"], 4)

            notifications = self.client.get("/api/v1/notifications?limit=30").json()
            self.assertTrue(
                any(
                    item.get("eventId") == "evt-test-high-1" and item.get("mode") == "DEMO"
                    for item in notifications["items"]
                )
            )

            cursor = self.client.get("/api/v1/realtime/events?limit=1").json()["latestId"]
            replayed = self.client.post(
                "/api/v1/demo/generate",
                json={
                    "scenario": "NORMAL_ACTIVITY",
                    "customerId": "20",
                    "eventId": "evt-test-replay-1",
                },
            )
            self.assertEqual(replayed.status_code, 200, replayed.text)
            with self.client.stream(
                "GET", f"/api/v1/realtime/stream?last_event_id={cursor}"
            ) as stream:
                self.assertEqual(stream.status_code, 200)
                lines = []
                for line in stream.iter_lines():
                    if line:
                        lines.append(line)
                    if len(lines) >= 3:
                        break
                self.assertTrue(any("realtime_event" in line for line in lines))
                self.assertTrue(any("evt-test-replay-1" in line for line in lines))

            started = self.client.post(
                "/api/v1/demo/simulator/start",
                json={"intervalSeconds": 2, "scenario": "NORMAL_ACTIVITY"},
            )
            self.assertEqual(started.status_code, 200, started.text)
            self.assertTrue(started.json()["simulator"]["running"])
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = self.client.get("/api/v1/realtime/status").json()
                if current["simulator"]["generatedCount"] > generated_before:
                    break
                time.sleep(0.1)
            else:
                self.fail("DEMO simulator did not generate an event")
        finally:
            stopped = self.client.post("/api/v1/demo/simulator/stop")
            self.assertEqual(stopped.status_code, 200, stopped.text)
            self.assertFalse(stopped.json()["simulator"]["running"])
            reset = self.client.post("/api/v1/demo/reset")
            self.assertEqual(reset.status_code, 200, reset.text)

        self.assertEqual(self.client.get("/api/v1/realtime/events").json()["total"], 0)
        self.assertEqual(self.client.get("/api/v1/customers").json()["total"], 3)

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

    def test_snapshot_upload_accepts_export_bonus_state_spellings(self):
        response = self.client.put(
            "/api/v1/source/snapshot",
            json={
                "accounts": [
                    {
                        "id": 501,
                        "email": "bonus-on@example.org",
                        "balance": 0,
                        "bonusBalance": 1000,
                        "bonusState": "Подключена",
                    },
                    {
                        "id": 502,
                        "email": "bonus-unknown@example.org",
                        "balance": 0,
                        "bonusBalance": 1000,
                        "bonusState": "неизвестный экспортный статус",
                    },
                ],
                "services": [
                    {
                        "id": "s-501",
                        "accountId": 501,
                        "status": "active",
                        "price": 100,
                        "paymentTerm": "month",
                        "autoprolong": "Подключено",
                    },
                    {
                        "id": "s-502",
                        "accountId": 502,
                        "status": "active",
                        "price": 100,
                        "paymentTerm": "month",
                        "autoprolong": "off",
                    },
                ],
                "transactions": [],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        customers = self.client.get(
            "/api/v1/customers?sort=id&order=asc"
        ).json()
        self.assertEqual(customers["total"], 2)
        self.assertEqual(
            [row["availableBalance"] for row in customers["items"]],
            [1000, 0],
        )
        self.assertIs(customers["items"][0]["services"][0]["autoprolong"], True)

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
