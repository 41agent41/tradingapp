const { securityHeaders } = require('./securityHeaders');

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    HOSTNAME: '0.0.0.0',
  },
  trailingSlash: false,
  generateEtags: false,
  assetPrefix: '',
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
};

module.exports = nextConfig;
