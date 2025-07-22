import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';

const router = express.Router();
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

// Interface for account data - basic required fields only for optimal performance
interface AccountSummary {
  account_id: string;
  net_liquidation?: number;  // Basic required field
  currency: string;          // Basic required field  
  last_updated: string;
  
  // Optional fields (not requested in basic mode)
  total_cash_value?: number;
  buying_power?: number;
  maintenance_margin?: number;
}

interface Position {
  symbol: string;
  position: number;
  market_price?: number;
  market_value?: number;
  average_cost?: number;
  unrealized_pnl?: number;
  currency: string;
}

interface Order {
  order_id: number;
  symbol: string;
  action: string;
  quantity: number;
  order_type: string;
  status: string;
  filled_quantity?: number;
  remaining_quantity?: number;
  avg_fill_price?: number;
}

interface AccountData {
  account: AccountSummary;
  positions: Position[];
  orders: Order[];
  last_updated: string;
}

// Get account summary
router.get('/summary', async (req: Request, res: Response) => {
  try {
    console.log('Fetching account summary from IB service');

    const response = await axios.get(`${IB_SERVICE_URL}/account/summary`, {
      timeout: 20000, // 20 second timeout for account data
      headers: {
        'Connection': 'close'
      }
    });

    console.log('Successfully fetched account summary');
    res.json(response.data);

  } catch (error: any) {
    console.error('Error fetching account summary:', error);
    
    let errorMessage = 'Unknown error';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }
    
    res.status(statusCode).json({
      error: 'Failed to fetch account summary',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: IB_SERVICE_URL,
      timestamp: new Date().toISOString()
    });
  }
});

// Get account positions
router.get('/positions', async (req: Request, res: Response) => {
  try {
    console.log('Fetching account positions from IB service');

    const response = await axios.get(`${IB_SERVICE_URL}/account/positions`, {
      timeout: 20000, // 20 second timeout
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Successfully fetched ${response.data.length} positions`);
    res.json({
      positions: response.data,
      count: response.data.length,
      last_updated: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('Error fetching account positions:', error);
    
    let errorMessage = 'Unknown error';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }
    
    res.status(statusCode).json({
      error: 'Failed to fetch account positions',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: IB_SERVICE_URL,
      timestamp: new Date().toISOString()
    });
  }
});

// Get account orders
router.get('/orders', async (req: Request, res: Response) => {
  try {
    console.log('Fetching account orders from IB service');

    const response = await axios.get(`${IB_SERVICE_URL}/account/orders`, {
      timeout: 20000, // 20 second timeout
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Successfully fetched ${response.data.length} orders`);
    res.json({
      orders: response.data,
      count: response.data.length,
      last_updated: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('Error fetching account orders:', error);
    
    let errorMessage = 'Unknown error';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }
    
    res.status(statusCode).json({
      error: 'Failed to fetch account orders',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: IB_SERVICE_URL,
      timestamp: new Date().toISOString()
    });
  }
});

// Get all account data in one call
router.get('/all', async (req: Request, res: Response) => {
  try {
    console.log('Fetching all account data from IB service');

    const response = await axios.get(`${IB_SERVICE_URL}/account/all`, {
      timeout: 30000, // 30 second timeout for comprehensive data
      headers: {
        'Connection': 'close'
      }
    });

    console.log('Successfully fetched all account data');
    res.json(response.data);

  } catch (error: any) {
    console.error('Error fetching all account data:', error);
    
    let errorMessage = 'Unknown error';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }
    
    res.status(statusCode).json({
      error: 'Failed to fetch all account data',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: IB_SERVICE_URL,
      timestamp: new Date().toISOString()
    });
  }
});

// Get IB connection status (moved from other routes for account independence)
router.get('/connection', async (req: Request, res: Response) => {
  try {
    console.log('Checking IB Gateway connection status');

    const response = await axios.get(`${IB_SERVICE_URL}/connection`, {
      timeout: 10000, // 10 second timeout for connection check
      headers: {
        'Connection': 'close'
      }
    });

    console.log('Successfully retrieved connection status');
    res.json(response.data);

  } catch (error: any) {
    console.error('Error checking IB connection:', error);
    
    let errorMessage = 'Unknown error';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }
    
    res.status(statusCode).json({
      error: 'Failed to check IB connection',
      detail: errorMessage,
      connected: false,
      ib_service_status: statusCode,
      ib_service_url: IB_SERVICE_URL,
      timestamp: new Date().toISOString()
    });
  }
});

export default router; 