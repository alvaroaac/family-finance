/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@family-finance/domain",
    "@family-finance/db",
    "@family-finance/config",
    "@family-finance/categorization"
  ],
  // The shared packages are authored as NodeNext ESM TypeScript: intra-package
  // relative imports carry explicit `.js` extensions (required by `tsc` with
  // moduleResolution NodeNext). Next's webpack uses Bundler-style resolution and
  // does not rewrite those, so map `.js` specifiers back to the `.ts`/`.tsx`
  // sources during the build.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"]
    };
    return config;
  }
};

export default nextConfig;
