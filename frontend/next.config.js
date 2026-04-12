// Bundle analyzer for visualizing bundle size
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: true,
});

const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: false,
  },
  // Image optimization configuration
  images: {
    // Enable modern image formats
    formats: ['image/avif', 'image/webp'],
    // Allow images from these domains
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
      },
      {
        protocol: 'https',
        hostname: '*.nvidia.com',
      },
      {
        protocol: 'https',
        hostname: '*.nvcf.nvidia.com',
      },
    ],
    // Device sizes for responsive images
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
    // Image sizes for responsive images
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    // Minimize layout shift with blur placeholder
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  // Extend proxy timeout so long-running API routes (document processing)
  // are not killed by Next.js's internal HTTP proxy before the route completes.
  httpAgentOptions: {
    keepAlive: true,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "150mb", // Support large file uploads (documents up to 100MB + base64 overhead)
    },
    proxyTimeout: 900_000, // 15 minutes — matches nginx and API route timeouts
    optimizeCss: true, // Enable CSS optimization
  },
  // Optimize bundle splitting
  modularizeImports: {
    '@tabler/icons-react': {
      transform: '@tabler/icons-react/dist/esm/icons/{{member}}',
    },
    'lucide-react': {
      transform: 'lucide-react/dist/esm/icons/{{kebabCase member}}',
    },
    'lodash': {
      transform: 'lodash/{{member}}',
    },
  },
  webpack(config, { isServer, dev }) {
    config.experiments = {
      asyncWebAssembly: true,
      layers: true,
    };

    // Split chunks optimization
    if (!isServer) {
      config.optimization = {
        ...config.optimization,
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            default: false,
            vendors: false,
            framework: {
              name: 'framework',
              chunks: 'all',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler|next)[\\/]/,
              priority: 50,
              enforce: true,
            },
            lib: {
              test: /[\\/]node_modules[\\/]/,
              name(module) {
                const packageName = module.context.match(
                  /[\\/]node_modules[\\/](.*?)([[\\/]|$)/
                )[1];
                return `npm.${packageName.replace('@', '')}`;
              },
              priority: 10,
              minChunks: 2,
              reuseExistingChunk: true,
            },
            commons: {
              name: 'commons',
              minChunks: 2,
              priority: 5,
            },
          },
        },
      };
    }

    return config;
  },
  async redirects() {
    return [
    ]
  },
  // PWA configuration
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          {
            key: 'Service-Worker-Allowed',
            value: '/',
          },
          {
            key: 'Cache-Control',
            value: 'no-cache',
          },
        ],
      },
      // SECURITY: Restrict outbound connections and prevent common web attacks
      // NOTE: 'unsafe-eval' is required by mermaid.js (diagram rendering) even with securityLevel: 'strict'.
      // 'unsafe-inline' is required by Next.js for inline scripts and styled-jsx.
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.nvidia.com https://*.nvcf.nvidia.com; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
          },
        ],
      },
    ];
  },
};

module.exports = withBundleAnalyzer(nextConfig);
