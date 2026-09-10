import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../dist-e2e", import.meta.url));
http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      const proxy = http.request(
        {
          hostname: "127.0.0.1",
          port: 3109,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: "127.0.0.1:3109" },
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.writeHead(502);
        res.end("API unavailable");
      });
      req.pipe(proxy);
      return;
    }
    try {
      let file = path.resolve(
        root,
        "." + decodeURIComponent(req.url.split("?")[0]),
      );
      if (!file.startsWith(root + "/") && file !== root) throw Error();
      if (file === root) file += "/index.html";
      const data = await readFile(file);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".ttf": "font/ttf",
          ".png": "image/png",
        }[path.extname(file)] || "application/octet-stream",
      );
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(8087, "127.0.0.1");
