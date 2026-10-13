import { bajarImagenYCloud, bajarAudioYCloud, firmaYCloudValida } from "../lib/whatsapp.js";
import { atenderEntrante, cuerpoCrudo } from "../lib/entrada.js";
import { anotar, pausar } from "../lib/store.js";

const PAUSA_SEGUNDOS = 30 * 60;

// Webhook de YCloud: el número de la tienda sigue en su app WhatsApp Business y YCloud nos pasa
// cada mensaje que llega. Variables: YCLOUD_API_KEY, YCLOUD_FROM, YCLOUD_WEBHOOK_SECRET.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Método no permitido");

  const crudo = await cuerpoCrudo(req);
  if (!firmaYCloudValida(crudo, req.headers["ycloud-signature"])) {
    const cabecera = String(req.headers["ycloud-signature"] ?? "");
    await anotar("firma inválida", `cabecera ${cabecera ? "presente (" + cabecera.slice(0, 14) + "…)" : "ausente"}, cuerpo de ${crudo.length} caracteres, secreto ${process.env.YCLOUD_WEBHOOK_SECRET ? "configurado" : "sin configurar"}`);
    return res.status(401).send("Firma inválida");
  }
  let evento;
  try {
    evento = JSON.parse(crudo);
  } catch {
    return res.status(400).send("Cuerpo inválido");
  }

  // Solo interesan los mensajes de clientes; estados de entrega y demás se reciben y se ignoran.
  // Mensaje enviado a mano desde la app WhatsApp Business de la tienda: el asistente se calla
  // media hora en esa conversación para no hablar los dos a la vez.
  if (evento.type === "whatsapp.smb.message.echoes") {
    const eco = evento.whatsappMessage ?? {};
    const destino = eco.to || eco.toUserId || eco.recipient;
    if (destino) {
      await pausar(destino, PAUSA_SEGUNDOS);
      await anotar("la tienda respondió a mano: asistente en pausa 30 min", "termina en " + String(destino).slice(-4));
    } else await anotar("eco sin destinatario", Object.keys(eco).join("+"));
    return res.status(200).send("ok");
  }

  const m = evento.type === "whatsapp.inbound_message.received" ? evento.whatsappInboundMessage : null;
  if (!m) {
    await anotar("evento ignorado", evento.type);
    return res.status(200).send("ok");
  }

  // Quien usa nombre de usuario en WhatsApp no comparte su teléfono: llega un identificador (fromUserId)
  // y se le responde por ese mismo identificador.
  const remitente = m.from || m.fromUserId;
  if (!remitente || !(m.wamid || m.id)) {
    const forma = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "object" && v ? Object.keys(v).join("+") : typeof v === "string" ? v.slice(0, 6) + "…(" + v.length + ")" : typeof v]));
    await anotar("aviso sin teléfono o sin id", JSON.stringify(forma));
  }

  const trabajo = atenderEntrante({
    id: m.wamid || m.id,
    telefono: remitente,
    usuario: m.customerProfile?.username,
    tipo: m.type,
    texto: m.text?.body ?? m.image?.caption ?? "",
    bajar: () => bajarImagenYCloud(m.image),
    bajarAudio: () => bajarAudioYCloud(m.audio ?? m.voice),
  });
  // Se responde cuando el asistente termina: si se contesta antes, Vercel corta el trabajo a medias.
  // Si el proveedor reintenta por la demora, el mensaje repetido se descarta.
  await trabajo.catch(() => {});
  res.status(200).send("ok");
}
