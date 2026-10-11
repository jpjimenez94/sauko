import { waitUntil } from "@vercel/functions";
import { atenderWhatsApp } from "../lib/conversacion.js";
import { enviarTexto, bajarImagen, firmaValida } from "../lib/whatsapp.js";
import { esNuevo } from "../lib/store.js";
import { hayClave } from "../lib/agente.js";

// Webhook de WhatsApp Cloud API (Meta).
// Variables: WHATSAPP_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET.

/** El cuerpo tal como llegó, para comprobar la firma. */
async function cuerpoCrudo(req) {
  if (typeof req.rawBody === "string") return req.rawBody; // servidor local
  if (!req.readableEnded) {
    const trozos = [];
    for await (const trozo of req) trozos.push(trozo);
    if (trozos.length) return Buffer.concat(trozos).toString("utf8");
  }
  return JSON.stringify(req.body ?? {});
}

async function atender(mensaje) {
  const telefono = mensaje.from;
  try {
    if (!(await esNuevo(mensaje.id))) return;
    if (!hayClave()) return void (await enviarTexto(telefono, "En este momento el asistente no está disponible. Escríbenos de nuevo en un rato."));
    if (mensaje.type === "text") return void (await enviarTexto(telefono, await atenderWhatsApp(telefono, mensaje.text?.body ?? "")));
    if (mensaje.type === "image") {
      const imagen = await bajarImagen(mensaje.image?.id);
      if (!imagen) return void (await enviarTexto(telefono, "No pude abrir esa foto, veci. ¿Me la mandás otra vez?"));
      return void (await enviarTexto(telefono, await atenderWhatsApp(telefono, mensaje.image?.caption ?? "", imagen)));
    }
    await enviarTexto(telefono, "Por acá solo leo texto y fotos, veci. Escribime qué necesitás y te lo armo.");
  } catch (error) {
    console.error("whatsapp:", error);
    await enviarTexto(telefono, "Se nos enredó algo por acá. Escribime de nuevo en un momento, porfa.").catch(() => {});
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { "hub.mode": modo, "hub.verify_token": token, "hub.challenge": reto } = req.query ?? {};
    if (modo === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(reto);
    return res.status(403).send("Token inválido");
  }
  if (req.method !== "POST") return res.status(405).send("Método no permitido");

  const crudo = await cuerpoCrudo(req);
  if (!firmaValida(crudo, req.headers["x-hub-signature-256"])) return res.status(401).send("Firma inválida");
  let cuerpo;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return res.status(400).send("Cuerpo inválido");
  }

  // Meta espera el 200 en pocos segundos; el asistente sigue trabajando después de responder.
  const mensajes = (cuerpo.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);
  const trabajo = Promise.all(mensajes.map(atender));
  waitUntil(trabajo);
  res.status(200).send("ok");
  await trabajo.catch(() => {});
}
