/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true,
  },
  output: 'standalone',
  env: {
    HOSTNAME: '0.0.0.0',
  },
}

module.exports = nextConfig 