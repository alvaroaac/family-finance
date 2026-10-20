import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-body" }),
  Playfair_Display: () => ({ variable: "font-display" }),
}));
vi.mock("../lib/auth", () => ({ getAuthState: async () => ({}) }));
vi.mock("../lib/member", () => ({
  currentHouseholdOrFallback: async () => ({}),
}));

const { default: manifest } = await import("./manifest");
const { metadata } = await import("./layout");

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");

function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(join(PUBLIC_DIR, file));
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

describe("web app manifest", () => {
  const result = manifest();

  it("installs as a standalone app named Casa", () => {
    expect(result).toMatchObject({
      name: "Casa",
      short_name: "Casa",
      display: "standalone",
      start_url: "/",
      scope: "/",
    });
  });

  it("uses the Esmeralda background for splash and theme", () => {
    expect(result.background_color).toBe("#16352B");
    expect(result.theme_color).toBe("#16352B");
  });

  it("declares 192, 512 and maskable 512 icons that exist at that size", () => {
    expect(result.icons).toEqual([
      { src: "/icons/casa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/casa-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/casa-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
    expect(pngSize("icons/casa-192.png")).toEqual({ width: 192, height: 192 });
    expect(pngSize("icons/casa-512.png")).toEqual({ width: 512, height: 512 });
    expect(pngSize("icons/casa-512-maskable.png")).toEqual({
      width: 512,
      height: 512,
    });
  });

  it("offers a Novo lançamento shortcut to /capture", () => {
    expect(result.shortcuts).toEqual([
      { name: "Novo lançamento", url: "/capture" },
    ]);
  });

  it("keeps every URL relative so it is valid on every host", () => {
    const urls = [
      result.start_url,
      result.scope,
      ...(result.icons ?? []).map((icon) => icon.src),
      ...(result.shortcuts ?? []).map((shortcut) => shortcut.url),
    ];
    for (const url of urls) {
      expect(url).toMatch(/^\/(?!\/)/);
    }
  });
});

describe("root layout metadata", () => {
  it("marks the page as an installable iOS web app", () => {
    expect(metadata.appleWebApp).toEqual({
      capable: true,
      title: "Casa",
      statusBarStyle: "default",
    });
  });
});
