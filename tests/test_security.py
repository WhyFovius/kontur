from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from churnrisk.security import verify_admin


class SecurityTests(unittest.TestCase):
    def test_configured_admin_password_is_verified(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ADMIN_USERNAME": "admin",
                "ADMIN_PASSWORD": "correct-test-password",
            },
            clear=False,
        ):
            self.assertTrue(verify_admin("admin", "correct-test-password"))
            self.assertFalse(verify_admin("admin", "wrong-test-password"))
            self.assertFalse(verify_admin("other", "correct-test-password"))

    def test_unset_admin_credentials_fail_closed(self) -> None:
        with patch.dict(
            os.environ,
            {"ADMIN_USERNAME": "admin", "ADMIN_PASSWORD": ""},
            clear=False,
        ):
            self.assertFalse(verify_admin("admin", ""))

        with patch.dict(
            os.environ,
            {"ADMIN_USERNAME": "", "ADMIN_PASSWORD": "correct-test-password"},
            clear=False,
        ):
            self.assertFalse(verify_admin("", "correct-test-password"))


if __name__ == "__main__":
    unittest.main()
