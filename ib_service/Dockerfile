# Multi-stage Dockerfile for IB Service with optimization
FROM python:3.11-slim as builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install dependencies
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

# Production stage
FROM python:3.11-slim

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /app

# Copy installed packages from builder stage
COPY --from=builder /root/.local /root/.local

# Make sure scripts in .local are usable
ENV PATH=/root/.local/bin:$PATH

# Create a non-root user
RUN useradd --create-home --shell /bin/bash --uid 1000 ibservice

# Copy application code
COPY . .

# Set ownership
RUN chown -R ibservice:ibservice /app

# Switch to non-root user
USER ibservice

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Expose port
EXPOSE 8000

# Use environment variables for configuration
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV IB_HOST=10.7.3.21
ENV IB_PORT=4002
ENV IB_LOG_LEVEL=INFO

# Run the improved application
CMD ["python", "main.py"] 