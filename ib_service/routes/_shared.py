"""Helpers shared across route modules."""

from __future__ import annotations

import asyncio

from observability import get_logger

logger = get_logger(__name__)


async def run_tws_operation(operation):
    """Run a blocking TWS API operation in the default executor.

    The ibapi client is synchronous; route handlers offload it to a worker
    thread so the event loop stays responsive.
    """

    def run_with_thread():
        try:
            return operation()
        except Exception as e:
            logger.error(f"TWS API operation failed: {e}")
            raise e

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, run_with_thread)
