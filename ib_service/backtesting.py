"""
Backtesting Module for TradingApp
==================================

Provides backtesting capabilities for technical analysis strategies.
Integrates with the indicators module to test trading strategies on historical data.

Author: TradingApp Development Team
Version: 1.0.0
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime, timedelta
from dataclasses import dataclass
from enum import Enum
import logging

from indicators import calculator as indicator_calculator

logger = logging.getLogger(__name__)

class OrderType(Enum):
    BUY = "BUY"
    SELL = "SELL"

class OrderStatus(Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"

@dataclass
class Trade:
    """Represents a single trade"""
    entry_time: datetime
    exit_time: Optional[datetime]
    entry_price: float
    exit_price: Optional[float]
    quantity: int
    order_type: OrderType
    status: OrderStatus
    entry_reason: str
    exit_reason: Optional[str] = None
    
    @property
    def pnl(self) -> float:
        """Calculate profit/loss for the trade"""
        if self.exit_price is None:
            return 0.0
        
        if self.order_type == OrderType.BUY:
            return (self.exit_price - self.entry_price) * self.quantity
        else:  # SELL
            return (self.entry_price - self.exit_price) * self.quantity
    
    @property
    def pnl_percent(self) -> float:
        """Calculate profit/loss percentage"""
        if self.exit_price is None:
            return 0.0
        
        if self.order_type == OrderType.BUY:
            return ((self.exit_price - self.entry_price) / self.entry_price) * 100
        else:  # SELL
            return ((self.entry_price - self.exit_price) / self.entry_price) * 100
    
    @property
    def duration(self) -> Optional[timedelta]:
        """Calculate trade duration"""
        if self.exit_time is None:
            return None
        return self.exit_time - self.entry_time

@dataclass
class BacktestResults:
    """Results from a backtest run"""
    symbol: str
    start_date: datetime
    end_date: datetime
    initial_capital: float
    final_capital: float
    total_trades: int
    winning_trades: int
    losing_trades: int
    total_return: float
    total_return_percent: float
    max_drawdown: float
    sharpe_ratio: float
    win_rate: float
    average_win: float
    average_loss: float
    profit_factor: float
    trades: List[Trade]
    equity_curve: pd.Series
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert results to dictionary for JSON serialization"""
        return {
            'symbol': self.symbol,
            'start_date': self.start_date.isoformat(),
            'end_date': self.end_date.isoformat(),
            'initial_capital': self.initial_capital,
            'final_capital': self.final_capital,
            'total_trades': self.total_trades,
            'winning_trades': self.winning_trades,
            'losing_trades': self.losing_trades,
            'total_return': self.total_return,
            'total_return_percent': self.total_return_percent,
            'max_drawdown': self.max_drawdown,
            'sharpe_ratio': self.sharpe_ratio,
            'win_rate': self.win_rate,
            'average_win': self.average_win,
            'average_loss': self.average_loss,
            'profit_factor': self.profit_factor,
            'trades_summary': [
                {
                    'entry_time': trade.entry_time.isoformat(),
                    'exit_time': trade.exit_time.isoformat() if trade.exit_time else None,
                    'entry_price': trade.entry_price,
                    'exit_price': trade.exit_price,
                    'quantity': trade.quantity,
                    'order_type': trade.order_type.value,
                    'pnl': trade.pnl,
                    'pnl_percent': trade.pnl_percent,
                    'duration_hours': trade.duration.total_seconds() / 3600 if trade.duration else None,
                    'entry_reason': trade.entry_reason,
                    'exit_reason': trade.exit_reason
                } for trade in self.trades
            ]
        }

class TradingStrategy:
    """Base class for trading strategies"""
    
    def __init__(self, name: str, indicators: List[str] = None):
        self.name = name
        self.indicators = indicators or []
        self.position = 0  # Current position size
        self.trades: List[Trade] = []
        self.pending_orders: List[Trade] = []
    
    def should_buy(self, data: pd.Series) -> Tuple[bool, str]:
        """Override this method to define buy conditions"""
        return False, "No buy signal"
    
    def should_sell(self, data: pd.Series) -> Tuple[bool, str]:
        """Override this method to define sell conditions"""
        return False, "No sell signal"
    
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """Generate buy/sell signals for the entire dataset"""
        signals = df.copy()
        signals['buy_signal'] = False
        signals['sell_signal'] = False
        signals['buy_reason'] = ''
        signals['sell_reason'] = ''
        
        for i in range(len(df)):
            current_data = df.iloc[i]
            
            buy_signal, buy_reason = self.should_buy(current_data)
            sell_signal, sell_reason = self.should_sell(current_data)
            
            signals.iloc[i, signals.columns.get_loc('buy_signal')] = buy_signal
            signals.iloc[i, signals.columns.get_loc('sell_signal')] = sell_signal
            signals.iloc[i, signals.columns.get_loc('buy_reason')] = buy_reason if buy_signal else ''
            signals.iloc[i, signals.columns.get_loc('sell_reason')] = sell_reason if sell_signal else ''
        
        return signals

