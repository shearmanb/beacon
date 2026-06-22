/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compile the workspace TS packages (they export src directly).
  transpilePackages: ["@beacon/core", "@beacon/db", "@beacon/shared", "@beacon/fetch", "@beacon/notify"],
  webpack: (config, { isServer }) => {
    // The workspace packages use NodeNext ".js" import specifiers that point at
    // ".ts" source. Teach webpack to resolve ".js" -> ".ts"/".tsx" first.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    // libSQL has native bindings + dynamic requires (the LICENSE/README dir
    // scan). Because @beacon/db is a transpiled package, Next's
    // serverComponentsExternalPackages doesn't reach it, so externalize the
    // libsql packages here — they're require()d from node_modules at runtime.
    if (isServer) {
      config.externals.push({
        "@libsql/client": "commonjs @libsql/client",
        libsql: "commonjs libsql",
        "@libsql/hrana-client": "commonjs @libsql/hrana-client",
      });
    }
    return config;
  },
};

export default nextConfig;
