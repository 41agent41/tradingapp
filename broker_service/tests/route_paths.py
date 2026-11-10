"""The paths a FastAPI app serves, for tests that check its wiring.

FastAPI 0.16x stopped flattening routers into ``app.routes``: an included
router is one entry without a ``path``. Its routes appear in the OpenAPI
schema instead, so the served paths are the app's own routes (``/metrics`` is
added straight onto the app, hidden from the schema) plus the schema's paths.
"""

from __future__ import annotations

from fastapi import FastAPI


def served_paths(app: FastAPI) -> set[str]:
    own = {route.path for route in app.routes if hasattr(route, "path")}
    return own | set(app.openapi()["paths"])