class SimpleMAStrategy(TradingStrategy):
    """Simple Moving Average Crossover Strategy"""
    
    def __init__(self, fast_period: int = 20, slow_period: int = 50):
        super().__init__(
            name=f"MA Crossover ({fast_period}/{slow_period})",
            indicators=['sma_20', 'sma_50']
        )
        self.fast_period = fast_period
        self.slow_period = slow_period
    
    def should_buy(self, data: pd.Series) -> Tuple[bool, str]:
        """Buy when fast MA crosses above slow MA"""
        if pd.isna(data.get('sma_20')) or pd.isna(data.get('sma_50')):
            return False, "Insufficient MA data"
        
        # Check if fast MA just crossed above slow MA
        fast_ma = data['sma_20']
        slow_ma = data['sma_50']
        
        if fast_ma > slow_ma and self.position <= 0:
            return True, f"MA Crossover: Fast MA ({fast_ma:.2f}) > Slow MA ({slow_ma:.2f})"
        
        return False, "No MA crossover signal"
    
    def should_sell(self, data: pd.Series) -> Tuple[bool, str]:
        """Sell when fast MA crosses below slow MA"""
        if pd.isna(data.get('sma_20')) or pd.isna(data.get('sma_50')):
            return False, "Insufficient MA data"
        
        # Check if fast MA just crossed below slow MA
        fast_ma = data['sma_20']
        slow_ma = data['sma_50']
        
        if fast_ma < slow_ma and self.position > 0:
            return True, f"MA Cross Down: Fast MA ({fast_ma:.2f}) < Slow MA ({slow_ma:.2f})"
        
        return False, "No MA sell signal"

class RSIStrategy(TradingStrategy):
    """RSI Mean Reversion Strategy"""
    
    def __init__(self, oversold_level: float = 30, overbought_level: float = 70):
        super().__init__(
            name=f"RSI Strategy ({oversold_level}/{overbought_level})",
            indicators=['rsi']
        )
        self.oversold_level = oversold_level
        self.overbought_level = overbought_level
    
    def should_buy(self, data: pd.Series) -> Tuple[bool, str]:
        """Buy when RSI is oversold"""
        if pd.isna(data.get('rsi')):
            return False, "No RSI data"
        
        rsi = data['rsi']
        
        if rsi < self.oversold_level and self.position <= 0:
            return True, f"RSI Oversold: {rsi:.2f} < {self.oversold_level}"
        
        return False, "RSI not oversold"
    
    def should_sell(self, data: pd.Series) -> Tuple[bool, str]:
        """Sell when RSI is overbought"""
        if pd.isna(data.get('rsi')):
            return False, "No RSI data"
        
        rsi = data['rsi']
        
        if rsi > self.overbought_level and self.position > 0:
            return True, f"RSI Overbought: {rsi:.2f} > {self.overbought_level}"
        
        return False, "RSI not overbought"

