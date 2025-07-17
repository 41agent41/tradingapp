/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    HOSTNAME: '0.0.0.0',
  },
  // Ensure static assets are properly generated and served
  trailingSlash: false,
  generateEtags: false,
  // Better asset handling
  assetPrefix: '',
  // Force static optimization
  experimental: {
    esmExternals: false
  }
}

module.exports = nextConfig 