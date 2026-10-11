// WhatsApp Cloud API (Meta): enviar texto, bajar la foto que mandó el cliente y validar la firma del webhook.
import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH = "https://graph.facebook.com/v21.0";
export const hayWhatsApp = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

export async function enviarTexto(telefono, texto) {
  if (!hayWhatsApp()) return false;
  const respuesta = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: telefono, type: "text", text: { body: String(texto).slice(0, 4000) } }),
  });
  if (!respuesta.ok) console.error("whatsapp envío:", respuesta.status, await respuesta.text());
  return respuesta.ok;
}

/** Baja una imagen recibida. Devuelve { mediaType, base64 } o null si no se pudo o pesa demasiado. */
export async function bajarImagen(mediaId) {
  if (!hayWhatsApp()) return null;
  const cabeceras = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const ficha = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: cabeceras }).then((r) => (r.ok ? r.json() : null));
  if (!ficha?.url || !["image/jpeg", "image/png", "image/webp"].includes(ficha.mime_type)) return null;
  const archivo = await fetch(ficha.url, { headers: cabeceras });
  if (!archivo.ok) return null;
  const bytes = Buffer.from(await archivo.arrayBuffer());
  if (bytes.length > 3_000_000) return null;
  return { mediaType: ficha.mime_type, base64: bytes.toString("base64") };
}

/** Meta firma cada aviso con el App Secret. Sin esa firma cualquiera podría inventar mensajes. */
export function firmaValida(crudo, cabecera) {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto) return !process.env.VERCEL; // en local se puede probar sin firma
  const esperada = "sha256=" + createHmac("sha256", secreto).update(crudo).digest("hex");
  const a = Buffer.from(String(cabecera ?? ""));
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}
