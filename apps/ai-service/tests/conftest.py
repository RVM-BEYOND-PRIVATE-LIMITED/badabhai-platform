"""Test-suite isolation: force OFFLINE, mock-only AI for every test.

A developer ``.env`` may carry a REAL ``GEMINI_FLASH_API_KEY`` and
``AI_ENABLE_REAL_CALLS=true`` (the out-of-band secret setup). Those would make
the suite non-deterministic and could attempt real network calls. We neutralize
that here by pinning the relevant variables in ``os.environ`` BEFORE any test
module (and the import-time ``app.main`` settings singleton) is loaded.

``os.environ`` takes precedence over the ``.env`` file in pydantic-settings, so
this makes the whole suite mock-only WITHOUT reading or modifying ``.env``. Tests
that exercise the real path do so by passing explicit ``Settings(...)`` kwargs
(which override both) and by stubbing the transport — never the network.
"""

import os

# Pin BEFORE app.config / app.main import (conftest is imported first by pytest).
os.environ["AI_ENABLE_REAL_CALLS"] = "false"
os.environ["GEMINI_FLASH_API_KEY"] = ""
os.environ["AI_REAL_CALL_TASKS"] = ""
