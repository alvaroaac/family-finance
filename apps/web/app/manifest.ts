import type { MetadataRoute } from "next";

import { DEFAULT_THEME, themeBackground } from "./(app)/settings/helpers";

/**
 * Every URL is relative on purpose: the app is served from several hosts and
 * a relative manifest is valid on each of them.
 */
export default function manifest(): MetadataRoute.Manifest {
  const esmeralda = themeBackground(DEFAULT_THEME);
  return {
    name: "Casa",
    short_name: "Casa",
    display: "standalone",
    start_url: "/",
    scope: "/",
    background_color: esmeralda,
    theme_color: esmeralda,
    icons: [
      { src: "/icons/casa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/casa-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/casa-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [{ name: "Novo lançamento", url: "/capture" }],
  };
}