class BacktestEngine:
    """Main backtesting engine"""
    
    def __init__(self, initial_capital: float = 100000, commission: float = 0.001):
        self.initial_capital = initial_capital
        self.commission = commission  # Commission as percentage of trade value
        
    def run_backtest(
        self, 
        df: pd.DataFrame, 
        strategy: TradingStrategy,
        symbol: str = "UNKNOWN"
    ) -> BacktestResults:
        """Run backtest on historical data"""
        
        logger.info(f"Starting backtest for {strategy.name} on {symbol}")
        
        # Calculate indicators if not present
        df_with_indicators = indicator_calculator.calculate_indicators(df, strategy.indicators)
        
        # Generate trading signals
        signals = strategy.generate_signals(df_with_indicators)
        
        # Initialize tracking variables
        capital = self.initial_capital
        position = 0
        trades: List[Trade] = []
        equity_curve = []
        open_trade: Optional[Trade] = None
        
        # Process each bar
        for i, (timestamp, data) in enumerate(signals.iterrows()):
            current_price = data['close']
            current_time = timestamp if isinstance(timestamp, datetime) else datetime.fromtimestamp(timestamp)
            
            # Check for exit signals first
            if open_trade and data['sell_signal']:
                # Close position
                open_trade.exit_time = current_time
                open_trade.exit_price = current_price
                open_trade.status = OrderStatus.FILLED
                open_trade.exit_reason = data['sell_reason']
                
                # Calculate commission
                trade_value = abs(open_trade.quantity * current_price)
                commission_cost = trade_value * self.commission
                
                # Update capital
                capital += open_trade.pnl - commission_cost
                position = 0
                trades.append(open_trade)
                open_trade = None
                
                logger.debug(f"Closed position at {current_price:.2f}, PnL: {trades[-1].pnl:.2f}")
            
            # Check for entry signals
            if not open_trade and data['buy_signal']:
                # Calculate position size (using all available capital for simplicity)
                quantity = int(capital / current_price)
                
                if quantity > 0:
                    # Open position
                    trade_value = quantity * current_price
                    commission_cost = trade_value * self.commission
                    
                    open_trade = Trade(
                        entry_time=current_time,
                        exit_time=None,
                        entry_price=current_price,
                        exit_price=None,
                        quantity=quantity,
                        order_type=OrderType.BUY,
                        status=OrderStatus.FILLED,
                        entry_reason=data['buy_reason']
                    )
                    
                    capital -= commission_cost
                    position = quantity
                    strategy.position = position
                    
                    logger.debug(f"Opened position at {current_price:.2f}, Quantity: {quantity}")
            
            # Calculate current equity
            current_equity = capital
            if open_trade:
                unrealized_pnl = (current_price - open_trade.entry_price) * open_trade.quantity
                current_equity += unrealized_pnl
            
            equity_curve.append(current_equity)
        
        # Close any remaining open position
        if open_trade:
            final_price = signals.iloc[-1]['close']
            open_trade.exit_time = signals.index[-1] if isinstance(signals.index[-1], datetime) else datetime.fromtimestamp(signals.index[-1])
            open_trade.exit_price = final_price
            open_trade.status = OrderStatus.FILLED
            open_trade.exit_reason = "End of backtest"
            
            trade_value = abs(open_trade.quantity * final_price)
            commission_cost = trade_value * self.commission
            capital += open_trade.pnl - commission_cost
            trades.append(open_trade)
        
        # Calculate performance metrics
        results = self._calculate_performance_metrics(
            symbol=symbol,
            start_date=signals.index[0] if isinstance(signals.index[0], datetime) else datetime.fromtimestamp(signals.index[0]),
            end_date=signals.index[-1] if isinstance(signals.index[-1], datetime) else datetime.fromtimestamp(signals.index[-1]),
            initial_capital=self.initial_capital,
            final_capital=capital,
            trades=trades,
            equity_curve=pd.Series(equity_curve, index=signals.index)
        )
        
        logger.info(f"Backtest completed: {len(trades)} trades, {results.total_return_percent:.2f}% return")
        
        return results
    
    def _calculate_performance_metrics(
        self,
        symbol: str,
        start_date: datetime,
        end_date: datetime,
        initial_capital: float,
        final_capital: float,
        trades: List[Trade],
        equity_curve: pd.Series
    ) -> BacktestResults:
        """Calculate performance metrics from trades"""
        
        total_return = final_capital - initial_capital
        total_return_percent = (total_return / initial_capital) * 100
        
        # Trade statistics
        total_trades = len(trades)
        winning_trades = len([t for t in trades if t.pnl > 0])
        losing_trades = len([t for t in trades if t.pnl < 0])
        
        win_rate = (winning_trades / total_trades * 100) if total_trades > 0 else 0
        
        # Average win/loss
        wins = [t.pnl for t in trades if t.pnl > 0]
        losses = [abs(t.pnl) for t in trades if t.pnl < 0]
        
        average_win = np.mean(wins) if wins else 0
        average_loss = np.mean(losses) if losses else 0
        
        # Profit factor
        total_wins = sum(wins) if wins else 0
        total_losses = sum(losses) if losses else 0
        profit_factor = (total_wins / total_losses) if total_losses > 0 else float('inf')
        
        # Maximum drawdown
        running_max = equity_curve.expanding().max()
        drawdown = (equity_curve - running_max) / running_max * 100
        max_drawdown = drawdown.min()
        
        # Sharpe ratio (simplified - assuming daily returns)
        returns = equity_curve.pct_change().dropna()
        sharpe_ratio = (returns.mean() / returns.std() * np.sqrt(252)) if returns.std() > 0 else 0
        
        return BacktestResults(
            symbol=symbol,
            start_date=start_date,
            end_date=end_date,
            initial_capital=initial_capital,
            final_capital=final_capital,
            total_trades=total_trades,
            winning_trades=winning_trades,
            losing_trades=losing_trades,
            total_return=total_return,
            total_return_percent=total_return_percent,
            max_drawdown=max_drawdown,
            sharpe_ratio=sharpe_ratio,
            win_rate=win_rate,
            average_win=average_win,
            average_loss=average_loss,
            profit_factor=profit_factor,
            trades=trades,
            equity_curve=equity_curve
        )

# Global backtesting engine instance
backtest_engine = BacktestEngine()

# Available strategies
AVAILABLE_STRATEGIES = {
    'ma_crossover': SimpleMAStrategy,
    'rsi_mean_reversion': RSIStrategy
}