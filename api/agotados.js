import { CATALOGO } from "../lib/comun.js";
import { exigirSesion } from "../lib/usuarios.js";
import { leerAgotados, guardarAgotados, leerExistencias, fijarExistencia, noDisponibles } from "../lib/store.js";

// Disponibilidad de los productos.
// - La página solo recibe qué no se puede vender (marcado agotado o sin unidades): nunca las cantidades.
// - El panel (?panel=1, con sesión) recibe lo marcado a mano y las unidades de cada producto controlado.
// Para que la página no deje pedir más de lo que hay: el tope por producto cuando quedan pocas.
// No se muestra al cliente; solo limita el botón de agregar.
function topes(existencias) {
  const mapa = {};
  for (const sku in existencias) if (existencias[sku] > 0 && existencias[sku] < 99) mapa[sku] = existencias[sku];
  return mapa;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const [agotados, existencias] = await Promise.all([leerAgotados(), leerExistencias()]);
      if (!req.query?.panel) return res.status(200).json({ skus: noDisponibles(agotados, existencias), topes: topes(existencias) });
      if (!(await exigirSesion(req, res))) return;
      return res.status(200).json({ agotados, existencias });
    }
    if (req.method === "POST") {
      if (!(await exigirSesion(req, res))) return;
      if (req.body?.skus) {
        const skus = {};
        for (const sku of Object.keys(req.body.skus).slice(0, 3000)) if (CATALOGO.has(sku)) skus[sku] = true;
        await guardarAgotados(skus);
      }
      // Conteo de un producto: un número de unidades, o null para dejar de controlarlo.
      const conteo = req.body?.existencia;
      if (conteo && CATALOGO.has(String(conteo.sku))) {
        const unidades = conteo.unidades === null || conteo.unidades === "" ? null : Math.floor(Number(conteo.unidades));
        if (unidades !== null && !(unidades >= 0 && unidades <= 99999)) return res.status(400).json({ error: "Cantidad no válida." });
        await fijarExistencia(String(conteo.sku), unidades);
      }
      const [agotados, existencias] = await Promise.all([leerAgotados(), leerExistencias()]);
      return res.status(200).json({ agotados, existencias, skus: noDisponibles(agotados, existencias), topes: topes(existencias) });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("agotados:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
