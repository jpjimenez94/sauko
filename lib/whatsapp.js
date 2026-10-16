// WhatsApp: enviar texto, bajar la foto que mandó el cliente y validar la firma de cada aviso.
// Hay dos caminos y se usa el que tenga sus variables: YCloud (proveedor, permite que el número
// siga también en la app WhatsApp Business) o la Cloud API de Meta directa.
import { createHmac, timingSafeEqual } from "node:crypto";
import { anotar, registrarMensaje, marcarEstadoMensaje } from "./store.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const YCLOUD = "https://api.ycloud.com/v2";
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp"];

const porYCloud = () => Boolean(process.env.YCLOUD_API_KEY && process.env.YCLOUD_FROM);
const porMeta = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
export const hayWhatsApp = () => porYCloud() || porMeta();
/** Si YCloud no está configurado (sin YCLOUD_FROM), sus avisos no se atienden: el número es otro. */
export const usaYCloud = porYCloud;
/** Distingue un número de teléfono del identificador de quien no comparte el suyo. */
export const esTelefono = (destino) => /^[+]?[0-9]+$/.test(String(destino));

function iguales(recibido, esperado) {
  const a = Buffer.from(String(recibido ?? ""));
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Manda un mensaje por el proveedor configurado y lo guarda en la conversación del panel.
 * opciones: { de: "asistente" | "tienda", por: nombre de quien escribió en el panel, contexto: wamid al que responde }.
 * Devuelve el identificador del mensaje (o true) si salió, false si no.
 */
async function despachar(telefono, contenido, registro, avisoDeFalla, opciones = {}) {
  // Un teléfono va en "to"; el identificador de quien oculta su número va en "recipient".
  const destino = { [esTelefono(telefono) ? "to" : "recipient"]: telefono };
  const contexto = opciones.contexto ? { context: { message_id: opciones.contexto } } : {};
  let respuesta;
  if (porYCloud()) {
    respuesta = await fetch(`${YCLOUD}/whatsapp/messages/sendDirectly`, {
      method: "POST",
      headers: { "X-API-Key": process.env.YCLOUD_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.YCLOUD_FROM, ...destino, ...contenido, ...contexto }),
    });
  } else if (porMeta()) {
    respuesta = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...destino, ...contenido, ...contexto }),
    });
  } else return false;
  const texto = await respuesta.text().catch(() => "");
  if (!respuesta.ok) {
    const motivo = `${respuesta.status} ${texto.slice(0, 250)}`;
    console.error("whatsapp:", avisoDeFalla, motivo);
    await anotar(avisoDeFalla, motivo);
    return false;
  }
  let id = "";
  try {
    const j = JSON.parse(texto);
    id = j.messages?.[0]?.id ?? j.wamid ?? j.id ?? "";
  } catch {}
  const mensaje = { id: id || `local-${Date.now()}`, dir: "out", de: opciones.de ?? "asistente", ...(opciones.por ? { por: opciones.por } : {}), ...(opciones.contexto ? { contexto: opciones.contexto } : {}), ...registro };
  await registrarMensaje(telefono, mensaje).catch(() => {});
  if (id) await marcarEstadoMensaje(telefono, id, "sent").catch(() => {});
  return id || true;
}

export async function enviarTexto(telefono, texto, opciones = {}) {
  const cuerpo = String(texto).slice(0, 4000);
  return despachar(telefono, { type: "text", text: { body: cuerpo } }, { tipo: "text", texto: cuerpo }, "envío falló", opciones);
}

/** Manda una imagen pública (JPG o PNG) con un texto al pie. */
export async function enviarImagen(telefono, enlace, pie = "", opciones = {}) {
  return despachar(telefono, { type: "image", image: { link: enlace, caption: pie } }, { tipo: "image", texto: pie, medio: { enlace } }, "envío de imagen falló", opciones);
}

/** Manda una imagen ya subida a Meta (la que adjuntó el operario en el panel). */
export async function enviarImagenSubida(telefono, idMedio, pie = "", opciones = {}) {
  return despachar(telefono, { type: "image", image: { id: idMedio, caption: pie } }, { tipo: "image", texto: pie, medio: { id: idMedio } }, "envío de imagen falló", opciones);
}

/** Reacción (emoji) sobre un mensaje del chat; con emoji vacío se quita. Solo por Meta directo. */
export async function enviarReaccion(telefono, wamid, emoji) {
  if (!porMeta()) return false;
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", [esTelefono(telefono) ? "to" : "recipient"]: telefono, type: "reaction", reaction: { message_id: wamid, emoji } }),
  });
  if (!r.ok) await anotar("reacción no enviada", `${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.ok;
}

/** Marca como leído el mensaje del cliente (✓✓ azules en su WhatsApp) y, si se pide, muestra "escribiendo…". */
export async function avisarLeido(wamid, escribiendo = false) {
  if (!porMeta() || !wamid) return false;
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: wamid, ...(escribiendo ? { typing_indicator: { type: "text" } } : {}) }),
  });
  return r.ok;
}

/** Sube a Meta una imagen del operario y devuelve su id para enviarla. */
export async function subirMedio(bytes, tipo) {
  if (!porMeta()) return null;
  const formulario = new FormData();
  formulario.append("messaging_product", "whatsapp");
  formulario.append("type", tipo);
  formulario.append("file", new Blob([bytes], { type: tipo }), "foto." + (tipo.split("/")[1] || "jpg"));
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`, { method: "POST", headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, body: formulario });
  if (!r.ok) {
    await anotar("no se pudo subir la imagen a WhatsApp", `${r.status} ${(await r.text()).slice(0, 200)}`);
    return null;
  }
  return (await r.json()).id ?? null;
}

