import { exigirSesion } from "../lib/usuarios.js";
import { cargarNegocio, negocioLimpio } from "../lib/comun.js";
import { leerAjustes, guardarAjustes, leerBitacora, contarPromos } from "../lib/store.js";
import { hayWhatsApp } from "../lib/whatsapp.js";

// Ajustes del panel: el interruptor del asistente de WhatsApp y los parámetros del negocio
// (horario y valor del domicilio, cuenta para transferir, lista de prueba, pausa).
// Cualquier usuario del panel ve el interruptor; solo un administrador ve y cambia lo demás.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const yo = await exigirSesion(req, res, req.query?.bitacora ? ["admin"] : undefined);
      if (!yo) return;
      const { whatsappActivo } = await leerAjustes();
      const base = { whatsappActivo, whatsappConectado: hayWhatsApp() };
      if (yo.rol !== "admin") return res.status(200).json(base);
      const negocio = await cargarNegocio(true);
      if (!req.query?.bitacora) return res.status(200).json({ ...base, negocio, promos: await contarPromos() });
      // Para diagnosticar: los últimos pasos del canal de WhatsApp.
      return res.status(200).json({ ...base, negocio, listaDePrueba: negocio.listaDePrueba, bitacora: await leerBitacora() });
    }
    if (req.method === "POST") {
      if (!(await exigirSesion(req, res, ["admin"]))) return;
      const ajustes = await leerAjustes();
      if (typeof req.body?.whatsappActivo === "boolean") ajustes.whatsappActivo = req.body.whatsappActivo;
      // Lo que no venga en el formulario conserva el valor vigente.
      if (req.body?.negocio && typeof req.body.negocio === "object") ajustes.negocio = negocioLimpio(req.body.negocio, await cargarNegocio(true));
      await guardarAjustes(ajustes);
      return res.status(200).json({ whatsappActivo: ajustes.whatsappActivo, whatsappConectado: hayWhatsApp(), negocio: await cargarNegocio(true) });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("ajustes:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
