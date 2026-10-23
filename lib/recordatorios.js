// Recordatorio de pedido sin cerrar: si el cliente armó un pedido por WhatsApp y lleva 20 minutos sin
// escribir, se le pregunta una sola vez si lo cerramos. Vercel Hobby no programa tareas tan seguido, así que
// se revisa de paso con lo que ya llega: el panel (que en la tienda consulta los pedidos cada pocos segundos)
// y los avisos de WhatsApp, como máximo una vez por minuto. /api/whatsapp?accion=recordatorios queda para
// una tarea programada si algún día la hay.
// Una sola vez por pedido, solo en horario de domicilios y dentro de la conversación (ventana de 24 h):
// insistir más es lo que hace que la gente bloquee o reporte el número.
import { listarPedidos, guardarPedido, leerCharla, guardarCharla, pausaRestante, leerAjustes, anotar, tocaRevisarRecordatorios } from "./store.js";
import { cargarNegocio, horario } from "./comun.js";
import { totalesDe } from "./tienda.js";
import { enviarBotones } from "./whatsapp.js";

export const ESPERA = 20 * 60_000;
// Después de dos horas la conversación ya es otra (lib/conversacion.js): no se le recuerda nada.
const HASTA = 2 * 3600_000;
const pesos = (n) => "$" + Math.round(n).toLocaleString("es-CO");
// Por libra: "½ lb", "1½ lb".
const cantidad = (i) => (Number.isInteger(i.qty) ? String(i.qty) : `${Math.floor(i.qty) || ""}½ lb`);

export function textoRecordatorio(pedido) {
  const { total } = totalesDe(pedido);
  const lineas = pedido.items.slice(0, 8).map((i) => `• ${cantidad(i)} ${i.name}`);
  if (pedido.items.length > 8) lineas.push(`• y ${pedido.items.length - 8} más`);
  return `Veci, ¿cerramos tu pedido? 🛒\n${lineas.join("\n")}\n💰 Total: ${pesos(total)}`;
}

/** Revisa los pedidos abiertos y manda los recordatorios que tocan. Devuelve cuántos revisó y envió. */
export async function enviarRecordatorios(ahora = Date.now()) {
  await cargarNegocio();
  if (!(await leerAjustes()).whatsappActivo || horario(new Date(ahora)).encargo) return { revisados: 0, enviados: 0 };
  const abiertos = (await listarPedidos()).filter((p) => p.canal === "WhatsApp" && p.status === "armando" && p.items?.length && !p.recordado && p.cliente);
  let enviados = 0;
  for (const pedido of abiertos) {
    const charla = await leerCharla(pedido.cliente);
    const quieto = ahora - (charla.ultimo ?? 0);
    // Que sea el pedido vigente de esa conversación, que lo último lo haya dicho el asistente (el cliente no
    // escribió después) y que la tienda no haya tomado el chat.
    if (charla.pedidoId !== pedido.id || quieto < ESPERA || quieto > HASTA || charla.turnos?.at(-1)?.role !== "assistant") continue;
    if ((await pausaRestante(pedido.cliente)) > 0) continue;
    const texto = textoRecordatorio(pedido);
    const botones = [{ titulo: "Sí, cerrar pedido", detalle: "" }, { titulo: "Agregar algo más", detalle: "" }];
    // Se marca antes de enviar: si el envío falla, no se reintenta a cada rato.
    await guardarPedido({ ...pedido, recordado: ahora });
    if (!(await enviarBotones(pedido.cliente, texto, botones))) continue;
    // Queda en la conversación, para que el asistente sepa qué le preguntó y qué botones tiene a la vista.
    charla.turnos.push({ role: "assistant", content: `${texto}\n(Botones: Sí, cerrar pedido | Agregar algo más)` });
    charla.botones = botones.map((b) => b.titulo);
    charla.titulos = [];
    await guardarCharla(pedido.cliente, charla);
    await anotar("recordatorio de pedido sin cerrar", `pedido #${pedido.no}`).catch(() => {});
    enviados++;
  }
  return { revisados: abiertos.length, enviados };
}

/** De paso, con el panel o un aviso de WhatsApp: revisa los recordatorios si no se revisaron en el último minuto. Nunca falla. */
export async function revisarRecordatoriosDePaso() {
  try {
    if (await tocaRevisarRecordatorios()) await enviarRecordatorios();
  } catch (error) {
    console.error("recordatorios:", error);
  }
}
