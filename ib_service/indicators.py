"""
Technical Indicators Module for TradingApp
==========================================

Comprehensive technical analysis indicators using pandas and numpy.
Designed for integration with Interactive Brokers market data.

Author: TradingApp Development Team
Version: 1.0.0
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Union
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class TechnicalIndicators:
    """
    Technical Analysis Indicators Calculator
    
    Provides a comprehensive suite of technical indicators for market analysis:
    - Trend Indicators: SMA, EMA, WMA, MACD
    - Momentum Indicators: RSI, Stochastic, Williams %R
    - Volatility Indicators: Bollinger Bands, ATR, Keltner Channels
    - Volume Indicators: OBV, Volume SMA, VWAP
    """
    
    @staticmethod
    def prepare_dataframe(bars_data: List[Dict]) -> pd.DataFrame:
        """Convert bars data to pandas DataFrame with proper index"""
        df = pd.DataFrame(bars_data)
        if 'timestamp' in df.columns:
            df['datetime'] = pd.to_datetime(df['timestamp'], unit='s')
            df.set_index('datetime', inplace=True)
        
        # Ensure numeric columns
        numeric_cols = ['open', 'high', 'low', 'close', 'volume']
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')
        
        return df
    
    # ===========================================
    # TREND INDICATORS
    # ===========================================
    
    @staticmethod
    def sma(data: pd.Series, period: int) -> pd.Series:
        """Simple Moving Average"""
        return data.rolling(window=period, min_periods=1).mean()
    
    @staticmethod
    def ema(data: pd.Series, period: int) -> pd.Series:
        """Exponential Moving Average"""
        return data.ewm(span=period, adjust=False).mean()
    
    @staticmethod
    def wma(data: pd.Series, period: int) -> pd.Series:
        """Weighted Moving Average"""
        def weighted_mean(x):
            weights = np.arange(1, len(x) + 1)
            return np.dot(x, weights) / weights.sum()
        
        return data.rolling(window=period).apply(weighted_mean, raw=True)
    
    @staticmethod
    def macd(data: pd.Series, fast_period: int = 12, slow_period: int = 26, signal_period: int = 9) -> Dict[str, pd.Series]:
        """
        MACD (Moving Average Convergence Divergence)
        Returns: {'macd': line, 'signal': signal_line, 'histogram': histogram}
        """
        ema_fast = TechnicalIndicators.ema(data, fast_period)
        ema_slow = TechnicalIndicators.ema(data, slow_period)
        macd_line = ema_fast - ema_slow
        signal_line = TechnicalIndicators.ema(macd_line, signal_period)
        histogram = macd_line - signal_line
        
        return {
            'macd': macd_line,
            'signal': signal_line,
            'histogram': histogram
        }
    
    # ===========================================
    # MOMENTUM INDICATORS
    # ===========================================
    
    @staticmethod
    def rsi(data: pd.Series, period: int = 14) -> pd.Series:
        """Relative Strength Index"""
        delta = data.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        
        rs = gain / loss
        rsi = 100 - (100 / (1 + rs))
        return rsi
    
    @staticmethod
    def stochastic(high: pd.Series, low: pd.Series, close: pd.Series, 
                   k_period: int = 14, d_period: int = 3) -> Dict[str, pd.Series]:
        """
        Stochastic Oscillator
        Returns: {'%K': k_percent, '%D': d_percent}
        """
        lowest_low = low.rolling(window=k_period).min()
        highest_high = high.rolling(window=k_period).max()
        
        k_percent = 100 * (close - lowest_low) / (highest_high - lowest_low)
        d_percent = k_percent.rolling(window=d_period).mean()
        
        return {
            '%K': k_percent,
            '%D': d_percent
        }
    
    @staticmethod
    def williams_r(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
        """Williams %R"""
        highest_high = high.rolling(window=period).max()
        lowest_low = low.rolling(window=period).min()
        
        return -100 * (highest_high - close) / (highest_high - lowest_low)
    
    @staticmethod
    def roc(data: pd.Series, period: int = 12) -> pd.Series:
        """Rate of Change"""
        return ((data / data.shift(period)) - 1) * 100
    
    # ===========================================
    # VOLATILITY INDICATORS
    # ===========================================
    
    @staticmethod
    def bollinger_bands(data: pd.Series, period: int = 20, std_dev: float = 2.0) -> Dict[str, pd.Series]:
        """
        Bollinger Bands
        Returns: {'upper': upper_band, 'middle': middle_band, 'lower': lower_band}
        """
        middle_band = data.rolling(window=period).mean()
        std = data.rolling(window=period).std()
        upper_band = middle_band + (std * std_dev)
        lower_band = middle_band - (std * std_dev)
        
        return {
            'upper': upper_band,
            'middle': middle_band,
            'lower': lower_band
        }
    
    @staticmethod
    def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
        """Average True Range"""
        high_low = high - low
        high_close_prev = np.abs(high - close.shift(1))
        low_close_prev = np.abs(low - close.shift(1))
        
        true_range = pd.concat([high_low, high_close_prev, low_close_prev], axis=1).max(axis=1)
        return true_range.rolling(window=period).mean()
    
    @staticmethod
    def keltner_channels(high: pd.Series, low: pd.Series, close: pd.Series, 
                        period: int = 20, multiplier: float = 2.0) -> Dict[str, pd.Series]:
        """
        Keltner Channels
        Returns: {'upper': upper_channel, 'middle': middle_channel, 'lower': lower_channel}
        """
        middle_channel = TechnicalIndicators.ema(close, period)
        atr_value = TechnicalIndicators.atr(high, low, close, period)
        
        upper_channel = middle_channel + (multiplier * atr_value)
        lower_channel = middle_channel - (multiplier * atr_value)
        
        return {
            'upper': upper_channel,
            'middle': middle_channel,
            'lower': lower_channel
        }
    
    # ===========================================
    # VOLUME INDICATORS
    # ===========================================
    
    @staticmethod
    def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
        """On-Balance Volume"""
        direction = np.where(close.diff() > 0, 1, 
                           np.where(close.diff() < 0, -1, 0))
        obv = (direction * volume).cumsum()
        return obv
    
    @staticmethod
    def vwap(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series) -> pd.Series:
        """Volume Weighted Average Price"""
        typical_price = (high + low + close) / 3
        vwap = (typical_price * volume).cumsum() / volume.cumsum()
        return vwap
    
    @staticmethod
    def volume_sma(volume: pd.Series, period: int = 20) -> pd.Series:
        """Volume Simple Moving Average"""
        return volume.rolling(window=period).mean()
    
    # ===========================================
    # SUPPORT/RESISTANCE INDICATORS
    # ===========================================
    
    @staticmethod
    def pivot_points(high: pd.Series, low: pd.Series, close: pd.Series) -> Dict[str, pd.Series]:
        """
        Pivot Points (Previous day's data)
        Returns: {'pivot': pivot, 'r1': r1, 'r2': r2, 's1': s1, 's2': s2}
        """
        pivot = (high.shift(1) + low.shift(1) + close.shift(1)) / 3
        r1 = 2 * pivot - low.shift(1)
        r2 = pivot + (high.shift(1) - low.shift(1))
        s1 = 2 * pivot - high.shift(1)
        s2 = pivot - (high.shift(1) - low.shift(1))
        
        return {
            'pivot': pivot,
            'r1': r1,
            'r2': r2,
            's1': s1,
            's2': s2
        }


class IndicatorCalculator:
    """
    Main calculator class for processing market data with indicators
    """
    
    def __init__(self):
        self.indicators = TechnicalIndicators()
    
    def calculate_indicators(self, df: pd.DataFrame, indicator_list: List[str]) -> pd.DataFrame:
        """
        Calculate specified indicators and add to DataFrame
        
        Args:
            df: DataFrame with OHLCV data
            indicator_list: List of indicator names to calculate
            
        Returns:
            DataFrame with original data + calculated indicators
        """
        result_df = df.copy()
        
        try:
            for indicator in indicator_list:
                if indicator == 'sma_20':
                    result_df['sma_20'] = self.indicators.sma(df['close'], 20)
                elif indicator == 'sma_50':
                    result_df['sma_50'] = self.indicators.sma(df['close'], 50)
                elif indicator == 'ema_12':
                    result_df['ema_12'] = self.indicators.ema(df['close'], 12)
                elif indicator == 'ema_26':
                    result_df['ema_26'] = self.indicators.ema(df['close'], 26)
                elif indicator == 'rsi':
                    result_df['rsi'] = self.indicators.rsi(df['close'])
                elif indicator == 'macd':
                    macd_data = self.indicators.macd(df['close'])
                    result_df['macd'] = macd_data['macd']
                    result_df['macd_signal'] = macd_data['signal']
                    result_df['macd_histogram'] = macd_data['histogram']
                elif indicator == 'bollinger':
                    bb_data = self.indicators.bollinger_bands(df['close'])
                    result_df['bb_upper'] = bb_data['upper']
                    result_df['bb_middle'] = bb_data['middle']
                    result_df['bb_lower'] = bb_data['lower']
                elif indicator == 'stochastic':
                    stoch_data = self.indicators.stochastic(df['high'], df['low'], df['close'])
                    result_df['stoch_k'] = stoch_data['%K']
                    result_df['stoch_d'] = stoch_data['%D']
                elif indicator == 'atr':
                    result_df['atr'] = self.indicators.atr(df['high'], df['low'], df['close'])
                elif indicator == 'obv':
                    result_df['obv'] = self.indicators.obv(df['close'], df['volume'])
                elif indicator == 'vwap':
                    result_df['vwap'] = self.indicators.vwap(df['high'], df['low'], df['close'], df['volume'])
                elif indicator == 'volume_sma':
                    result_df['volume_sma'] = self.indicators.volume_sma(df['volume'])
                else:
                    logger.warning(f"Unknown indicator requested: {indicator}")
                    
        except Exception as e:
            logger.error(f"Error calculating indicators: {e}")
            
        return result_df
    
    def get_available_indicators(self) -> Dict[str, Dict]:
        """Return list of available indicators with metadata"""
        return {
            'trend': {
                'sma_20': {'name': 'SMA 20', 'description': 'Simple Moving Average (20 periods)'},
                'sma_50': {'name': 'SMA 50', 'description': 'Simple Moving Average (50 periods)'},
                'ema_12': {'name': 'EMA 12', 'description': 'Exponential Moving Average (12 periods)'},
                'ema_26': {'name': 'EMA 26', 'description': 'Exponential Moving Average (26 periods)'},
            },
            'momentum': {
                'rsi': {'name': 'RSI', 'description': 'Relative Strength Index (14 periods)'},
                'macd': {'name': 'MACD', 'description': 'Moving Average Convergence Divergence'},
                'stochastic': {'name': 'Stochastic', 'description': 'Stochastic Oscillator (%K/%D)'},
            },
            'volatility': {
                'bollinger': {'name': 'Bollinger Bands', 'description': 'Bollinger Bands (20, 2.0)'},
                'atr': {'name': 'ATR', 'description': 'Average True Range (14 periods)'},
            },
            'volume': {
                'obv': {'name': 'OBV', 'description': 'On-Balance Volume'},
                'vwap': {'name': 'VWAP', 'description': 'Volume Weighted Average Price'},
                'volume_sma': {'name': 'Volume SMA', 'description': 'Volume Simple Moving Average'},
            }
        }


# Global calculator instance
calculator = IndicatorCalculator()