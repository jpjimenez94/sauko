import { leerEstanteria, hayClave } from "../lib/agente.js";
import { exigirPin } from "../lib/comun.js";

// Control de estantería: recibe una foto desde el panel y devuelve los productos reconocidos.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!exigirPin(req, res)) return;
  if (!hayClave()) return res.status(503).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor." });
  const partes = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.imagen ?? ""));
  if (!partes || partes[2].length > 3_500_000) return res.status(400).json({ error: "Imagen no válida o muy pesada." });
  try {
    return res.status(200).json(await leerEstanteria(partes[1], partes[2]));
  } catch (error) {
    console.error("estanteria:", error);
    return res.status(502).json({ error: "No se pudo analizar la foto. Intenta de nuevo." });
  }
}
