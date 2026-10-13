// Atiende un mensaje de WhatsApp. Aquí no hay página, así que las herramientas del asistente
// se ejecutan en el servidor y el pedido vive en la base, junto con la conversación del teléfono.
import { paso } from "./agente.js";
import { buscar, pedidoNuevo, resumen, cerrar } from "./tienda.js";
import { CATALOGO, METODOS_PAGO, totales, horario } from "./comun.js";
import { leerCharla, guardarCharla, leerPedido, guardarPedido, leerAgotados } from "./store.js";

const CERRADOS = ["por_confirmar", "alistando", "en_camino", "entregado"];
const MAX_TURNOS = 24;

function herramientas(ctx) {
  return {
    buscar_productos: ({ consulta }) => buscar(String(consulta ?? ""), ctx.agotados),

    guardar_pedido: async ({ items, direccion, metodo_pago }) => {
      if (CERRADOS.includes(ctx.pedido.status)) ctx.pedido = pedidoNuevo("WhatsApp", ctx.telefono);
      const problemas = [];
      const limpios = [];
      for (const it of Array.isArray(items) ? items.slice(0, 80) : []) {
        const sku = String(it.sku);
        const producto = CATALOGO.get(sku);
        const qty = Math.min(99, Math.floor(Number(it.cantidad)));
        if (!producto) problemas.push(`SKU ${sku} no existe; búscalo de nuevo`);
        else if (ctx.agotados[sku]) problemas.push(`${producto.nombre}: agotado`);
        else if (qty >= 1) limpios.push({ sku, name: producto.nombre, price: producto.precio, qty });
      }
      ctx.pedido.items = limpios;
      ctx.pedido.status = "armando";
      if (direccion) ctx.pedido.direccion = String(direccion).slice(0, 160);
      if (METODOS_PAGO.includes(metodo_pago)) ctx.pedido.pago = metodo_pago;
      ctx.pedido.total = totales(limpios).total;
      await guardarPedido(ctx.pedido);
      return { ...resumen(ctx.pedido), problemas };
    },

    cerrar_pedido: async ({ paga_con }) => {
      if (CERRADOS.includes(ctx.pedido.status)) throw new Error("Ese pedido ya está en la tienda");
      const resultado = cerrar(ctx.pedido, paga_con);
      await guardarPedido(ctx.pedido);
      return resultado;
    },

    registrar_comprobante: async ({ es_comprobante, monto }) => {
      if (ctx.pedido.status !== "esperando_pago") throw new Error("El pedido no está esperando pago");
      if (!ctx.imagen) throw new Error("El cliente no adjuntó ninguna imagen en este mensaje");
      const valor = Math.max(0, Math.floor(Number(monto) || 0));
      if (!es_comprobante) return { recibido: false, motivo: "La imagen no es un comprobante legible" };
      if (valor < ctx.pedido.total) return { recibido: false, motivo: `El comprobante muestra ${valor} y el total es ${ctx.pedido.total}` };
      // El panel muestra la foto si no es muy pesada; si lo es, la tienda la ve en su WhatsApp.
      const url = `data:${ctx.imagen.mediaType};base64,${ctx.imagen.base64}`;
      Object.assign(ctx.pedido, { proof: url.length <= 300_000 ? url : "", proofMonto: valor, status: "por_confirmar" });
      await guardarPedido(ctx.pedido);
      return {
        recibido: true,
        siguiente: "La tienda confirma el pago en su panel en un momento y el sistema le avisa al cliente por este chat. No digas todavía que el pago está confirmado ni que el pedido salió.",
      };
    },
  };
}

/**
 * @param {string} telefono
 * @param {string} texto
 * @param {{mediaType: string, base64: string} | null} imagen
 * @returns {Promise<{texto: string, enviarQr: boolean}>} la respuesta para el cliente y si hay que
 *   mandarle el código QR de pago porque acaba de cerrar un pedido por transferencia
 */
