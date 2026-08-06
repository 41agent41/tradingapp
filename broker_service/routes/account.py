"""Read-only account endpoints (summary / positions / orders / combined)."""

from __future__ import annotations

import math
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, status

from ib_client import get_ib_connection, verify_connection_health
from models import AccountData, AccountSummary, Position
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
                    order_id=order_data["orderId"],
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


@router.get("/account/summary", response_model=AccountSummary)
async def get_account_summary():
    """Get account summary information"""
    try:
        logger.info("Account summary endpoint called")
        summary = await run_tws_operation(get_account_summary_sync)
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
async def get_account_positions(broker: str = "ib"):
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
            adapter = get_broker_adapter(broker)
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
async def get_account_orders():
    """Get current account orders"""
    try:
        logger.info("Account orders endpoint called")
        orders = await run_tws_operation(get_orders_sync)
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
async def get_all_account_data():
    """Get all account data (summary, positions, orders) in one call - sequential for stability"""
    try:
        logger.info("All account data endpoint called - using sequential approach for stability")

        # Get account summary first (most important)
        try:
            summary = await run_tws_operation(get_account_summary_sync)
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
            positions = await run_tws_operation(get_positions_sync)
            logger.info(f"✅ Positions retrieved: {len(positions)} positions")
        except Exception as e:
            logger.warning(f"⚠️ Failed to get positions (continuing): {e}")

        # Get orders (optional - continue if fails)
        orders = []
        try:
            orders = await run_tws_operation(get_orders_sync)
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
