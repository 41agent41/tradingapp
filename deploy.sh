#!/bin/bash

# TradingApp Remote Server Deployment Script
# This script helps deploy the trading app to a Debian-based server

set -e

echo "🚀 TradingApp Deployment Script (Debian)"
echo "========================================="

# Function to install Docker
install_docker() {
    echo "🐳 Installing Docker..."
    
    # Update package index
    sudo apt-get update
    
    # Install prerequisites
    sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
    
    # Add Docker's official GPG key
    curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
    
    # Add Docker repository
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Install Docker
    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io
    
    # Add user to docker group
    sudo usermod -aG docker $USER
    
    echo "✅ Docker installed successfully!"
}

# Function to install Docker Compose
install_docker_compose() {
    echo "🐙 Installing Docker Compose..."
    
    # Try package manager installation first (more reliable)
    echo "📦 Installing via package manager..."
    if sudo apt-get install -y docker-compose-plugin &> /dev/null; then
        # Create symlink for docker-compose command
        sudo ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose
        echo "✅ Docker Compose installed via package manager!"
        docker-compose --version
        return 0
    fi
    
    echo "📦 Package manager installation failed, trying direct download..."
    
    # Detect architecture
    ARCH=$(uname -m)
    case $ARCH in
        x86_64) ARCH="x86_64" ;;
        aarch64) ARCH="aarch64" ;;
        armv7l) ARCH="armv7" ;;
        *) echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    
    # Download and install Docker Compose
    COMPOSE_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}"
    echo "📥 Downloading Docker Compose from: $COMPOSE_URL"
    
    sudo curl -L "$COMPOSE_URL" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    
    # Verify installation
    if docker-compose --version &> /dev/null; then
        echo "✅ Docker Compose installed successfully!"
        docker-compose --version
    else
        echo "❌ Docker Compose installation failed"
        exit 1
    fi
}

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Installing now..."
    install_docker
    echo "✅ Docker installed successfully!"
    echo "🔄 Please log out and log back in, or restart your terminal, then run this script again."
    echo "This is needed for the docker group changes to take effect."
    echo ""
    echo "After restarting, run: ./deploy.sh"
    exit 0
else
    echo "✅ Docker is already installed"
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Installing now..."
    install_docker_compose
else
    echo "✅ Docker Compose is already installed"
    docker-compose --version
fi

# Verify Docker is running
if ! docker info &> /dev/null; then
    echo "❌ Docker is not running. Starting Docker..."
    sudo systemctl start docker
    sudo systemctl enable docker
fi

# Setup environment file
echo "🔧 Setting up environment..."
chmod +x setup-env.sh
./setup-env.sh

# Build and start services with better output handling
echo "🔨 Building and starting services..."
echo "📝 Note: Some npm warnings are normal during Docker builds and won't affect functionality."
echo ""

# Clean up any existing containers to avoid conflicts
echo "🧹 Cleaning up existing containers..."
docker-compose down --remove-orphans 2>/dev/null || true

# Build with reduced output for warnings
docker-compose up --build -d 2>&1 | grep -v "npm warn deprecated" | grep -v "npm WARN deprecated" || true

echo ""
echo "✅ Deployment completed!"
echo ""
echo "📋 Service URLs:"
echo "   Frontend: http://$(hostname -I | awk '{print $1}'):3000"
echo "   Backend:  http://$(hostname -I | awk '{print $1}'):4000"
echo "   IB Service: http://$(hostname -I | awk '{print $1}'):8000"
echo ""
echo "🔧 To view logs: docker-compose logs -f"
echo "🛑 To stop services: docker-compose down"
echo "🔄 To restart services: docker-compose restart"
echo ""
echo "⚠️  IMPORTANT: Update your .env file with the correct NEXT_PUBLIC_API_URL"
echo "   Current value: $(grep NEXT_PUBLIC_API_URL .env | cut -d'=' -f2)"
echo ""
echo "📊 Check service status:"
docker-compose ps 