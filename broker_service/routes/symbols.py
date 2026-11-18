"""Symbol-discovery endpoints and cache management."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, status

import symbol_catalogue
from ib_client import get_ib_connection, verify_connection_health
from ib_helpers import (
    cache_symbols,
    create_contract,
    get_cache_key,
    get_cached_symbols,
)
from ib_helpers import (
    clear_symbol_cache as _clear_symbol_cache,
)
from ib_helpers import (
    get_cache_stats as _symbol_cache_stats,
)
from models import SymbolDiscoveryRequest
from observability import get_logger

from .contracts import venue_search

logger = get_logger(__name__)
router = APIRouter()


@router.post("/symbols/discover")
async def discover_symbols(request: SymbolDiscoveryRequest):
    """
    Enhanced symbol discovery with 3-phase approach:
    Phase 1: reqContractDetails for precise filtering
    Phase 2: reqMatchingSymbols as fallback for broader discovery
    Phase 3: Intelligent caching for performance
    """
    try:
        pattern = request.pattern.strip().upper()
        if not pattern:
            return {"results": [], "method": "none", "cached": False, "count": 0}

        found = venue_search(
            request.source,
            pattern,
            secType=request.secType,
            exchange=request.exchange,
            currency=request.currency,
            account_mode=request.account_mode,
        )
        if found is not None:
            results = found.get("results", [])
            return {
                "results": results[: request.max_results],
                "method": "venue_search",
                "cached": False,
                "count": len(results),
            }

        # Phase 3: Check cache first
        cache_key = get_cache_key(pattern, request.secType, request.exchange, request.currency)
        cached_results = get_cached_symbols(cache_key)
        if cached_results:
            return {
                "results": cached_results[: request.max_results],
                "method": "cache",
                "cached": True,
                "count": len(cached_results),
            }

        logger.info(
            f"Symbol discovery for pattern: {pattern} ({request.secType}) on {request.exchange}"
        )

        # Get connection
        ib = get_ib_connection()
        if not verify_connection_health(ib):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="IB Gateway connection is not available",
            )

        results = []
        method_used = "none"

        # Phase 1: Try reqContractDetails first (precise filtering)
        try:
            logger.info(f"Phase 1: Trying reqContractDetails for {pattern}")

            # Support wildcard pattern matching
            if len(pattern) == 1:
                # Single letter: try exact first, then common two-letter combinations
                search_patterns = [
                    pattern,  # Exact match (e.g., "A")
                    f"{pattern}A",  # AA (American Airlines, etc.)
                    f"{pattern}M",  # AM (American Express, AMD, etc.)
                    f"{pattern}P",  # AP (Apple, etc.)
                    f"{pattern}D",  # AD patterns
                    f"{pattern}I",  # AI patterns
                    f"{pattern}L",  # AL patterns
                    f"{pattern}B",  # AB patterns
                    f"{pattern}C",  # AC patterns
                    f"{pattern}G",  # AG patterns
                    f"{pattern}R",  # AR patterns
                    f"{pattern}S",  # AS patterns
                    f"{pattern}T",  # AT patterns
                    f"{pattern}V",  # AV patterns
                    f"{pattern}Z",  # AZ patterns
                ]
            elif len(pattern) >= 2:
                # Multiple letters: try exact and wildcard
                search_patterns = [pattern, f"{pattern}*"]
            else:
                search_patterns = [pattern]

            # Collect all contracts from all search patterns
            all_contracts = []

            for search_pattern in search_patterns:
                contract = create_contract(
                    search_pattern, request.secType, request.exchange, request.currency
                )

                # Clear previous results for this specific search
                ib.contracts = []

                # Request contract details
                ib.reqContractDetails(10, contract)
                time.sleep(2)  # Wait for results

                logger.info(f"Found {len(ib.contracts)} contracts for pattern: {search_pattern}")

                # Collect all contracts from this search
                if ib.contracts:
                    all_contracts.extend(ib.contracts)

                # Stop early if we have lots of contracts already
                if len(all_contracts) >= request.max_results * 2:  # Get extra for filtering
                    logger.info(f"Early stop: collected {len(all_contracts)} contracts")
                    break

            # Now process all collected contracts
            logger.info(f"Processing {len(all_contracts)} total contracts from all search patterns")

            for contract in all_contracts:
                # Filter results to match the original pattern (case-insensitive)
                if pattern.lower() in contract.symbol.lower():
                    # Extract company name (consistent with existing endpoint)
                    company_name = getattr(contract, "longName", "") or contract.symbol

                    result = {
                        "symbol": contract.symbol,
                        "company_name": company_name,
                        "description": f"{contract.symbol} - {company_name}",
                        "secType": contract.secType,
                        "exchange": contract.exchange,
                        "currency": contract.currency,
                        "conid": str(getattr(contract, "conId", "")),
                        "primary_exchange": getattr(contract, "primaryExchange", ""),
                        "local_symbol": getattr(contract, "localSymbol", ""),
                        "trading_class": getattr(contract, "tradingClass", ""),
                        "method": "reqContractDetails",
                    }

                    # Avoid duplicates by symbol
                    if not any(r["symbol"] == result["symbol"] for r in results):
                        results.append(result)
                        logger.info(
                            f"Added to results: {contract.symbol} ({contract.secType}) "
                            f"on {contract.exchange}"
                        )

                    # Stop if we have enough results
                    if len(results) >= request.max_results:
                        break

            if results:
                method_used = "reqContractDetails"
                logger.info(
                    f"Phase 1 success: Found {len(results)} symbols using reqContractDetails"
                )
            else:
                logger.info(
                    f"Phase 1: No results found for pattern {pattern} using reqContractDetails"
                )

        except Exception as e:
            logger.error(f"Phase 1 (reqContractDetails) failed: {e}", exc_info=True)

        # Phase 2: Fallback to reqMatchingSymbols if needed and enabled
        if len(results) < 5 and request.use_fallback:  # Use fallback if fewer than 5 results
            try:
                logger.info(f"Phase 2: Trying reqMatchingSymbols for {pattern}")

                # Clear any previous data
                ib.symbols = []

                # Request matching symbols - try both exact and expanded patterns
                search_term = pattern

                ib.reqMatchingSymbols(11, search_term)
                time.sleep(3)  # Wait longer for matching symbols

                logger.info(
                    f"Phase 2: reqMatchingSymbols returned {len(getattr(ib, 'symbols', []))} symbols"
                )

                if hasattr(ib, "symbols") and ib.symbols:
                    for contract_desc in ib.symbols:
                        contract_obj = contract_desc.contract

                        # Filter by security type and exchange if specified
                        if (
                            contract_obj.secType == request.secType
                            and (
                                request.exchange == "SMART"
                                or contract_obj.exchange == request.exchange
                            )
                            and contract_obj.currency == request.currency
                        ):
                            derivative_types = getattr(contract_desc, "derivativeSecTypes", None)
                            company_name = (
                                derivative_types[0] if derivative_types else contract_obj.symbol
                            )
                            description_suffix = derivative_types[0] if derivative_types else "N/A"

                            result = {
                                "symbol": contract_obj.symbol,
                                "company_name": company_name,
                                "description": f"{contract_obj.symbol} - {description_suffix}",
                                "secType": contract_obj.secType,
                                "exchange": contract_obj.exchange,
                                "currency": contract_obj.currency,
                                "conid": getattr(contract_obj, "conId", ""),
                                "primary_exchange": getattr(contract_obj, "primaryExchange", ""),
                                "local_symbol": getattr(contract_obj, "localSymbol", ""),
                                "trading_class": getattr(contract_obj, "tradingClass", ""),
                                "method": "reqMatchingSymbols",
                            }

                            # Avoid duplicates
                            if not any(r["symbol"] == result["symbol"] for r in results):
                                results.append(result)

                if results:
                    method_used = "reqMatchingSymbols"
                    logger.info(
                        f"Phase 2 success: Found {len(results)} symbols using reqMatchingSymbols"
                    )

            except Exception as e:
                logger.warning(f"Phase 2 (reqMatchingSymbols) failed: {e}")

        # Sort results by symbol name for consistency
        results.sort(key=lambda x: x["symbol"])

        # Limit results
        limited_results = results[: request.max_results]

        # Phase 3: Cache the results
        if limited_results:
            cache_symbols(cache_key, limited_results)

        logger.info(
            f"Symbol discovery completed: {len(limited_results)} results using {method_used}"
        )
        if limited_results:
            symbols_found = [r["symbol"] for r in limited_results]
            logger.info(f"Symbols found: {symbols_found}")

        return {
            "results": limited_results,
            "method": method_used,
            "cached": False,
            "count": len(limited_results),
            "pattern": pattern,
            "secType": request.secType,
            "exchange": request.exchange,
            "currency": request.currency,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in symbol discovery: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Symbol discovery failed: {str(e)}",
        )


@router.get("/symbols/cache/stats")
async def get_cache_stats():
    """Get cache statistics"""
    stats = _symbol_cache_stats()
    return {
        "total_entries": stats["size"],
        "valid_entries": stats["valid_entries"],
        "expired_entries": stats["expired_entries"],
        "cache_size_limit": stats["max_size"],
        "ttl_seconds": stats["ttl_seconds"],
    }


@router.post("/symbols/cache/clear")
async def clear_cache():
    """Clear symbol cache"""
    removed = _clear_symbol_cache()
    logger.info("symbol_cache_cleared", removed=removed)
    return {"message": f"Cache cleared. Removed {removed} entries."}


@router.get("/symbols/catalogue")
def symbol_catalogue_for(
    source: Optional[str] = Query(None, description="Platform; default the priority broker"),
    account: Optional[str] = Query(None, description="Account on it; default its default"),
    q: str = Query("", max_length=64, description="Search-only brokers: what to look for"),
    market: str = Query("", description="Search-only brokers: the market to look in"),
    account_mode: str = Query("paper"),
):
    """What a connection can trade, each entry with its market.

    A listable broker answers with its whole list (``complete: true``) and
    ignores ``q``. A search-only broker (IB, IG) answers with what a search
    for ``q`` finds (``complete: false``), and with nothing when ``q`` is
    empty: there is no list of everything to give.
    """
    from adapters import get_market_data_adapter, resolve_provider

    platform = resolve_provider(source)
    adapter = get_market_data_adapter(platform, account)
    lister = getattr(adapter, "list_instruments", None)
    if callable(lister):
        rows = lister()
        return {
            "platform": platform,
            "complete": True,
            "instruments": rows,
            "count": len(rows),
        }

    pattern = q.strip()
    rows = []
    if pattern:
        sec_type = symbol_catalogue.MARKET_SEC_TYPE.get(market.upper(), "STK")
        found = venue_search(
            platform, pattern, secType=sec_type, currency="", account_mode=account_mode
        )
        if found is None:  # IB Gateway: its contract search talks to the gateway
            found = adapter.search_contracts(
                SimpleNamespace(
                    symbol=pattern,
                    secType=sec_type,
                    exchange="SMART",
                    currency="",
                    name=False,
                    account_mode=account_mode,
                    source=platform,
                )
            )
        rows = symbol_catalogue.from_search_results(list((found or {}).get("results") or []))
    return {"platform": platform, "complete": False, "instruments": rows, "count": len(rows)}
