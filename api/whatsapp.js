import { bajarImagen, bajarAudio, firmaValida, textoDeBoton } from "../lib/whatsapp.js";
import { atenderEntrante, cuerpoCrudo } from "../lib/entrada.js";
import { anotar } from "../lib/store.js";
import { atenderPanel, guardarEntrante, guardarEstados, guardarAvisosDeCuenta } from "../lib/conversaciones.js";
import { enviarRecordatorios } from "../lib/recordatorios.js";

// Webhook de WhatsApp Cloud API (Meta directo).
// Variables: WHATSAPP_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET.
// Con ?accion=… atiende la sección Conversaciones del panel (con sesión), no a Meta.
export default async function handler(req, res) {
  // Recordatorio de pedidos sin cerrar (lib/recordatorios.js): lo llama cron-job.org cada 5 minutos. Si
  // RECORDATORIOS_CLAVE está configurada, la llamada debe traerla en ?clave=.
  if (req.query?.accion === "recordatorios") {
    res.setHeader("Cache-Control", "no-store");
    const clave = process.env.RECORDATORIOS_CLAVE;
    if (clave && req.query.clave !== clave) return res.status(403).json({ error: "Clave inválida" });
    try {
      return res.status(200).json(await enviarRecordatorios());
    } catch (error) {
      console.error("recordatorios:", error);
      return res.status(500).json({ error: "No se pudieron revisar los recordatorios" });
    }
  }
  if (req.query?.accion) return atenderPanel(req, res);
  if (req.method === "GET") {
    const { "hub.mode": modo, "hub.verify_token": token, "hub.challenge": reto } = req.query ?? {};
    if (modo === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(reto);
    return res.status(403).send("Token inválido");
  }
  if (req.method !== "POST") return res.status(405).send("Método no permitido");

  const crudo = await cuerpoCrudo(req);
  if (!firmaValida(crudo, req.headers["x-hub-signature-256"])) {
    // Si no, un WHATSAPP_APP_SECRET de otra app deja al asistente mudo sin rastro en el Diagnóstico.
    const linea = String(crudo).match(/"display_phone_number":"(\d+)"/)?.[1];
    await anotar("aviso de Meta rechazado", `la firma no coincide con WHATSAPP_APP_SECRET${linea ? `; línea que termina en ${linea.slice(-4)}` : ""}`).catch(() => {});
    return res.status(401).send("Firma inválida");
  }
  let cuerpo;
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return res.status(400).send("Cuerpo inválido");
  }

  const cambios = (cuerpo.entry ?? []).flatMap((e) => e.changes ?? []);
  // Enviado, entregado, leído o falló: para los ✓✓ de las Conversaciones del panel.
  await guardarEstados(cambios.flatMap((c) => c.value?.statuses ?? [])).catch(() => {});
  // Calidad del número, infracciones, revisiones: avisos de Meta sobre la cuenta (no son mensajes).
  await guardarAvisosDeCuenta(cambios.filter((c) => c.field && c.field !== "messages")).catch(() => {});

  // Quien usa nombre de usuario en WhatsApp no comparte su número: Meta manda su identificador de
  // negocio (BSUID, "CO.1234…") en vez de "from", y se le responde por ese mismo identificador.
  const mensajes = cambios.flatMap((c) => (c.value?.messages ?? []).map((m) => ({ m, contactos: c.value?.contacts ?? [], linea: c.value?.metadata ?? {} })));
  const trabajo = Promise.all(
    mensajes.map(async ({ m, contactos, linea }) => {
      const contacto = contactos.find((k) => (m.from && k.wa_id === m.from) || (k.user_id && k.user_id === (m.from_user_id ?? m.user_id))) ?? contactos[0];
      const remitente = m.from || m.from_user_id || m.user_id || contacto?.wa_id || contacto?.user_id;
      // Si aun así no hay remitente, se anota la forma del aviso (solo los nombres de los campos).
      if (!remitente) await anotar("aviso de Meta sin remitente", `mensaje: ${Object.keys(m).join("+")}; contacto: ${Object.keys(contacto ?? {}).join("+")}`).catch(() => {});
      // Todo lo que escribe el cliente queda en el chat del panel, conteste o no el asistente.
      await guardarEntrante(remitente, m, contacto, linea).catch((e) => console.error("conversación:", e));
      if (m.type === "reaction") return; // una reacción no se contesta
      return atenderEntrante({
        id: m.id,
        telefono: remitente,
        usuario: contacto?.profile?.username ?? contacto?.username,
        tipo: textoDeBoton(m) ? "text" : m.type,
        texto: textoDeBoton(m) || (m.text?.body ?? m.image?.caption ?? ""),
        bajar: () => bajarImagen(m.image?.id),
        bajarAudio: () => bajarAudio(m.audio?.id),
      });
    }),
  );
  // Se responde cuando el asistente termina: si se contesta antes, Vercel corta el trabajo a medias.
  // Si el proveedor reintenta por la demora, el mensaje repetido se descarta.
  await trabajo.catch(() => {});
  res.status(200).send("ok");
}
