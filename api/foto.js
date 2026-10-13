import { readFileSync } from "node:fs";
import { CATALOGO } from "../lib/comun.js";

// La foto de un producto como imagen suelta (/api/foto?sku=...), para poder enviarla por WhatsApp.
// La página no la usa: allá las fotos llegan en paquetes por categoría (public/fotos-N.json).
const paquetes = new Map();
function paquete(tipo) {
  if (!paquetes.has(tipo)) {
    try {
      paquetes.set(tipo, JSON.parse(readFileSync(new URL(`../public/fotos-${tipo}.json`, import.meta.url), "utf8")));
    } catch {
      paquetes.set(tipo, {});
    }
  }
  return paquetes.get(tipo);
}

export default function handler(req, res) {
  const sku = String(req.query?.sku ?? "");
  const producto = CATALOGO.get(sku);
  const partes = producto?.foto ? /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(paquete(producto.tipo)[sku] ?? "")) : null;
  if (!partes) return res.status(404).json({ error: "Ese producto no tiene foto." });
  res.setHeader("Content-Type", partes[1]);
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.status(200).end(Buffer.from(partes[2], "base64"));
}
