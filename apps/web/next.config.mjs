/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@family-finance/domain",
    "@family-finance/db",
    "@family-finance/config"
  ]
};

export default nextConfig;
