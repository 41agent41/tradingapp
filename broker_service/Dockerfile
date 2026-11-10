# Multi-stage Dockerfile for IB Service with optimization  
FROM python:3.11-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory and copy requirements
WORKDIR /app
COPY requirements.txt ./

# Install exactly the pinned versions in requirements.txt (compiled from
# requirements.in), so every build gets the reviewed set.
RUN pip install --no-cache-dir -r requirements.txt

# Production stage
FROM python:3.11-slim

# Set timezone to UTC for consistent timestamp handling
ENV TZ=UTC
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install runtime dependencies including timezone data
RUN apt-get update && apt-get install -y \
    curl \
    tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create a non-root user first
RUN useradd --create-home --shell /bin/bash --uid 1000 ibservice

WORKDIR /app

# Copy installed packages from builder stage
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Set up Python path
ENV PATH=/usr/local/bin:$PATH
ENV PYTHONPATH=/app:/usr/local/lib/python3.11/site-packages

# Copy application code as root (needed for proper permissions)
COPY . .

# Fix ownership after copying all files
RUN chown -R ibservice:ibservice /app

# Fail the build if the pinned install is incomplete, rather than
# installing unpinned packages on top.
RUN python -c "import fastapi, ibapi, uvicorn; print('FastAPI version:', fastapi.__version__)"

# Switch to non-root user
USER ibservice

# Health check - using simple endpoint that doesn't trigger IB connections
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://0.0.0.0:8000/ || exit 1

# Expose port
EXPOSE 8000

# Use environment variables for configuration
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

# Timezone configuration for consistent timestamp handling
ENV TZ=UTC
ENV IB_TIMEZONE=UTC
ENV EXPECTED_TIMESTAMP_FORMAT=unix_seconds
ENV DATA_TIMEZONE=UTC
ENV IB_FORMAT_DATE=2

# Brokers are added in the app (Settings > Connections), which sends them
# here; nothing about a broker is set in the image or by compose.
ENV IB_LOG_LEVEL=INFO

# Run the improved application
CMD ["python", "main.py"] 