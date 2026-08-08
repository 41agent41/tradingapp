"""Read-only account endpoints (summary / positions / orders / executions)."""

from __future__ import annotations

import math
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from ibapi.execution import ExecutionFilter

from executions import normalise_ib_execution
from ib_client import get_ib_connection, verify_connection_health
from models import (
    AccountData,
    AccountSummary,
    Execution,
    InstrumentSpec,
    Position,
    ResolvePreviewRequest,
)
from models import Order as OrderModel
from observability import get_logger

from ._shared import run_tws_operation

logger = get_logger(__name__)
router = APIRouter()


def get_account_summary_sync():
    """Get account summary information using TWS API"""
    try:
        ib = get_ib_connection()

        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")

        logger.info("Getting account summary using TWS API")

        # Get managed accounts
        if not ib.managed_accounts:
            # Request managed accounts
            ib.reqManagedAccts()
            time.sleep(2)

        if not ib.managed_accounts:
            raise Exception("No managed accounts found")

        account_id = ib.managed_accounts[0]
        logger.info(f"Using account: {account_id}")

        # Clear previous account data
        ib.account_summary = {}

        # Request account summary
        account_tags = ["NetLiquidation", "AccountCode", "Currency"]
        ib.reqAccountSummary(6, "All", ",".join(account_tags))
        time.sleep(3)

        # Process account summary
        account_data = ib.account_summary.get(account_id, {})
        currency = account_data.get("Currency", "USD")

        logger.info(f"Retrieved account summary: {account_data}")

        return AccountSummary(
            account_id=account_id,
            currency=currency,
            last_updated=datetime.now().isoformat(),
            net_liquidation=(
                float(account_data.get("NetLiquidation", 0))
                if account_data.get("NetLiquidation")
                else None
            ),
        )

    except Exception as e:
        logger.error(f"Error getting account summary: {e}")
        raise Exception(f"Failed to get account summary: {str(e)}")


def get_positions_sync():
    """Get current positions using TWS API"""
    try:
        ib = get_ib_connection()

        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")

        logger.info("Requesting positions using TWS API")

        # Clear previous positions
        ib.positions = []

        # Request positions
        ib.reqPositions()
        time.sleep(3)

        position_list = []
        for pos in ib.positions:
            if pos["position"] != 0:  # Only include non-zero positions
                position_list.append(
                    Position(
                        symbol=pos["contract"].symbol,
                        position=pos["position"],
                        market_price=None,  # TWS API doesn't provide this in position data
                        market_value=None,  # TWS API doesn't provide this in position data
                        average_cost=(
                            float(pos["avgCost"])
                            if pos["avgCost"] and not math.isnan(float(pos["avgCost"]))
                            else None
                        ),
                        unrealized_pnl=None,  # TWS API doesn't provide this in position data
                        currency=pos["contract"].currency,
                    )
                )

        logger.info(f"Retrieved {len(position_list)} positions")
        return position_list

    except Exception as e:
        logger.error(f"Error getting positions: {e}")
        raise Exception(f"Failed to get positions: {str(e)}")


def get_orders_sync():
    """Get current orders using TWS API"""
    try:
        ib = get_ib_connection()

        # Verify connection health before making requests
        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")

        logger.info("Requesting orders using TWS API")

        # Clear previous orders
        ib.orders = []

        # Request all open orders
        ib.reqAllOpenOrders()
        time.sleep(3)

        order_list = []
        for order_data in ib.orders:
            order_list.append(
                OrderModel(
                    order_id=str(order_data["orderId"]),
                    symbol=order_data["contract"].symbol,
                    action=order_data["order"].action,
                    quantity=order_data["order"].totalQuantity,
                    order_type=order_data["order"].orderType,
                    status=order_data["orderState"].status,
                    filled_quantity=None,  # TWS API doesn't provide this in open orders
                    remaining_quantity=None,  # TWS API doesn't provide this in open orders
                    avg_fill_price=None,  # TWS API doesn't provide this in open orders
                )
            )

        logger.info(f"Retrieved {len(order_list)} orders")
        return order_list

    except Exception as e:
        logger.error(f"Error getting orders: {e}")
        raise Exception(f"Failed to get orders: {str(e)}")


