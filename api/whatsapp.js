import { bajarImagen, bajarAudio, firmaValida, textoDeBoton } from "../lib/whatsapp.js";
import { atenderEntrante, cuerpoCrudo } from "../lib/entrada.js";

// Webhook de WhatsApp Cloud API (Meta directo).
// Variables: WHATSAPP_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET.
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

  const mensajes = (cuerpo.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);
  const trabajo = Promise.all(
    mensajes.map((m) =>
      atenderEntrante({ id: m.id, telefono: m.from, tipo: textoDeBoton(m) ? "text" : m.type, texto: textoDeBoton(m) || (m.text?.body ?? m.image?.caption ?? ""), bajar: () => bajarImagen(m.image?.id), bajarAudio: () => bajarAudio(m.audio?.id) }),
    ),
  );
  // Se responde cuando el asistente termina: si se contesta antes, Vercel corta el trabajo a medias.
  // Si el proveedor reintenta por la demora, el mensaje repetido se descarta.
  await trabajo.catch(() => {});
  res.status(200).send("ok");
}
