/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: {
    HOSTNAME: '0.0.0.0',
  },
}

module.exports = nextConfig 