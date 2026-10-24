"""OIDC login flow (mocked provider), Basic fallback and churn timeline."""

import os
import unittest
from datetime import timedelta
from unittest import mock
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from churnrisk import api as api_module
from churnrisk.api import app
from churnrisk.domain import iso, utcnow
from churnrisk.storage import db, replace_snapshot

DISCOVERY = {
    "issuer": "https://idp.example.org",
    "authorization_endpoint": "https://idp.example.org/authorize",
    "token_endpoint": "https://idp.example.org/token",
    "jwks_uri": "https://idp.example.org/jwks",
}
OIDC_ENV = {
    "OIDC_ISSUER": "https://idp.example.org",
    "OIDC_CLIENT_ID": "kontur-panel",
    "OIDC_CLIENT_SECRET": "test-secret",
    "OIDC_PROVIDER_NAME": "Корпоративный SSO",
}


class OidcTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)

    def test_providers_report_password_fallback_only_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OIDC_ISSUER", None)
            os.environ.pop("OIDC_CLIENT_ID", None)
            payload = self.client.get("/api/v1/auth/providers").json()
            disabled = self.client.get(
                "/api/v1/auth/oidc/login", follow_redirects=False
            )
        self.assertTrue(payload["password"])
        self.assertFalse(payload["oidc"]["enabled"])
        self.assertEqual(disabled.status_code, 503)

    def test_full_authorization_code_flow_creates_session(self):
        claims = {"sub": "user-1", "email": "marketer@example.org"}
        with (
            mock.patch.dict(os.environ, OIDC_ENV),
            mock.patch.object(
                api_module.oidc_service, "discover", return_value=DISCOVERY
            ),
            mock.patch.object(
                api_module.oidc_service,
                "exchange_and_verify",
                return_value=claims,
            ) as exchange,
        ):
            providers = self.client.get("/api/v1/auth/providers").json()
            self.assertTrue(providers["oidc"]["enabled"])
            self.assertEqual(providers["oidc"]["name"], "Корпоративный SSO")

            start = self.client.get(
                "/api/v1/auth/oidc/login", follow_redirects=False
            )
            self.assertEqual(start.status_code, 302)
            location = start.headers["location"]
            self.assertTrue(location.startswith(DISCOVERY["authorization_endpoint"]))
            query = parse_qs(urlparse(location).query)
            self.assertEqual(query["code_challenge_method"], ["S256"])
            self.assertEqual(query["response_type"], ["code"])
            state = query["state"][0]

            callback = self.client.get(
                "/api/v1/auth/oidc/callback",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )
            self.assertEqual(callback.status_code, 303)
            self.assertEqual(callback.headers["location"], "/")
            exchange.assert_called_once()

            me = self.client.get("/api/v1/auth/me")
            self.assertEqual(me.status_code, 200)
            self.assertEqual(me.json()["username"], "marketer@example.org")

            replay = self.client.get(
                "/api/v1/auth/oidc/callback",
                params={"code": "auth-code", "state": state},
                follow_redirects=False,
            )
            self.assertEqual(
                replay.headers["location"], "/login?oidc_error=1"
            )

    def test_callback_with_unknown_state_is_rejected(self):
        with mock.patch.dict(os.environ, OIDC_ENV):
            response = self.client.get(
                "/api/v1/auth/oidc/callback",
                params={"code": "x", "state": "forged"},
                follow_redirects=False,
            )
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/login?oidc_error=1")

    def test_basic_auth_fallback_for_api_clients(self):
        anonymous = TestClient(app)
        ok = anonymous.get(
            "/api/v1/customers",
            auth=("test-admin", "test-only-password-2026"),
        )
        self.assertEqual(ok.status_code, 200)
        bad = anonymous.get(
            "/api/v1/customers", auth=("test-admin", "wrong-password")
        )
        self.assertEqual(bad.status_code, 401)

    def test_churn_timeline_separates_fact_from_forecast(self):
        now = utcnow()
        snapshot = {
            "accounts": [
                {
                    "id": 1,
                    "email": "risk@example.org",
                    "balance": 0,
                    "totalReplenished": 5000,
                }
            ],
            "services": [
                {
                    "id": "gone",
                    "accountId": 1,
                    "status": "deleted",
                    "price": 1000,
                    "paymentTerm": "month",
                    "deletedAt": iso(now - timedelta(days=10)),
                },
                {
                    "id": "soon",
                    "accountId": 1,
                    "status": "active",
                    "price": 2000,
                    "paymentTerm": "month",
                    "autoprolong": False,
                    "expiresAt": iso(now + timedelta(days=5)),
                },
            ],
            "transactions": [],
        }
        login = self.client.post(
            "/api/v1/auth/login",
            json={"username": "test-admin", "password": "test-only-password-2026"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        with db() as connection:
            replace_snapshot(connection, snapshot)
        payload = self.client.get("/api/v1/analytics/churn-timeline").json()
        recent = next(
            bucket for bucket in payload["past"] if bucket["fromDays"] == -30
        )
        nearest = next(
            bucket for bucket in payload["future"] if bucket["fromDays"] == 0
        )
        self.assertEqual(recent["deleted"], 1)
        self.assertEqual(nearest["servicesAtRisk"], 1)
        self.assertGreater(nearest["expectedNonRenewals"], 0)
        self.assertEqual(payload["totals"]["deletedServices"], 1)
        metrics = self.client.get("/metrics").text
        self.assertIn("churn_deleted_services_90d 1", metrics)
        self.assertIn("churn_services_at_risk_30d 1", metrics)


if __name__ == "__main__":
    unittest.main()
