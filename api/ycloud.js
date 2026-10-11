import { waitUntil } from "@vercel/functions";
import { bajarImagenYCloud, firmaYCloudValida } from "../lib/whatsapp.js";
import { atenderEntrante, cuerpoCrudo } from "../lib/entrada.js";

// Webhook de YCloud: el número de la tienda sigue en su app WhatsApp Business y YCloud nos pasa
// cada mensaje que llega. Variables: YCLOUD_API_KEY, YCLOUD_FROM, YCLOUD_WEBHOOK_SECRET.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Método no permitido");

  const crudo = await cuerpoCrudo(req);
  if (!firmaYCloudValida(crudo, req.headers["ycloud-signature"])) return res.status(401).send("Firma inválida");
  let evento;
  try {
    evento = JSON.parse(crudo);
  } catch {
    return res.status(400).send("Cuerpo inválido");
  }

  // Solo interesan los mensajes de clientes; estados de entrega y demás se reciben y se ignoran.
  const m = evento.type === "whatsapp.inbound_message.received" ? evento.whatsappInboundMessage : null;
  if (!m) return res.status(200).send("ok");

  const trabajo = atenderEntrante({
    id: m.wamid || m.id,
    telefono: m.from,
    tipo: m.type,
    texto: m.text?.body ?? m.image?.caption ?? "",
    bajar: () => bajarImagenYCloud(m.image),
  });
  waitUntil(trabajo);
  res.status(200).send("ok");
  await trabajo.catch(() => {});
}
