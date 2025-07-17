/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: {
    HOSTNAME: '0.0.0.0',
  },
  // Ensure static assets are properly generated and served
  trailingSlash: false,
  generateEtags: false,
  // Force static optimization
  experimental: {
    esmExternals: false
  }
}

module.exports = nextConfig 