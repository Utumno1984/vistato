import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // The upload form posts a file of up to 5 MB (plus multipart framing) to a Server Action;
    // the default limit is 1 MB. Bigger files are refused by the form and by the service.
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
