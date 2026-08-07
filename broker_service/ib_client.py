"""
TWS API client + connection state.

Wraps the IBApp class (the ``EWrapper`` callback receiver) and the
connection-management helpers that used to live at the top of main.py.
Connection state is module-level — every route accesses it via the public
helpers (``get_ib_connection``, ``get_connection_status``,
``disconnect_ib``, ``verify_connection_health``) — so the rest of the
service does not have to import private globals.

Extracted from main.py during the GAP_ANALYSIS §3.4 module split.
"""

from __future__ import annotations

import os
import random
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from ibapi.client import EClient
from ibapi.wrapper import EWrapper

from observability import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Configuration (read at import time)
# ---------------------------------------------------------------------------
IB_HOST = os.getenv("IB_HOST")
if not IB_HOST:
    raise ValueError("IB_HOST environment variable is required")

IB_PORT = int(os.getenv("IB_PORT", "4002"))
IB_CLIENT_ID = int(os.getenv("IB_CLIENT_ID", "1"))
IB_TIMEOUT = int(os.getenv("IB_TIMEOUT", "15"))


# ---------------------------------------------------------------------------
# Module-level connection state
# ---------------------------------------------------------------------------
_ib_client: Optional[IBApp] = None
_connection_status: Dict[str, Any] = {
    "connected": False,
    "last_connected": None,
    "last_error": None,
    "connection_count": 0,
}


def get_connection_status() -> Dict[str, Any]:
    """Return the current connection-status snapshot (mutated by the helpers)."""
    return _connection_status


def get_ib_app() -> Optional[IBApp]:
    """Return the live IBApp instance, or None if disconnected. Read-only helper."""
    return _ib_client


