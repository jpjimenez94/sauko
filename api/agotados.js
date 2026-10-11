import { CATALOGO, exigirPin } from "../lib/comun.js";
import { leerAgotados, guardarAgotados } from "../lib/store.js";

// Productos que la tienda marcó como agotados: la página deja de ofrecerlos.
export default async function handler(req, res) {
  try {
    if (req.method === "GET") return res.status(200).json({ skus: await leerAgotados() });
    if (req.method === "POST") {
      if (!exigirPin(req, res)) return;
      const skus = {};
      for (const sku of Object.keys(req.body?.skus ?? {}).slice(0, 3000)) if (CATALOGO.has(sku)) skus[sku] = true;
      return res.status(200).json({ skus: await guardarAgotados(skus) });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("agotados:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