def get_executions_sync(days: int = 1):
    """Fetch recent fills from IB via `reqExecutions`.

    IB only serves executions for the *current* trading day plus, via the
    filter's `time`, whatever it still holds — it is not an unbounded history
    API. That is fine for the caller: the backend polls a small overlapping
    window and dedupes on `exec_id`, so the feed converges without ever needing
    a full replay.

    `execDetails` and `commissionReport` arrive on separate callbacks, so both
    buffers are cleared up front and joined by `execId` afterwards.
    """
    try:
        ib = get_ib_connection()

        if not verify_connection_health(ib):
            raise Exception("TWS API connection is not healthy - reconnection required")

        logger.info(f"Requesting executions using TWS API (days={days})")

        ib.executions = []
        ib.commissions = {}

        exec_filter = ExecutionFilter()
        # IB expects the filter time in the Gateway's own timezone; naive local
        # time is what the API has always accepted here.
        exec_filter.time = (datetime.now() - timedelta(days=max(1, days))).strftime(
            "%Y%m%d %H:%M:%S"
        )
        ib.reqExecutions(9001, exec_filter)
        time.sleep(3)

        rows = []
        for entry in ib.executions:
            execution = entry.get("execution")
            exec_id = str(getattr(execution, "execId", "") or "")
            if not exec_id:
                continue
            rows.append(
                Execution(
                    **normalise_ib_execution(
                        entry.get("contract"),
                        execution,
                        ib.commissions.get(exec_id),
                    )
                )
            )

        logger.info(f"Retrieved {len(rows)} executions")
        return rows

    except Exception as e:
        logger.error(f"Error getting executions: {e}")
        raise Exception(f"Failed to get executions: {str(e)}")


@router.get("/account/executions", response_model=list[Execution])
async def get_account_executions(
    broker: str = "ib",
    account: str | None = None,
    days: int = Query(default=1, ge=1, le=30),
):
    """Recent **fills** for a venue — the authoritative record of what traded.

    Distinct from `/account/orders`, which reports what is *working*. Every
    venue normalises to the same `Execution` shape and every row carries the
    venue's own `exec_id`, so the backend can poll an overlapping window and
    upsert without duplicating. `broker=ib` uses the synchronous `reqExecutions`
    path; other venues dispatch through the adapter registry, with an unknown
    broker a 400 and a recognised-but-unconfigured one a 501.
    """
    try:
        logger.info(
            f"Account executions endpoint called (broker={broker}, "
            f"account={account}, days={days})"
        )

        from adapters import get_broker_adapter, resolve_provider

        if resolve_provider(broker) == "ib":
            rows = await run_tws_operation(lambda: get_executions_sync(days))
        else:
            adapter = get_broker_adapter(broker, account)
            rows = await run_tws_operation(lambda: adapter.executions(days))
        logger.info(f"Successfully retrieved {len(rows)} executions")
        return rows

    except HTTPException as he:
        logger.error(f"HTTP Exception in account executions: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account executions endpoint: {error_str}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account executions: {error_str}",
        )


@router.get("/instrument/spec", response_model=InstrumentSpec)
async def get_instrument_spec(
    symbol: str = Query(..., min_length=1),
    broker: str = "ib",
    account: str | None = None,
):
    """What one unit of quantity means for an instrument at a venue.

    Sizing is abstract until it has to become a number, and "100" means 100
    shares on IB but 100 *lots* on MT5 — millions of units of the base
    currency. This is the venue's own answer, so the sizer can convert rather
    than approximate. See `models.InstrumentSpec`.
    """
    try:
        from adapters import get_broker_adapter

        adapter = get_broker_adapter(broker, account)
        spec = await run_tws_operation(lambda: adapter.instrument_spec(symbol))
        return InstrumentSpec(**spec)

    except HTTPException as he:
        logger.error(f"HTTP Exception in instrument spec: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in instrument spec endpoint: {error_str}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get instrument spec: {error_str}",
        )


