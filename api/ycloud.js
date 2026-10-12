import { bajarImagenYCloud, firmaYCloudValida } from "../lib/whatsapp.js";
import { atenderEntrante, cuerpoCrudo } from "../lib/entrada.js";
import { anotar } from "../lib/store.js";

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
  const m = evento.type === "whatsapp.inbound_message.received" ? evento.whatsappInboundMessage : null;
  if (!m) {
    await anotar("evento ignorado", evento.type);
    return res.status(200).send("ok");
  }

  const trabajo = atenderEntrante({
    id: m.wamid || m.id,
    telefono: m.from,
    tipo: m.type,
    texto: m.text?.body ?? m.image?.caption ?? "",
    bajar: () => bajarImagenYCloud(m.image),
  });
  // Se responde cuando el asistente termina: si se contesta antes, Vercel corta el trabajo a medias.
  // Si el proveedor reintenta por la demora, el mensaje repetido se descarta.
  await trabajo.catch(() => {});
  res.status(200).send("ok");
}
