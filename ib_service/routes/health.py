"""Health, service-info and connection-management endpoints."""

from __future__ import annotations

import os
from datetime import datetime

from fastapi import APIRouter, HTTPException, status

from ib_client import (
    IB_CLIENT_ID,
    IB_HOST,
    IB_PORT,
    disconnect_ib,
    get_ib_connection,
)
from ib_client import (
    get_connection_status as _get_connection_status_dict,
)
from models import ConnectionInfo
from observability import get_logger

logger = get_logger(__name__)
router = APIRouter()

# Same mutable dict the ib_client helpers mutate in place — bind the reference
# once so the handlers below always read live connection state.
connection_status = _get_connection_status_dict()


@router.get("/health")
async def health_check():
    """Health check endpoint - service status only, no IB Gateway connection test"""
    from adapters import provider_health

    return {
        "status": "healthy",
        "service": "TWS API Service",
        "version": "4.0.0",
        "timestamp": datetime.now().isoformat(),
        "note": "Service is running - IB Gateway connection tested only when endpoints are called",
        "providers": provider_health(),
    }


@router.get("/providers")
async def providers():
    """Broker / data-source registry snapshot (B1): which venues are
    recognised and which have a registered adapter available."""
    from adapters import provider_health

    return provider_health()


@router.get("/timezone-info")
async def timezone_info():
    """Get timezone and timestamp configuration information for debugging"""
    current_time = datetime.now()
    current_utc = datetime.utcnow()

    return {
        "timezone_config": {
            "system_timezone": os.getenv("TZ", "Not set"),
            "ib_timezone": os.getenv("IB_TIMEZONE", "Not set"),
            "expected_format": os.getenv("EXPECTED_TIMESTAMP_FORMAT", "Not set"),
            "data_timezone": os.getenv("DATA_TIMEZONE", "Not set"),
            "ib_format_date": os.getenv("IB_FORMAT_DATE", "Not set"),
        },
        "current_timestamps": {
            "local_time": current_time.isoformat(),
            "utc_time": current_utc.isoformat(),
            "unix_timestamp_seconds": int(current_time.timestamp()),
            "unix_timestamp_milliseconds": int(current_time.timestamp() * 1000),
        },
        "test_timestamps": {
            "seconds_interpretation": datetime.fromtimestamp(
                int(current_time.timestamp())
            ).isoformat(),
            "milliseconds_interpretation": datetime.fromtimestamp(
                int(current_time.timestamp() * 1000) / 1000
            ).isoformat(),
        },
        "configuration_status": {
            "timezone_properly_set": os.getenv("TZ") == "UTC",
            "ib_format_configured": os.getenv("IB_FORMAT_DATE") == "2",
            "timestamp_format_correct": os.getenv("EXPECTED_TIMESTAMP_FORMAT") == "unix_seconds",
        },
    }


@router.get("/")
async def root():
    """Service information"""
    return {
        "service": "TradingApp TWS API Service",
        "version": "4.0.0",
        "status": "running",
        "config": {
            "ib_host": IB_HOST,
            "ib_port": IB_PORT,
            "client_id": IB_CLIENT_ID,
        },
        "connection": connection_status,
    }


@router.get("/connection", response_model=ConnectionInfo)
async def get_connection_status():
    """Get connection status"""
    return ConnectionInfo(
        connected=connection_status["connected"],
        host=IB_HOST,
        port=IB_PORT,
        client_id=IB_CLIENT_ID,
        last_connected=connection_status["last_connected"],
        last_error=connection_status["last_error"],
        connection_count=connection_status["connection_count"],
    )


@router.post("/connect")
async def connect():
    """Manually connect to IB Gateway"""
    try:
        get_ib_connection()
        return {
            "status": "connected",
            "message": "Successfully connected to IB Gateway",
            "connection_info": {
                "host": IB_HOST,
                "port": IB_PORT,
                "client_id": IB_CLIENT_ID,
                "connected_at": connection_status["last_connected"],
            },
        }
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Connection failed: {str(e)}",
        )


@router.post("/disconnect")
async def disconnect():
    """Manually disconnect from IB Gateway"""
    disconnect_ib()
    return {
        "status": "disconnected",
        "message": "Disconnected from IB Gateway",
    }