@router.get("/account/summary", response_model=AccountSummary)
async def get_account_summary(broker: str = "ib", account: str | None = None):
    """Account summary for a venue.

    Broker-aware for the same reason positions are: a run on MT5 / Alpaca /
    OANDA reading IB's account is simply the wrong account. It also supplies
    the **equity** that `pct_equity` sizing needs, which is why each adapter
    normalises to this shape rather than returning its raw venue payload —
    the sizer can't be asked to learn four vocabularies for "net liquidation".
    """
    try:
        logger.info(f"Account summary endpoint called (broker={broker})")

        from adapters import get_broker_adapter, resolve_provider

        if resolve_provider(broker) == "ib":
            summary = await run_tws_operation(get_account_summary_sync)
        else:
            adapter = get_broker_adapter(broker, account)
            summary = AccountSummary(**await run_tws_operation(adapter.account_summary))
        logger.info(f"Successfully retrieved account summary for account: {summary.account_id}")
        return summary

    except HTTPException as he:
        logger.error(f"HTTP Exception in account summary: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account summary endpoint: {error_str}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account summary: {error_str}",
        )


@router.get("/account/positions", response_model=list[Position])
async def get_account_positions(broker: str = "ib", account: str | None = None):
    """Get current account positions for a venue (B1 close-out).

    Dispatches through the broker adapter registry, so a run on MT5 / Alpaca /
    OANDA reads *its own* venue's positions rather than IB's. Each adapter
    normalises its payload to the app's `Position` shape. `broker=ib` keeps the
    existing synchronous IB path byte-for-byte; an unknown broker is a 400 and a
    recognised-but-unconfigured one a 501, same as everywhere else.
    """
    try:
        logger.info(f"Account positions endpoint called (broker={broker})")

        from adapters import get_broker_adapter, resolve_provider

        if resolve_provider(broker) == "ib":
            positions = await run_tws_operation(get_positions_sync)
        else:
            adapter = get_broker_adapter(broker, account)
            positions = await run_tws_operation(adapter.positions)
        logger.info(f"Successfully retrieved {len(positions)} positions")
        return positions

    except HTTPException as he:
        logger.error(f"HTTP Exception in account positions: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account positions endpoint: {error_str}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account positions: {error_str}",
        )


@router.get("/account/orders", response_model=list[OrderModel])
async def get_account_orders(broker: str = "ib", account: str | None = None):
    """Working orders for a venue.

    These are orders still *open* at the venue, as opposed to `/account/executions`
    (what filled) and the backend's `order_audit` (what the app submitted).
    """
    try:
        logger.info(f"Account orders endpoint called (broker={broker})")

        from adapters import get_broker_adapter, resolve_provider

        if resolve_provider(broker) == "ib":
            orders = await run_tws_operation(get_orders_sync)
        else:
            adapter = get_broker_adapter(broker, account)
            orders = await run_tws_operation(adapter.open_orders)
        logger.info(f"Successfully retrieved {len(orders)} orders")
        return orders

    except HTTPException as he:
        logger.error(f"HTTP Exception in account orders: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in account orders endpoint: {error_str}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get account orders: {error_str}",
        )


@router.get("/account/all", response_model=AccountData)
async def get_all_account_data(broker: str = "ib", account: str | None = None):
    """All account data (summary, positions, orders) in one call for a venue.

    Sequential rather than concurrent: the IB path shares one synchronous
    client, so overlapping requests serialise anyway and racing them only
    makes failures harder to attribute.
    """
    try:
        logger.info(f"All account data endpoint called (broker={broker}, account={account})")

        from adapters import get_broker_adapter, resolve_provider

        is_ib = resolve_provider(broker) == "ib"
        adapter = None if is_ib else get_broker_adapter(broker, account)

        # Get account summary first (most important)
        try:
            if is_ib:
                summary = await run_tws_operation(get_account_summary_sync)
            else:
                summary = AccountSummary(**await run_tws_operation(adapter.account_summary))
            logger.info(f"✅ Account summary retrieved for: {summary.account_id}")
        except Exception as e:
            logger.error(f"❌ Failed to get account summary: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to get account summary: {str(e)}",
            )

        # Get positions (optional - continue if fails)
        positions = []
        try:
            positions = await run_tws_operation(get_positions_sync if is_ib else adapter.positions)
            logger.info(f"✅ Positions retrieved: {len(positions)} positions")
        except Exception as e:
            logger.warning(f"⚠️ Failed to get positions (continuing): {e}")

        # Get orders (optional - continue if fails)
        orders = []
        try:
            orders = await run_tws_operation(get_orders_sync if is_ib else adapter.open_orders)
            logger.info(f"✅ Orders retrieved: {len(orders)} orders")
        except Exception as e:
            logger.warning(f"⚠️ Failed to get orders (continuing): {e}")

        account_data = AccountData(
            account=summary,
            positions=positions,
            orders=orders,
            last_updated=datetime.now().isoformat(),
        )

        logger.info(
            f"✅ Successfully retrieved account data for account: {summary.account_id} "
            f"(summary + {len(positions)} positions + {len(orders)} orders)"
        )
        return account_data

    except HTTPException as he:
        logger.error(f"HTTP Exception in all account data: {he.detail}")
        raise he
    except Exception as e:
        error_str = str(e)
        logger.error(f"Error in all account data endpoint: {error_str}")

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get all account data: {error_str}",
        )


