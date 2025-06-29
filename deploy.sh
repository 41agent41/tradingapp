#!/bin/bash

# TradingApp Remote Server Deployment Script
# This script helps deploy the trading app to a remote server

set -e

echo "🚀 TradingApp Deployment Script"
echo "================================"

# Function to detect OS
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            OS=$NAME
            VER=$VERSION_ID
        else
            OS=$(uname -s)
            VER=$(uname -r)
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macOS"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        OS="Windows"
    else
        OS="Unknown"
    fi
    echo "Detected OS: $OS"
}

# Function to install Docker
install_docker() {
    echo "🐳 Installing Docker..."
    
    if [[ "$OS" == "Ubuntu"* ]] || [[ "$OS" == "Debian"* ]]; then
        # Update package index
        sudo apt-get update
        
        # Install prerequisites
        sudo apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
        
        # Add Docker's official GPG key
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
        
        # Add Docker repository
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
        
        # Install Docker
        sudo apt-get update
        sudo apt-get install -y docker-ce docker-ce-cli containerd.io
        
        # Add user to docker group
        sudo usermod -aG docker $USER
        
    elif [[ "$OS" == "CentOS"* ]] || [[ "$OS" == "Red Hat"* ]] || [[ "$OS" == "Fedora"* ]]; then
        # Install Docker on CentOS/RHEL/Fedora
        sudo yum install -y yum-utils
        sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        sudo yum install -y docker-ce docker-ce-cli containerd.io
        sudo systemctl start docker
        sudo systemctl enable docker
        sudo usermod -aG docker $USER
        
    elif [[ "$OS" == "macOS" ]]; then
        echo "📱 Please install Docker Desktop for macOS from https://docs.docker.com/desktop/install/mac-install/"
        echo "After installation, restart your terminal and run this script again."
        exit 1
        
    else
        echo "❌ Automatic Docker installation not supported for $OS"
        echo "Please install Docker manually from https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    echo "✅ Docker installed successfully!"
}

# Function to install Docker Compose
install_docker_compose() {
    echo "🐙 Installing Docker Compose..."
    
    # Install Docker Compose
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    
    echo "✅ Docker Compose installed successfully!"
}

# Detect OS
detect_os

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Installing now..."
    install_docker
    echo "🔄 Please log out and log back in, or restart your terminal, then run this script again."
    echo "This is needed for the docker group changes to take effect."
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
fi

# Verify Docker is running
if ! docker info &> /dev/null; then
    echo "❌ Docker is not running. Starting Docker..."
    if [[ "$OS" == "macOS" ]]; then
        echo "Please start Docker Desktop manually"
        exit 1
    else
        sudo systemctl start docker
        sudo systemctl enable docker
    fi
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