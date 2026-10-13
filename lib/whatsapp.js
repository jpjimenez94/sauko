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
/** Distingue un número de teléfono del identificador de quien no comparte el suyo. */
export const esTelefono = (destino) => /^[+]?[0-9]+$/.test(String(destino));

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
      // Un teléfono va en "to"; el identificador de quien oculta su número va en "recipient".
      body: JSON.stringify({ from: process.env.YCLOUD_FROM, [esTelefono(telefono) ? "to" : "recipient"]: telefono, type: "text", text: { body: cuerpo } }),
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

const tipoBase = (tipo) => String(tipo ?? "").split(";")[0].trim().toLowerCase();

/** Archivo recibido por Meta (foto o audio). Devuelve { mediaType, bytes } o null. */
async function bajarDeMeta(mediaId, maximo) {
  if (!porMeta() || !mediaId) return null;
  const cabeceras = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const ficha = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: cabeceras }).then((r) => (r.ok ? r.json() : null));
  if (!ficha?.url) return null;
  const respuesta = await fetch(ficha.url, { headers: cabeceras });
  if (!respuesta.ok) return null;
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  return bytes.length > maximo ? null : { mediaType: tipoBase(ficha.mime_type), bytes };
}

/** Archivo recibido por YCloud: el aviso trae un enlace de descarga en su propio dominio. */
async function bajarDeYCloud(medio, maximo) {
  let enlace;
  try {
    enlace = new URL(medio?.link);
  } catch {
    return null;
  }
  if (enlace.protocol !== "https:" || !enlace.hostname.endsWith(".ycloud.com")) return null; // la clave solo viaja a YCloud
  const respuesta = await fetch(enlace, { headers: { "X-API-Key": process.env.YCLOUD_API_KEY } });
  if (!respuesta.ok) return null;
  const bytes = Buffer.from(await respuesta.arrayBuffer());
  return bytes.length > maximo ? null : { mediaType: tipoBase(medio.mime_type || respuesta.headers.get("content-type")), bytes };
}

const comoImagen = (archivo) => (archivo && TIPOS_IMAGEN.includes(archivo.mediaType) ? { mediaType: archivo.mediaType, base64: archivo.bytes.toString("base64") } : null);
const comoAudio = (archivo) => (archivo && (archivo.mediaType.startsWith("audio/") || archivo.mediaType === "video/mp4") ? archivo : null);
const MAX_IMAGEN = 3_000_000;
const MAX_AUDIO = 10_000_000;

/** Foto que mandó el cliente: { mediaType, base64 } o null si no se pudo o pesa demasiado. */
export const bajarImagen = async (mediaId) => comoImagen(await bajarDeMeta(mediaId, MAX_IMAGEN));
export const bajarImagenYCloud = async (imagen) => comoImagen(await bajarDeYCloud(imagen, MAX_IMAGEN));
/** Nota de voz que mandó el cliente: { mediaType, bytes } o null. */
export const bajarAudio = async (mediaId) => comoAudio(await bajarDeMeta(mediaId, MAX_AUDIO));
export const bajarAudioYCloud = async (audio) => comoAudio(await bajarDeYCloud(audio, MAX_AUDIO));

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
