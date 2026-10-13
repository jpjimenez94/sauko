import { dentroDelTope } from "../lib/comun.js";
import { exigirSesion } from "../lib/usuarios.js";
import { leerSolicitados, anotarSolicitado, quitarSolicitado } from "../lib/store.js";

// Productos que los clientes piden y no están en el catálogo.
// Anotar es público (lo hace el asistente desde el chat de la página); ver y quitar es del panel.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      if (!dentroDelTope(req)) return res.status(429).json({ error: "Demasiadas solicitudes." });
      const anotado = await anotarSolicitado(String(req.body?.producto ?? "").slice(0, 80), "Web");
      return res.status(200).json({ anotado });
    }
    if (!(await exigirSesion(req, res))) return;
    if (req.method === "GET") return res.status(200).json({ solicitados: (await leerSolicitados()).sort((a, b) => b.veces - a.veces || b.ultima - a.ultima) });
    if (req.method === "DELETE") {
      await quitarSolicitado(String(req.query?.clave ?? "").slice(0, 80));
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("solicitados:", error);
    return res.status(500).json({ error: "No se pudo completar. Intenta de nuevo." });
  }
}
