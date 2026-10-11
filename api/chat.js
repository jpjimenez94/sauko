import Anthropic from "@anthropic-ai/sdk";
import { paso, hayClave } from "../lib/agente.js";
import { dentroDelTope } from "../lib/comun.js";

const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp"];
const BLOQUES = ["text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking"];

function mensajesValidos(mensajes) {
  if (!Array.isArray(mensajes) || !mensajes.length || mensajes.length > 60) return false;
  if (mensajes[0].role !== "user" || mensajes.at(-1).role !== "user") return false;
  return mensajes.every((m) => {
    if (m.role !== "user" && m.role !== "assistant") return false;
    if (typeof m.content === "string") return m.content.length > 0 && m.content.length <= 6000;
    if (!Array.isArray(m.content) || !m.content.length || m.content.length > 20) return false;
    return m.content.every((b) => {
      if (!b || !BLOQUES.includes(b.type)) return false;
      if (b.type !== "image") return true;
      // Las imágenes solo las manda el cliente, en base64 y ya reducidas por la página.
      return m.role === "user" && b.source?.type === "base64" && TIPOS_IMAGEN.includes(b.source.media_type) && typeof b.source.data === "string" && b.source.data.length <= 2_000_000;
    });
  });
}

// Un paso del asistente. La página ejecuta las herramientas y vuelve a llamar con los resultados.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const mensajes = req.body?.mensajes;
  if (!mensajesValidos(mensajes)) return res.status(400).json({ error: "Conversación no válida" });
  if (!hayClave()) return res.status(503).json({ error: "Falta configurar ANTHROPIC_API_KEY en el servidor." });
  if (!dentroDelTope(req)) return res.status(429).json({ error: "Hay muchos mensajes seguidos. Intenta en un momento." });

  try {
    const { content, stop_reason } = await paso(mensajes);
    if (stop_reason === "refusal") {
      return res.status(200).json({ content: [{ type: "text", text: "Qué pena veci, con eso no te puedo ayudar por acá. ¿Te armo un pedido?" }], stop_reason: "end_turn" });
    }
    return res.status(200).json({ content, stop_reason });
  } catch (error) {
    console.error("chat:", error);
    if (error instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "El asistente está muy ocupado. Intenta en un momento." });
    if (error instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "La clave de IA del servidor no es válida." });
    // El motivo técnico ayuda a diagnosticar la configuración; no incluye la clave.
    const motivo = error instanceof Anthropic.APIError ? `${error.status} ${error.error?.error?.type ?? ""}: ${String(error.error?.error?.message ?? error.message).slice(0, 200)}` : String(error?.message ?? error).slice(0, 200);
    return res.status(502).json({ error: "El asistente no pudo responder. Intenta de nuevo.", motivo });
  }
}