export async function atenderWhatsApp(telefono, texto, imagen = null) {
  const charla = await leerCharla(telefono);
  const guardado = charla.pedidoId ? await leerPedido(charla.pedidoId) : null;
  const ctx = { telefono, imagen, agotados: await leerAgotados(), pedido: guardado ?? pedidoNuevo("WhatsApp", telefono) };
  const usar = herramientas(ctx);
  const antes = `${ctx.pedido.id}:${ctx.pedido.status}`;

  const dicho = String(texto || "").slice(0, 2000) + (imagen ? " [El cliente adjuntó una imagen en este mensaje]" : "");
  const nota = `\n\n[Estado del pedido en pantalla #${ctx.pedido.no}: ${JSON.stringify(resumen(ctx.pedido))}. ${horario().nota}]`;
  const turno = { role: "user", content: dicho.trim() + nota };
  const previos = charla.turnos.slice(-MAX_TURNOS);
  while (previos.length && previos[0].role !== "user") previos.shift();

  const mensajes = [
    ...previos,
    imagen
      ? { role: "user", content: [{ type: "image", source: { type: "base64", media_type: imagen.mediaType, data: imagen.base64 } }, { type: "text", text: turno.content }] }
      : turno,
  ];

  let respuesta = "";
  for (let ronda = 0; ronda < 6; ronda++) {
    const { content, stop_reason } = await paso(mensajes);
    if (stop_reason === "refusal") {
      respuesta = "Qué pena veci, con eso no te puedo ayudar por acá. ¿Te armo un pedido?";
      break;
    }
    // Solo le llega al cliente el texto de la última ronda: lo que el modelo escribe antes de usar
    // una herramienta suele ser una nota para sí mismo.
    if (stop_reason !== "tool_use") {
      respuesta = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      break;
    }
    const resultados = await Promise.all(
      content.filter((b) => b.type === "tool_use").map(async (uso) => {
        try {
          if (!usar[uso.name]) throw new Error("Herramienta desconocida");
          return { type: "tool_result", tool_use_id: uso.id, content: JSON.stringify(await usar[uso.name](uso.input ?? {})) };
        } catch (error) {
          return { type: "tool_result", tool_use_id: uso.id, content: "Error: " + error.message, is_error: true };
        }
      }),
    );
    // Los bloques de Claude vuelven tal cual, incluido su razonamiento, y se agregan al final.
    mensajes.push({ role: "assistant", content }, { role: "user", content: resultados });
  }
  respuesta ||= "Dame un momentico y te confirmo, veci.";

  // De un mensaje al siguiente solo se guarda el texto de cada turno.
  charla.turnos = [...previos, turno, { role: "assistant", content: respuesta }];
  charla.pedidoId = ctx.pedido.id;
  await guardarCharla(telefono, charla);
  const despues = `${ctx.pedido.id}:${ctx.pedido.status}`;
  return { texto: respuesta, enviarQr: despues !== antes && ctx.pedido.status === "esperando_pago" && ctx.pedido.pago === "Transferencia" };
}

const AVISOS = {
  alistando: (p) => (p.encargo ? `Pago confirmado. Tu pedido #${p.no} queda como encargo y te lo llevamos apenas abramos domicilios.` : `Pago confirmado. Ya estamos alistando tu pedido #${p.no} y llega en máximo 10 minutos.`),
  esperando_pago: (p) => `No pudimos confirmar el pago del pedido #${p.no}. ¿Nos envías de nuevo el comprobante, por favor?`,
  en_camino: (p) => `¡Ve, llego! Tu pedido #${p.no} ya va en camino.`,
  entregado: () => "Pedido entregado. Gracias por comprar en Sauko Store.",
};

/** Lo que la tienda le anuncia al cliente cuando mueve el pedido en el panel. Queda en la conversación. */
export async function avisoDeTienda(pedido) {
  const texto = AVISOS[pedido.status]?.(pedido);
  if (!texto || pedido.canal !== "WhatsApp" || !pedido.cliente) return null;
  const charla = await leerCharla(pedido.cliente);
  charla.turnos.push({ role: "assistant", content: texto });
  await guardarCharla(pedido.cliente, charla);
  return texto;
}
