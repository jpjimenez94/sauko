import { exigirPin } from "../lib/comun.js";
import { leerAjustes, guardarAjustes, leerBitacora } from "../lib/store.js";
import { hayWhatsApp } from "../lib/whatsapp.js";

// Interruptores del panel. Por ahora uno: si el asistente contesta o no por WhatsApp.
export default async function handler(req, res) {
  if (!exigirPin(req, res)) return;
  try {
    if (req.method === "GET") {
      const base = { ...(await leerAjustes()), whatsappConectado: hayWhatsApp() };
      return res.status(200).json(req.query?.bitacora ? { ...base, bitacora: await leerBitacora() } : base);
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
