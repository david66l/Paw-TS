from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "upstream" / "src"))
sys.path.insert(0, str(HERE))

from paw_provider import PawMemoryProvider


class PawMemoryProviderCapabilityTest(unittest.TestCase):
    def test_required_source_local_locator_fails_closed(self) -> None:
        provider = PawMemoryProvider()
        provider.initialize = lambda: None
        provider._call = lambda *_args, **_kwargs: {
            "sourceLocalLocatorConfigured": False
        }

        with patch.dict(os.environ, {"PAW_AMB_SOURCE_LOCAL_LOCATOR": "1"}):
            with self.assertRaisesRegex(RuntimeError, "source-local locator"):
                provider.prepare(Path("unused"), reset=False)

    def test_required_source_local_locator_accepts_bridge_handshake(self) -> None:
        provider = PawMemoryProvider()
        provider.initialize = lambda: None
        provider._call = lambda *_args, **_kwargs: {
            "sourceLocalLocatorConfigured": True
        }

        with patch.dict(os.environ, {"PAW_AMB_SOURCE_LOCAL_LOCATOR": "1"}):
            provider.prepare(Path("unused"), reset=False)


if __name__ == "__main__":
    unittest.main()
