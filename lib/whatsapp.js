// WhatsApp: enviar texto, bajar la foto que mandó el cliente y validar la firma de cada aviso.
// Hay dos caminos y se usa el que tenga sus variables: YCloud (proveedor, permite que el número
// siga también en la app WhatsApp Business) o la Cloud API de Meta directa.
import { createHmac, timingSafeEqual } from "node:crypto";
import { anotar } from "./store.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const YCLOUD = "https://api.ycloud.com/v2";
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp"];

const porYCloud = () => Boolean(process.env.YCLOUD_API_KEY && process.env.YCLOUD_FROM);
const porMeta = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
export const hayWhatsApp = () => porYCloud() || porMeta();

function iguales(recibido, esperado) {
  const a = Buffer.from(String(recibido ?? ""));
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function enviarTexto(telefono, texto) {
  const cuerpo = String(texto).slice(0, 4000);
  let respuesta;
  if (porYCloud()) {
    respuesta = await fetch(`${YCLOUD}/whatsapp/messages/sendDirectly`, {
      method: "POST",
      headers: { "X-API-Key": process.env.YCLOUD_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.YCLOUD_FROM, to: telefono, type: "text", text: { body: cuerpo } }),
    });
  } else if (porMeta()) {
    respuesta = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: telefono, type: "text", text: { body: cuerpo } }),
    });
  } else return false;
  if (respuesta.ok) return true;
  const motivo = `${respuesta.status} ${(await respuesta.text()).slice(0, 250)}`;
  console.error("whatsapp envío:", motivo);
  await anotar("envío falló", motivo);
  return false;
}

async function aImagen(respuesta, mediaType) {
  if (!respuesta.ok || !TIPOS_IMAGEN.includes(mediaType)) return null;
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  return bytes.length > 3_000_000 ? null : { mediaType, base64: bytes.toString("base64") };
}

/** Imagen recibida por Meta. Devuelve { mediaType, base64 } o null si no se pudo o pesa demasiado. */
export async function bajarImagen(mediaId) {
  if (!porMeta()) return null;
  const cabeceras = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const ficha = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: cabeceras }).then((r) => (r.ok ? r.json() : null));
  if (!ficha?.url) return null;
  return aImagen(await fetch(ficha.url, { headers: cabeceras }), ficha.mime_type);
}

/** Imagen recibida por YCloud: el aviso trae un enlace de descarga en su propio dominio. */
export async function bajarImagenYCloud(imagen) {
  let enlace;
  try {
    enlace = new URL(imagen?.link);
  } catch {
    return null;
  }
  if (enlace.protocol !== "https:" || !enlace.hostname.endsWith(".ycloud.com")) return null; // la clave solo viaja a YCloud
  const respuesta = await fetch(enlace, { headers: { "X-API-Key": process.env.YCLOUD_API_KEY } });
  return aImagen(respuesta, String(imagen.mime_type || respuesta.headers.get("content-type") || "").split(";")[0]);
}

/** Meta firma cada aviso con el App Secret. Sin esa firma cualquiera podría inventar mensajes. */
export function firmaValida(crudo, cabecera) {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto) return !process.env.VERCEL; // en local se puede probar sin firma
  return iguales(cabecera, "sha256=" + createHmac("sha256", secreto).update(crudo).digest("hex"));
}

/** YCloud firma con el secreto del webhook: cabecera "t=<segundos>,s=<hmac de 't.cuerpo'>". */
export function firmaYCloudValida(crudo, cabecera, ahora = Date.now()) {
  const secreto = process.env.YCLOUD_WEBHOOK_SECRET;
  if (!secreto) return !process.env.VERCEL;
  const partes = Object.fromEntries(String(cabecera ?? "").split(",").map((p) => p.trim().split("=")));
  const t = Number(partes.t);
  if (!Number.isFinite(t) || Math.abs(ahora / 1000 - t) > 300) return false; // avisos viejos no cuentan
  return iguales(partes.s, createHmac("sha256", secreto).update(`${partes.t}.${crudo}`).digest("hex"));
}