/**
 * Mensaje con opciones para responder de un toque: hasta 3 salen como botones y de 4 a 10 como lista.
 * Solo se puede enviar dentro de la conversación que abrió el cliente. Devuelve false si no salió,
 * para que quien llama mande el texto normal.
 * @param {{titulo: string, detalle?: string}[]} opciones
 */
export const OTRA_OPCION = "Si tenés otra en mente, escribime cuál y te la busco.";
const completo = (o) => [o.titulo, o.detalle].filter(Boolean).join(" ");

/**
 * Cómo se arma un mensaje de hasta 3 botones. Un botón de WhatsApp solo admite 20 caracteres:
 * - Si todas las opciones caben enteras ("Transferencia"), cada una es su botón.
 * - Si no (nombres de producto), los nombres completos y sus precios van numerados en el texto,
 *   sin recortar, y cada botón lleva el nombre abreviado ("Coca 1.5 L").
 */
export function armarBotones(texto, opciones) {
  if (opciones.every((o) => completo(o).length <= 20)) return { texto, titulos: opciones.map(completo) };
  // Se listan completas las opciones que no caben en un botón (productos, direcciones); las cortas como
  // "No, gracias" u "Otra dirección" van únicamente como botón.
  const productos = opciones.filter((o) => completo(o).length > 20);
  const lineas = productos.map((o, i) => `${i + 1}. ${o.titulo}${o.detalle ? " — " + o.detalle : ""}`);
  // El botón lleva el nombre abreviado que propuso el asistente; si no sirve, el nombre recortado por palabras.
  const usados = new Set();
  const titulos = opciones.map((o, i) => {
    let titulo = String(o.corto ?? "").trim();
    if (!titulo || titulo.length > 20) {
      titulo = "";
      for (const palabra of o.titulo.split(" ")) {
        if (`${titulo} ${palabra}`.trim().length > 20) break;
        titulo = `${titulo} ${palabra}`.trim();
      }
    }
    if (!titulo || usados.has(titulo.toLowerCase())) titulo = `Opción ${i + 1}`;
    usados.add(titulo.toLowerCase());
    return titulo;
  });
  // Si son productos, son los más vendidos y no los únicos: se invita a pedir otro.
  const otra = opciones.some((o) => o.detalle) ? `\n\n${OTRA_OPCION}` : "";
  return { texto: `${texto}\n\n${lineas.join("\n")}${otra}`, titulos };
}

export async function enviarBotones(telefono, texto, opciones, extra = {}) {
  const armado = opciones.length <= 3 ? armarBotones(texto, opciones) : null;
  const cuerpo = { text: String(armado?.texto ?? texto).slice(0, 1024) };
  const interactive =
    opciones.length <= 3
      ? { type: "button", body: cuerpo, action: { buttons: armado.titulos.map((title, i) => ({ type: "reply", reply: { id: `op${i}`, title } })) } }
      : {
          type: "list",
          body: cuerpo,
          action: { button: "Ver opciones", sections: [{ title: "Opciones", rows: opciones.slice(0, 10).map((o, i) => ({ id: `op${i}`, title: o.titulo.slice(0, 24), ...(o.detalle ? { description: o.detalle.slice(0, 72) } : {}) })) }] },
        };
  const titulos = opciones.length <= 3 ? armado.titulos : opciones.slice(0, 10).map((o) => o.titulo.slice(0, 24));
  return despachar(telefono, { type: "interactive", interactive }, { tipo: "interactive", texto: cuerpo.text, botones: titulos }, "envío de botones falló; se manda como texto", extra);
}

/** Lo que el cliente tocó en un mensaje con botones o lista, como texto. Vacío si no es eso. */
export function textoDeBoton(m) {
  const tocado = m?.interactive?.button_reply ?? m?.interactive?.list_reply ?? m?.interactive?.buttonReply ?? m?.interactive?.listReply;
  if (tocado?.title) return [tocado.title, tocado.description].filter(Boolean).join(" · ");
  return String(m?.button?.text ?? "");
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
/** Cualquier archivo del chat (foto, nota de voz, video, documento) para verlo en el panel. Hasta ~4 MB, lo que deja responder Vercel. */
export const bajarMedio = async (mediaId) => bajarDeMeta(mediaId, 4_400_000);

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
