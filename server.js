// Servidor local: sirve /public y monta las funciones de /api con la misma firma (req, res)
// que usa Vercel. En Vercel no se usa: /api y /public se despliegan solos.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("./public", import.meta.url));
const PORT = process.env.PORT || 3000;
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};
const rutas = {
  "/api/chat": () => import("./api/chat.js"),
  "/api/orders": () => import("./api/orders.js"),
  "/api/agotados": () => import("./api/agotados.js"),
  "/api/estanteria": () => import("./api/estanteria.js"),
  "/api/whatsapp": () => import("./api/whatsapp.js"),
  "/api/ycloud": () => import("./api/ycloud.js"),
  "/api/ajustes": () => import("./api/ajustes.js"),
  "/api/config": () => import("./api/config.js"),
  "/api/sesion": () => import("./api/sesion.js"),
  "/api/usuarios": () => import("./api/usuarios.js"),
  "/api/solicitados": () => import("./api/solicitados.js"),
};

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let datos = "";
    req.on("data", (trozo) => (datos += trozo));
    req.on("end", () => {
      req.rawBody = datos;
      try {
        resolve(datos ? JSON.parse(datos) : {});
      } catch {
        resolve({});
      }
    });
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (rutas[url.pathname]) {
    req.query = Object.fromEntries(url.searchParams);
    req.body = ["POST", "PATCH"].includes(req.method) ? await leerCuerpo(req) : {};
    res.status = (codigo) => ((res.statusCode = codigo), res);
    res.json = (objeto) => (res.setHeader("Content-Type", TIPOS[".json"]), res.end(JSON.stringify(objeto)));
    res.send = (texto) => res.end(String(texto ?? ""));
    const { default: handler } = await rutas[url.pathname]();
    return handler(req, res);
  }

  const relativa = url.pathname === "/" ? "/index.html" : url.pathname;
  const archivo = normalize(join(raiz, relativa));
  if (!archivo.startsWith(raiz)) return res.writeHead(403).end();
  try {
    const contenido = await readFile(extname(archivo) ? archivo : `${archivo}.html`);
    res.writeHead(200, { "Content-Type": TIPOS[extname(archivo) || ".html"] ?? "application/octet-stream" });
    res.end(contenido);
  } catch {
    res.writeHead(404, { "Content-Type": TIPOS[".html"] }).end("No encontrado");
  }
}).listen(PORT, () => console.log(`Sauko en http://localhost:${PORT}`));