# ---------------------------------------------------------------------------
# IBApp — wraps EClient/EWrapper
# ---------------------------------------------------------------------------
class IBApp(EWrapper, EClient):
    """TWS API Application class."""

    def __init__(self) -> None:
        EClient.__init__(self, self)
        self.data: Dict[int, Dict[str, Any]] = {}
        self.contracts: list = []
        self.historical_data: list = []
        self.account_summary: Dict[str, Dict[str, Any]] = {}
        self.positions: list = []
        self.orders: list = []
        self.executions: list = []
        # execId -> CommissionReport. IB delivers commission/realised-PnL for a
        # fill on a *separate* callback that can arrive either side of its
        # execDetails, so the two are collected independently and joined by
        # execId when the route assembles its response.
        self.commissions: Dict[str, Any] = {}
        self.managed_accounts: list = []
        self.next_order_id: Optional[int] = None
        self.connection_ready = threading.Event()

    # ----- EWrapper callbacks --------------------------------------------
    def error(self, reqId, errorCode, errorString):  # noqa: N802 (TWS API name)
        logger.error("tws_api_error", req_id=reqId, code=errorCode, message=errorString)

    def connectAck(self):  # noqa: N802
        logger.info("tws_api_connection_acknowledged")

    def nextValidId(self, orderId):  # noqa: N802
        self.next_order_id = orderId
        logger.info("tws_next_valid_order_id", order_id=orderId)

    def managedAccounts(self, accountsList):  # noqa: N802
        self.managed_accounts = accountsList.split(",")
        logger.info("tws_managed_accounts", accounts=self.managed_accounts)

    def contractDetails(self, reqId, contractDetails):  # noqa: N802
        self.contracts.append(contractDetails.contract)
        logger.info(
            "tws_contract_details",
            req_id=reqId,
            symbol=contractDetails.contract.symbol,
        )

    def contractDetailsEnd(self, reqId):  # noqa: N802
        logger.info("tws_contract_details_end", req_id=reqId)

    def historicalData(self, reqId, bar):  # noqa: N802
        self.historical_data.append(bar)

    def historicalDataEnd(self, reqId, start, end):  # noqa: N802
        logger.info("tws_historical_data_end", req_id=reqId)

    def tickPrice(self, reqId, tickType, price, attrib):  # noqa: N802
        if reqId not in self.data:
            self.data[reqId] = {}
        self.data[reqId]["price"] = price
        self.data[reqId]["tickType"] = tickType

    def tickSize(self, reqId, tickType, size):  # noqa: N802
        if reqId not in self.data:
            self.data[reqId] = {}
        self.data[reqId]["size"] = size
        self.data[reqId]["tickType"] = tickType

    def accountSummary(self, reqId, account, tag, value, currency):  # noqa: N802
        if account not in self.account_summary:
            self.account_summary[account] = {}
        self.account_summary[account][tag] = value

    def accountSummaryEnd(self, reqId):  # noqa: N802
        logger.info("tws_account_summary_end", req_id=reqId)

    def position(self, account, contract, position, avgCost):  # noqa: N803
        self.positions.append(
            {"account": account, "contract": contract, "position": position, "avgCost": avgCost}
        )

    def positionEnd(self):  # noqa: N802
        logger.info("tws_position_end")

    def openOrder(self, orderId, contract, order, orderState):  # noqa: N802
        self.orders.append(
            {"orderId": orderId, "contract": contract, "order": order, "orderState": orderState}
        )

    def orderStatus(  # noqa: N802
        self,
        orderId,
        status,
        filled,
        remaining,
        avgFillPrice,
        permId,
        parentId,
        lastFillPrice,
        clientId,
        whyHeld,
        mktCapPrice,
    ):
        logger.debug("tws_order_status", order_id=orderId, status=status)

    # ----- execution reports (fills) -------------------------------------- #
    def execDetails(self, reqId, contract, execution):  # noqa: N802
        """A fill. Keeps the contract alongside it — the execution itself
        carries no currency, and only the contract knows the instrument."""
        self.executions.append({"contract": contract, "execution": execution})

    def execDetailsEnd(self, reqId):  # noqa: N802
        logger.info("tws_exec_details_end", req_id=reqId, count=len(self.executions))

    def commissionReport(self, commissionReport):  # noqa: N802,N803
        self.commissions[commissionReport.execId] = commissionReport


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------
def get_ib_connection() -> IBApp:
    """Get or create IB connection with intelligent client ID retry."""

    global _ib_client

    try:
        if _ib_client and _ib_client.isConnected():
            return _ib_client

        if _ib_client:
            try:
                _ib_client.disconnect()
                logger.info("cleaned_up_previous_connection")
            except Exception:  # noqa: BLE001
                pass
            _ib_client = None

        base_id = IB_CLIENT_ID
        client_ids_to_try = [
            base_id,
            base_id + 1,
            base_id + 2,
            base_id + 3,
            base_id + 4,
            base_id + 5,
        ]
        random.shuffle(client_ids_to_try[1:])
        last_error: Optional[str] = None

        for client_id in client_ids_to_try:
            try:
                logger.info(
                    "attempting_ib_connection",
                    host=IB_HOST,
                    port=IB_PORT,
                    client_id=client_id,
                )
                _ib_client = IBApp()
                _ib_client.connect(IB_HOST, IB_PORT, client_id)

                api_thread = threading.Thread(target=_ib_client.run, daemon=True)
                api_thread.start()

                logger.info("waiting_for_connection_to_stabilize")
                time.sleep(5)

                connection_verified = False
                for verify_attempt in range(5):
                    if _ib_client.isConnected():
                        connection_verified = True
                        logger.info("connection_verified", attempt=verify_attempt + 1)
                        break
                    logger.warning(
                        "connection_verification_pending",
                        attempt=verify_attempt + 1,
                        of=5,
                    )
                    time.sleep(3)

                if connection_verified:
                    _connection_status.update(
                        {
                            "connected": True,
                            "last_connected": datetime.now().isoformat(),
                            "last_error": None,
                            "connection_count": _connection_status["connection_count"] + 1,
                        }
                    )
                    logger.info(
                        "ib_connection_successful",
                        host=IB_HOST,
                        port=IB_PORT,
                        client_id=client_id,
                    )
                    return _ib_client

                raise RuntimeError(
                    "Connection call succeeded but connection verification failed after retries"
                )

            except Exception as e:  # noqa: BLE001
                error_msg = str(e)
                last_error = error_msg

                lowered = error_msg.lower()
                if "client id is already in use" in lowered or "326" in error_msg:
                    logger.warning(
                        "client_id_in_use_trying_next",
                        client_id=client_id,
                    )
                    if _ib_client:
                        try:
                            _ib_client.disconnect()
                        except Exception:  # noqa: BLE001
                            pass
                        _ib_client = None
                    continue
                if "peer closed" in lowered or "connection established but" in lowered:
                    logger.warning(
                        "connection_issue_trying_next",
                        client_id=client_id,
                        err=error_msg,
                    )
                    if _ib_client:
                        try:
                            _ib_client.disconnect()
                        except Exception:  # noqa: BLE001
                            pass
                        _ib_client = None
                    time.sleep(2)
                    continue
                logger.error(
                    "ib_connection_error",
                    client_id=client_id,
                    err=error_msg,
                )
                if _ib_client:
                    try:
                        _ib_client.disconnect()
                    except Exception:  # noqa: BLE001
                        pass
                    _ib_client = None
                break

        # If we get here, all client IDs failed.
        logger.error("ib_connection_all_ids_failed", last_error=last_error)

        lowered = str(last_error).lower()
        if "timeout" in lowered:
            helpful_msg = (
                f"IB Gateway connection timeout. Please check: 1) IB Gateway is running on {IB_HOST}, "
                f"2) API is enabled in IB Gateway settings, 3) Port {IB_PORT} is correct, "
                f"4) Network connectivity to {IB_HOST}"
            )
        elif "refused" in lowered:
            helpful_msg = (
                "IB Gateway refused connection. Please check: 1) IB Gateway API settings are enabled, "
                f"2) Port {IB_PORT} is correct, 3) Trusted IPs include this server, "
                "4) IB Gateway is not in offline mode"
            )
        elif "unreachable" in lowered or "no route to host" in lowered:
            helpful_msg = (
                f"Cannot reach {IB_HOST}. Please check: 1) IP address {IB_HOST} is correct, "
                "2) Network connectivity, 3) Firewall settings"
            )
        elif "client id is already in use" in lowered:
            helpful_msg = (
                f"All client IDs ({base_id}-{base_id+5}) are in use. Please: "
                "1) Close other trading applications, 2) Restart IB Gateway, "
                "3) Wait a few minutes for connections to timeout, "
                "4) Check if multiple trading services are running"
            )
        else:
            helpful_msg = f"IB Gateway connection failed: {last_error}"

        _connection_status.update({"connected": False, "last_error": helpful_msg})
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=helpful_msg)

    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        error_msg = f"Unexpected connection error: {e}"
        logger.error("ib_connection_unexpected_error", err=str(e))
        _connection_status.update({"connected": False, "last_error": error_msg})
        if _ib_client:
            try:
                _ib_client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        _ib_client = None
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=error_msg
        ) from e


def verify_connection_health(ib_client: Optional[IBApp]) -> bool:
    """Verify that an IB connection is healthy and responsive."""
    try:
        if not ib_client or not ib_client.isConnected():
            return False
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("connection_health_check_failed", err=str(e))
        return False


def disconnect_ib() -> None:
    """Disconnect from IB Gateway with improved cleanup."""

    global _ib_client

    if _ib_client:
        try:
            if _ib_client.isConnected():
                logger.info("disconnecting_from_ib_gateway")
                _ib_client.disconnect()
                logger.info("ib_gateway_disconnected")
            else:
                logger.info("ib_gateway_already_disconnected")
        except Exception as e:  # noqa: BLE001
            logger.error("ib_disconnect_error", err=str(e))
        finally:
            _ib_client = None
            _connection_status.update({"connected": False, "last_error": None})
            logger.info("connection_cleanup_completed")
