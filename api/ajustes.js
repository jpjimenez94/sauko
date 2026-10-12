import { exigirPin } from "../lib/comun.js";
import { leerAjustes, guardarAjustes, leerBitacora } from "../lib/store.js";
import { hayWhatsApp } from "../lib/whatsapp.js";

// Interruptores del panel. Por ahora uno: si el asistente contesta o no por WhatsApp.
export default async function handler(req, res) {
  if (!exigirPin(req, res)) return;
  try {
    if (req.method === "GET") {
      const base = { ...(await leerAjustes()), whatsappConectado: hayWhatsApp() };
      if (!req.query?.bitacora) return res.status(200).json(base);
      // Para diagnosticar: la lista de prueba tal como la ve el servidor y los últimos pasos del canal.
      return res.status(200).json({ ...base, listaDePrueba: process.env.WHATSAPP_SOLO_NUMEROS ?? null, bitacora: await leerBitacora() });
    }
    if (req.method === "POST") {
      const ajustes = await guardarAjustes({ ...(await leerAjustes()), whatsappActivo: req.body?.whatsappActivo === true });
      return res.status(200).json({ ...ajustes, whatsappConectado: hayWhatsApp() });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("ajustes:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
