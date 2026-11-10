/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    HOSTNAME: '0.0.0.0',
  },
  trailingSlash: false,
  generateEtags: false,
  assetPrefix: '',
};

module.exports = nextConfig;
