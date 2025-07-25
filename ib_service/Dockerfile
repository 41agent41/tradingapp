# Multi-stage Dockerfile for IB Service with optimization  
FROM python:3.11-slim as builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory and copy requirements
WORKDIR /app
COPY requirements.txt ./

# Install Python dependencies with verbose output for debugging
RUN pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir --user -r requirements.txt --verbose

# Production stage
FROM python:3.11-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create a non-root user first
RUN useradd --create-home --shell /bin/bash --uid 1000 ibservice

WORKDIR /app

# Copy installed packages from builder stage to both root and user locations
COPY --from=builder /root/.local /root/.local
COPY --from=builder /root/.local /home/ibservice/.local

# Set up Python path for both root and user
ENV PATH=/root/.local/bin:/home/ibservice/.local/bin:$PATH
ENV PYTHONPATH=/app:/root/.local/lib/python3.11/site-packages:/home/ibservice/.local/lib/python3.11/site-packages

# Copy application code as root (needed for proper permissions)
COPY . .

# Fix ownership after copying all files
RUN chown -R ibservice:ibservice /app /home/ibservice/.local

# Verify that fastapi is installed
RUN python -c "import fastapi; print('FastAPI version:', fastapi.__version__)" || \
    pip install fastapi uvicorn ib_async --no-cache-dir

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
# IB configuration will come from docker-compose environment variables
# ENV IB_HOST, IB_PORT, IB_CLIENT_ID set by docker-compose
ENV IB_LOG_LEVEL=INFO

# Run the improved application
CMD ["python", "main.py"] 