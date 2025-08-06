'use client';

import React, { useState, useMemo } from 'react';

interface DataframeViewerProps {
  data: any[];
  title?: string;
  description?: string;
  className?: string;
  maxHeight?: string;
  showExport?: boolean;
  showPagination?: boolean;
  itemsPerPage?: number;
}

interface Column {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'currency';
  width?: string;
}

export default function DataframeViewer({
  data,
  title = 'Data Table',
  description,
  className = '',
  maxHeight = '400px',
  showExport = true,
  showPagination = true,
  itemsPerPage = 50
}: DataframeViewerProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Infer columns from data
  const columns: Column[] = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    const firstRow = data[0];
    return Object.keys(firstRow).map(key => {
      const value = firstRow[key];
      let type: Column['type'] = 'string';
      
      // Special handling for timestamp fields
      if (key.toLowerCase() === 'timestamp' || key.toLowerCase() === 'time') {
        type = 'date';
      } else if (typeof value === 'number') {
        type = 'number';
      } else if (value instanceof Date || (typeof value === 'string' && !isNaN(Date.parse(value)))) {
        type = 'date';
      } else if (typeof value === 'string' && (value.includes('$') || key.toLowerCase().includes('price') || key.toLowerCase().includes('value'))) {
        type = 'currency';
      }
      
      return {
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1'),
        type,
        width: type === 'date' ? '160px' : type === 'number' ? '100px' : 'auto'
      };
    });
  }, [data]);

  // Filter and sort data
  const filteredAndSortedData = useMemo(() => {
    if (!data) return [];
    
    let filtered = data;
    
    // Apply search filter
    if (searchTerm) {
      filtered = data.filter(row =>
        Object.values(row).some(value =>
          String(value).toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }
    
    // Apply sorting
    if (sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;
        
        let comparison = 0;
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          comparison = aVal - bVal;
        } else {
          comparison = String(aVal).localeCompare(String(bVal));
        }
        
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }
    
    return filtered;
  }, [data, searchTerm, sortColumn, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedData.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedData = filteredAndSortedData.slice(startIndex, endIndex);

  // Handle sorting
  const handleSort = (columnKey: string) => {
    if (sortColumn === columnKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(columnKey);
      setSortDirection('asc');
    }
  };

  // Format cell value
  const formatCellValue = (value: any, type: Column['type']) => {
    if (value === null || value === undefined) return 'N/A';
    
    switch (type) {
      case 'number':
        return typeof value === 'number' ? value.toLocaleString() : value;
      case 'currency':
        if (typeof value === 'number') {
          return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(value);
        }
        return value;
      case 'date':
        if (value instanceof Date) {
          return value.toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC';
        } else if (typeof value === 'number') {
          // Handle Unix timestamps (assume seconds if less than a certain threshold)
          const timestamp = value > 1000000000000 ? value : value * 1000;
          const date = new Date(timestamp);
          return isNaN(date.getTime()) ? value : date.toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC';
        } else if (typeof value === 'string') {
          const date = new Date(value);
          return isNaN(date.getTime()) ? value : date.toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC';
        }
        return value;
      default:
        return String(value);
    }
  };

  // Export functions
  const exportToCSV = () => {
    if (!filteredAndSortedData.length) return;
    
    const headers = columns.map(col => col.label).join(',');
    const rows = filteredAndSortedData.map(row =>
      columns.map(col => {
        const value = row[col.key];
        return typeof value === 'string' && value.includes(',') ? `"${value}"` : value;
      }).join(',')
    );
    
    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const exportToJSON = () => {
    const json = JSON.stringify(filteredAndSortedData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  if (!data || data.length === 0) {
    return (
      <div className={`bg-white rounded-lg shadow-sm border p-4 ${className}`}>
        <div className="text-center py-8 text-gray-500">
          <div className="text-4xl mb-4">📊</div>
          <p className="text-sm">No data available to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white rounded-lg shadow-sm border ${className}`}>
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between space-y-2 sm:space-y-0">
          <div>
            <h3 className="text-base sm:text-lg font-medium text-gray-900">{title}</h3>
            {description && (
              <p className="text-xs sm:text-sm text-gray-600 mt-1">{description}</p>
            )}
          </div>
          
          {showExport && (
            <div className="flex items-center space-x-2">
              <button
                onClick={exportToCSV}
                className="px-3 py-1 text-xs sm:text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                Export CSV
              </button>
              <button
                onClick={exportToJSON}
                className="px-3 py-1 text-xs sm:text-sm bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
              >
                Export JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Search and Stats */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between space-y-2 sm:space-y-0">
          <div className="flex items-center space-x-4">
            <div className="relative">
              <input
                type="text"
                placeholder="Search data..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 pr-3 py-1 text-xs sm:text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <span className="absolute left-2 top-1.5 text-gray-400 text-xs">🔍</span>
            </div>
            <div className="text-xs sm:text-sm text-gray-600">
              {filteredAndSortedData.length} of {data.length} records
            </div>
          </div>
          
          {showPagination && totalPages > 1 && (
            <div className="flex items-center space-x-2 text-xs sm:text-sm">
              <span className="text-gray-600">
                Page {currentPage} of {totalPages}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <div style={{ maxHeight, overflowY: 'auto' }}>
          <table className="w-full text-xs sm:text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={`px-3 py-2 text-left font-medium text-gray-700 cursor-pointer hover:bg-gray-100 transition-colors ${
                      sortColumn === column.key ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => handleSort(column.key)}
                    style={{ minWidth: column.width }}
                  >
                    <div className="flex items-center space-x-1">
                      <span>{column.label}</span>
                      {sortColumn === column.key && (
                        <span className="text-blue-600">
                          {sortDirection === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {paginatedData.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="hover:bg-gray-50 transition-colors"
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-3 py-2 text-gray-900 ${
                        column.type === 'number' || column.type === 'currency' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {formatCellValue(row[column.key], column.type)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {showPagination && totalPages > 1 && (
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center justify-between">
            <div className="text-xs sm:text-sm text-gray-600">
              Showing {startIndex + 1} to {Math.min(endIndex, filteredAndSortedData.length)} of {filteredAndSortedData.length} results
            </div>
            
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="px-2 py-1 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              
              <div className="flex items-center space-x-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={`px-2 py-1 text-xs sm:text-sm rounded ${
                        currentPage === pageNum
                          ? 'bg-blue-600 text-white'
                          : 'border border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              
              <button
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                className="px-2 py-1 text-xs sm:text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 