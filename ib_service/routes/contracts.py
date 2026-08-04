"""Contract search endpoints (basic + advanced)."""

from __future__ import annotations

import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, status

from ib_client import get_ib_connection
from ib_helpers import create_contract, get_data_type_for_account_mode
from models import AdvancedSearchRequest, SearchRequest
from observability import get_logger

logger = get_logger(__name__)
router = APIRouter()


def _exchange_sort_key(result):
    """Sort contracts SMART-first, then by common US exchanges, then symbol."""
    exchange_priority = {"SMART": 0, "NYSE": 1, "NASDAQ": 2, "AMEX": 3}
    return (exchange_priority.get(result["exchange"], 999), result["symbol"])


def _contract_to_result(contract) -> dict:
    """Flatten an ibapi contract into the search-result dict shape."""
    company_name = getattr(contract, "longName", "") or contract.symbol
    result = {
        "conid": str(contract.conId),
        "symbol": contract.symbol,
        "companyName": company_name,
        "description": f"{contract.symbol} - {company_name}",
        "secType": contract.secType,
        "exchange": contract.exchange,
        "currency": contract.currency,
        "primaryExchange": getattr(contract, "primaryExchange", ""),
        "localSymbol": getattr(contract, "localSymbol", ""),
        "tradingClass": getattr(contract, "tradingClass", ""),
        "multiplier": getattr(contract, "multiplier", ""),
        "strike": getattr(contract, "strike", ""),
        "right": getattr(contract, "right", ""),
        "expiry": getattr(contract, "expiry", ""),
        "includeExpired": getattr(contract, "includeExpired", False),
        "comboLegsDescrip": getattr(contract, "comboLegsDescrip", ""),
        "contractMonth": getattr(contract, "contractMonth", ""),
        "industry": getattr(contract, "industry", ""),
        "category": getattr(contract, "category", ""),
        "subcategory": getattr(contract, "subcategory", ""),
        "timeZoneId": getattr(contract, "timeZoneId", ""),
        "tradingHours": getattr(contract, "tradingHours", ""),
        "liquidHours": getattr(contract, "liquidHours", ""),
        "evRule": getattr(contract, "evRule", ""),
        "evMultiplier": getattr(contract, "evMultiplier", ""),
        "secIdList": getattr(contract, "secIdList", []),
        "aggGroup": getattr(contract, "aggGroup", ""),
        "underSymbol": getattr(contract, "underSymbol", ""),
        "underSecType": getattr(contract, "underSecType", ""),
        "marketRuleIds": getattr(contract, "marketRuleIds", ""),
        "realExpirationDate": getattr(contract, "realExpirationDate", ""),
        "lastTradingDay": getattr(contract, "lastTradingDay", ""),
        "stockType": getattr(contract, "stockType", ""),
        "minSize": getattr(contract, "minSize", ""),
        "sizeIncrement": getattr(contract, "sizeIncrement", ""),
        "suggestedSizeIncrement": getattr(contract, "suggestedSizeIncrement", ""),
        "sections": [],
    }

    # Add sections for multi-exchange contracts
    if hasattr(contract, "sections") and contract.sections:
        for section in contract.sections:
            result["sections"].append(
                {
                    "exchange": section.exchange,
                    "secType": section.secType,
                    "expiry": section.expiry,
                    "strike": section.strike,
                    "right": section.right,
                    "multiplier": section.multiplier,
                    "tradingClass": section.tradingClass,
                    "localSymbol": section.localSymbol,
                    "includeExpired": section.includeExpired,
                    "comboLegsDescrip": section.comboLegsDescrip,
                    "contractMonth": section.contractMonth,
                    "industry": section.industry,
                    "category": section.category,
                    "subcategory": section.subcategory,
                    "timeZoneId": section.timeZoneId,
                    "tradingHours": section.tradingHours,
                    "liquidHours": section.liquidHours,
                    "evRule": section.evRule,
                    "evMultiplier": section.evMultiplier,
                    "secIdList": section.secIdList,
                    "aggGroup": section.aggGroup,
                    "underSymbol": section.underSymbol,
                    "underSecType": section.underSecType,
                    "marketRuleIds": section.marketRuleIds,
                    "realExpirationDate": section.realExpirationDate,
                    "lastTradingDay": section.lastTradingDay,
                    "stockType": section.stockType,
                    "minSize": section.minSize,
                    "sizeIncrement": section.sizeIncrement,
                    "suggestedSizeIncrement": section.suggestedSizeIncrement,
                }
            )

    return result