# ---------------------------------------------------------------------------
# Canonical → native symbol resolution (Component C — C-2)
# ---------------------------------------------------------------------------
def _resolve_one(symbol: str, broker: str, account: str | None, include_spec: bool) -> dict:
    """Resolve one canonical symbol at one connection, returning the mapping
    plus that connection's own instrument spec.

    The spec belongs with the resolution: lot step, minimum and contract size
    differ per broker for the *same* pair, so a mapping without them tells only
    half the story — and sizing that used another connection's step would place
    orders the broker rejects, or silently rounds.
    """
    from adapters import get_broker_adapter, get_market_data_adapter, resolve_connection
    from symbol_resolution import resolve_symbol

    conn = resolve_connection(broker, account)
    data_adapter = get_market_data_adapter(broker, account)
    resolution = resolve_symbol(
        symbol,
        data_adapter,
        connection_label=conn.label,
        symbol_map=conn.symbol_map,
    )

    row = resolution.as_dict()
    row["broker"] = conn.platform
    row["account"] = conn.account
    row["account_mode"] = conn.account_mode

    if include_spec:
        try:
            broker_adapter = get_broker_adapter(broker, account)
            row["spec"] = broker_adapter.instrument_spec(resolution.native)
        except Exception as exc:  # noqa: BLE001 - a missing spec is not fatal here
            # Report it rather than failing the resolution: the mapping is still
            # correct and useful, and the sizer refuses later if it has no spec.
            row["spec"] = None
            row["spec_error"] = str(exc)
    return row


@router.get("/instrument/resolve")
async def resolve_instrument(
    symbol: str = Query(..., min_length=1),
    broker: str = "ib",
    account: str | None = None,
    include_spec: bool = True,
):
    """Resolve a canonical symbol to this connection's native symbol."""
    try:
        return await run_tws_operation(lambda: _resolve_one(symbol, broker, account, include_spec))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error resolving instrument: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to resolve instrument: {e}",
        )


@router.post("/instrument/resolve/preview")
async def resolve_instrument_preview(request: ResolvePreviewRequest):
    """Resolve one canonical symbol across several connections at once.

    **Never fails as a whole.** Each target reports its own outcome, because
    the useful answer at deploy time is "these four legs resolve, this one does
    not, here is why" — not a single error that hides the four that worked.
    A caller decides whether a partial result is acceptable; the deploy path
    refuses the failing legs and starts the rest.
    """
    results = []
    for target in request.targets:
        try:
            results.append(
                {
                    "ok": True,
                    **await run_tws_operation(
                        lambda t=target: _resolve_one(
                            request.symbol, t.broker, t.account, request.include_spec
                        )
                    ),
                }
            )
        except HTTPException as he:
            results.append(
                {
                    "ok": False,
                    "broker": target.broker,
                    "account": target.account,
                    "canonical": request.symbol.strip().upper(),
                    "status": he.status_code,
                    "error": he.detail,
                }
            )
        except Exception as e:  # noqa: BLE001
            results.append(
                {
                    "ok": False,
                    "broker": target.broker,
                    "account": target.account,
                    "canonical": request.symbol.strip().upper(),
                    "status": 500,
                    "error": str(e),
                }
            )

    resolved = [r for r in results if r["ok"]]
    return {
        "symbol": request.symbol.strip().upper(),
        "results": results,
        "resolved": len(resolved),
        "refused": len(results) - len(resolved),
    }
