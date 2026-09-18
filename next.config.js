/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  webpack: (config, { isServer }) => {
    config.experiments = {
      asyncWebAssembly: true,
      topLevelAwait: true,
      layers: true, // optional, with some bundlers/frameworks it doesn't work without
    }
    if (isServer) {
      const prev = config.externals
      config.externals = [
        ...(Array.isArray(prev) ? prev : prev ? [prev] : []),
        {
          '@anastasia-labs/cardano-multiplatform-lib-nodejs':
            'commonjs @anastasia-labs/cardano-multiplatform-lib-nodejs',
        },
      ]
    }
    return config
  },
  // headers: async () => [
  //   {
  //     source: "/api/blockfrost/0",
  //     headers: [
  //       {
  //         key: 'project_id',
  //         value: `${process.env.BLOCKFROST_PROJECT_ID_PREPROD}`
  //       }
  //     ]
  //   }
  // ],
  // rewrites: async () => [
  //   {
  //     source: "/api/blockfrost/0",
  //     destination: "https://cardano-preprod.blockfrost.io/api/v0"
  //   }
  // ]
}

module.exports = nextConfig