def search_contracts_sync(request: SearchRequest) -> dict:
    """Contract-search worker (the IB implementation of
    ``MarketDataAdapter.search_contracts``). Extracted from the route so the
    IB adapter can delegate to it; the route dispatches here via the registry.
    """
    # Log the account mode being used
    data_type = get_data_type_for_account_mode(request.account_mode)
    logger.info(
        f"Searching contracts for {request.symbol} ({request.secType}) "
        f"in {request.account_mode} mode - {data_type} data"
    )

    # Get connection
    ib = get_ib_connection()

    # Create contract with enhanced parameters
    contract = create_contract(
        request.symbol.upper(), request.secType, request.exchange, request.currency
    )

    # Clear previous contracts
    ib.contracts = []

    # Request contract details with longer timeout for better results
    ib.reqContractDetails(5, contract)
    time.sleep(3)  # Increased wait time for more comprehensive results

    if not ib.contracts:
        return {"results": [], "count": 0}

    # Enhanced results formatting with more details
    results = [_contract_to_result(c) for c in ib.contracts]

    # Sort results by relevance (stocks first, then by exchange preference)
    results.sort(key=_exchange_sort_key)

    return {
        "results": results,
        "count": len(results),
        "search_params": {
            "symbol": request.symbol,
            "secType": request.secType,
            "exchange": request.exchange,
            "currency": request.currency,
            "searchByName": request.name,
        },
        "timestamp": datetime.now().isoformat(),
    }


@router.post("/contract/search")
async def search_contracts(request: SearchRequest):
    """Enhanced search for contracts with better filtering and results.

    Broker-scoped (B1): ``request.source`` selects the venue's catalogue via
    the adapter registry, defaulting to IB. Unknown source → 400; a recognised
    but not-yet-available venue (mt5) → 501.
    """
    try:
        from adapters import get_market_data_adapter

        adapter = get_market_data_adapter(request.source)
        return adapter.search_contracts(request)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error searching contracts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to search contracts: {str(e)}",
        )


@router.post("/contract/advanced-search")
async def advanced_search_contracts(request: AdvancedSearchRequest):
    """Advanced search for contracts with additional filters"""
    try:
        # Log the account mode being used
        data_type = get_data_type_for_account_mode(request.account_mode)
        logger.info(
            f"Advanced search for {request.symbol or 'ALL'} ({request.secType}) "
            f"in {request.account_mode} mode - {data_type} data"
        )

        # Get connection
        ib = get_ib_connection()

        # Create contract with advanced parameters
        contract = create_contract(
            request.symbol.upper() if request.symbol else "",
            request.secType,
            request.exchange,
            request.currency,
        )

        # Apply advanced filters
        if request.expiry:
            contract.expiry = request.expiry
        if request.strike > 0:
            contract.strike = request.strike
        if request.right:
            contract.right = request.right
        if request.multiplier:
            contract.multiplier = request.multiplier
        if request.includeExpired:
            contract.includeExpired = request.includeExpired

        # Clear previous contracts
        ib.contracts = []

        # Request contract details
        ib.reqContractDetails(6, contract)
        time.sleep(3)

        if not ib.contracts:
            return {"results": [], "count": 0}

        # Filter and format results
        results = []
        for found in ib.contracts:
            # Apply additional client-side filtering
            if request.expiry and hasattr(found, "expiry") and found.expiry != request.expiry:
                continue
            if request.strike > 0 and hasattr(found, "strike") and found.strike != request.strike:
                continue
            if request.right and hasattr(found, "right") and found.right != request.right:
                continue
            if (
                request.multiplier
                and hasattr(found, "multiplier")
                and found.multiplier != request.multiplier
            ):
                continue

            results.append(_contract_to_result(found))

        # Sort results
        results.sort(key=_exchange_sort_key)

        return {
            "results": results,
            "count": len(results),
            "search_params": {
                "symbol": request.symbol,
                "secType": request.secType,
                "exchange": request.exchange,
                "currency": request.currency,
                "expiry": request.expiry,
                "strike": request.strike,
                "right": request.right,
                "multiplier": request.multiplier,
                "includeExpired": request.includeExpired,
                "searchByName": request.name,
            },
            "timestamp": datetime.now().isoformat(),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in advanced contract search: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to perform advanced contract search: {str(e)}",
        )
