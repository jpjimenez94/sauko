// Atiende un mensaje de WhatsApp. Aquí no hay página, así que las herramientas del asistente
// se ejecutan en el servidor y el pedido vive en la base, junto con la conversación del teléfono.
import { paso } from "./agente.js";
import { buscar, pedidoGenerico, paraAcompanar, pedidoNuevo, resumen, cerrar, totalesDe } from "./tienda.js";
import { CATALOGO, METODOS_PAGO, totales, horario, cargarNegocio, sitio, programar, momentoDe, cantidadValida } from "./comun.js";
import { enviarImagen, armarBotones } from "./whatsapp.js";
import { promoParaCliente, apartarPromo, soltarPromo, valorDescuento } from "./promo.js";
import { leerCharla, guardarCharla, leerPedido, guardarPedido, leerAgotados, anotarSolicitado, leerExistencias, noDisponibles, leerDirecciones, recordarDireccion } from "./store.js";

const CERRADOS = ["por_confirmar", "alistando", "en_camino", "entregado"];
const MAX_TURNOS = 24;
// Después de dos horas sin escribir es una conversación nueva (también con el pedido ya cerrado): así un
// "muchas gracias" un rato después del pedido se contesta en contexto y no con el saludo de bienvenida.
const SESION_INACTIVA = 2 * 3600_000;
const CERRADO_HACE = 2 * 3600_000;
// "¿Cómo vas a pagar?", "¿Cómo quiere pagar?", "¿Qué forma de pago preferís?"...
// El cliente pide de verdad pagar en efectivo (no solo escribe un valor).
const PIDE_EFECTIVO = /efectivo|contra ?entrega|al recibir|cuando llegue|en la puerta|cash|billete|pago al domi/i;
const PREGUNTA_PAGO = /c[oó]mo[^.?!]{0,40}\bpag(ar|[aá]s|a)\b[^.!]*\?|forma de pago[^.!]*\?|m[eé]todo de pago[^.!]*\?|transferencia o efectivo/i;

function herramientas(ctx) {
  return {
    buscar_productos: ({ consulta }) => pedidoGenerico(String(consulta ?? "")) ?? buscar(String(consulta ?? ""), ctx.agotados),

    anotar_producto_faltante: async ({ producto }) => ({ anotado: await anotarSolicitado(String(producto ?? ""), "WhatsApp") }),

    enviar_foto_producto: async ({ sku }) => {
      const producto = CATALOGO.get(String(sku));
      if (!producto) throw new Error("Ese sku no existe; búscalo de nuevo");
      if (!producto.foto) return { enviada: false, motivo: "Ese producto no tiene foto" };
      if (ctx.fotos >= 3) return { enviada: false, motivo: "Ya se enviaron 3 fotos en este mensaje" };
      const enviada = await enviarImagen(ctx.telefono, `${sitio()}/api/foto?sku=${encodeURIComponent(sku)}`, `${producto.nombre} · $${producto.precio.toLocaleString("es-CO")}`);
      if (enviada) ctx.fotos++;
      return enviada ? { enviada: true } : { enviada: false, motivo: "No se pudo enviar la foto en este momento" };
    },

    ofrecer_botones: ({ opciones }) => {
      const vistos = new Set();
      const limpias = [];
      for (const o of Array.isArray(opciones) ? opciones : []) {
        const titulo = String(o?.titulo ?? "").replace(/\s+/g, " ").trim();
        if (!titulo || vistos.has(titulo.toLowerCase())) continue;
        vistos.add(titulo.toLowerCase());
        limpias.push({ titulo, detalle: String(o?.detalle ?? "").replace(/\s+/g, " ").trim(), corto: String(o?.corto ?? "").replace(/\s+/g, " ").trim() });
      }
      if (limpias.length < 2) throw new Error("Se necesitan al menos 2 opciones distintas");
      ctx.botones = limpias.slice(0, 10);
      return { listo: true, nota: "Los botones salen pegados a tu respuesta: escribe la pregunta y no repitas las opciones en el texto." };
    },

    guardar_pedido: async ({ items, direccion, metodo_pago, entrega_dia, entrega_hora }) => {
      if (CERRADOS.includes(ctx.pedido.status)) ctx.pedido = pedidoNuevo("WhatsApp", ctx.telefono);
      const esperabaComprobante = ctx.pedido.status === "esperando_pago" && ctx.pedido.pago === "Transferencia";
      const problemas = [];
      const limpios = [];
      for (const it of Array.isArray(items) ? items.slice(0, 80) : []) {
        const sku = String(it.sku);
        const producto = CATALOGO.get(sku);
        const qty = cantidadValida(producto, it.cantidad);
        if (!producto) problemas.push(`SKU ${sku} no existe; búscalo de nuevo`);
        else if (ctx.agotados[sku]) problemas.push(`${producto.nombre}: agotado`);
        else if (qty > 0) {
          // Si la tienda lleva la cuenta de ese producto, no se vende más de lo que queda.
          const quedan = ctx.existencias[sku] ?? qty;
          if (quedan < qty) problemas.push(`${producto.nombre}: solo quedan ${quedan}; se agregaron ${quedan}`);
          limpios.push({ sku, name: producto.nombre, price: producto.precio, qty: Math.min(qty, quedan) });
        }
      }
      ctx.pedido.items = limpios;
      ctx.pedido.status = "armando";
      if (direccion) ctx.pedido.direccion = String(direccion).slice(0, 160);
      // Un pedido que ya espera el comprobante de transferencia no pasa a efectivo (y a la tienda sin validar
      // ningún pago) porque el cliente escribió un valor: solo si en este mensaje pide pagar en efectivo.
      if (esperabaComprobante && metodo_pago === "Contraentrega" && !PIDE_EFECTIVO.test(ctx.texto)) problemas.push("El pedido espera el comprobante de la transferencia y el cliente no pidió pagar en efectivo: la forma de pago sigue siendo Transferencia. Pídele la foto del comprobante.");
      else if (METODOS_PAGO.includes(metodo_pago)) ctx.pedido.pago = metodo_pago;
      // Entrega programada: "ya" la quita; una hora la fija si está dentro del horario.
      // Cambiar la hora de entrega sí cambia la tarifa; lo demás no toca la que ya quedó fija al cerrar.
      if (/^(ya|ahora|inmediat)/i.test(String(entrega_hora ?? "").trim())) {
        delete ctx.pedido.programado;
        delete ctx.pedido.domicilioFijo;
      } else if (entrega_hora) {
        const programado = programar(entrega_dia, entrega_hora);
        if (programado.error) problemas.push(programado.error);
        else {
          ctx.pedido.programado = programado;
          delete ctx.pedido.domicilioFijo;
        }
      }
      ctx.pedido.total = totalesDe(ctx.pedido).total;
      // Una sola vez por pedido se propone algo que acompañe lo que lleva.
      const acompanar = ctx.pedido.sugerido || !limpios.length ? null : paraAcompanar(limpios, ctx.agotados);
      if (acompanar) ctx.pedido.sugerido = true;
      await guardarPedido(ctx.pedido);
      // La promoción: si al cliente le toca el descuento, el asistente lo muestra con los valores ya calculados.
      // Se aparta de verdad al cerrar, por si en el intermedio se acaban los cupos.
      let promo = null;
      if (limpios.length && !ctx.pedido.descuento) {
        promo = await promoParaCliente(ctx.pedido.cliente || ctx.telefono);
        if (promo?.aplica) {
          const { subtotal, total } = totalesDe(ctx.pedido);
          const descuento = valorDescuento(subtotal, promo.porcentaje);
          promo = { ...promo, descuento, total_con_descuento: total - descuento };
        }
      }
      return { ...resumen(ctx.pedido), problemas, ...(promo ? { promo } : {}), ...(acompanar ? { para_acompanar: acompanar } : {}) };
    },

    cerrar_pedido: async ({ paga_con }) => {
      if (CERRADOS.includes(ctx.pedido.status)) throw new Error("Ese pedido ya está en la tienda");
      const yaTenia = Boolean(ctx.pedido.descuento);
      const descuento = await apartarPromo(ctx.pedido);
      let resultado;
      try {
        resultado = cerrar(ctx.pedido, paga_con);
      } catch (error) {
        // Si falta algo para cerrar, el descuento apartado en este intento no se gasta todavía. Uno que el
        // pedido ya tenía (de un cierre anterior, por ejemplo al cambiar la forma de pago) se conserva.
        if (descuento && !yaTenia) await soltarPromo(ctx.pedido);
        throw error;
      }
      await guardarPedido(ctx.pedido);
      // La dirección queda para ofrecérsela en el próximo pedido.
      await recordarDireccion(ctx.telefono, ctx.pedido.direccion).catch(() => {});
      if (!descuento) return resultado;
      const valor = totalesDe(ctx.pedido).descuento ?? 0;
      return {
        ...resultado,
        descuento: { porcentaje: descuento.pct, valor, tipo: descuento.tipo === "sorpresa" ? "sorpresa" : "de bienvenida" },
        nota_descuento:
          descuento.tipo === "sorpresa"
            ? `¡Le salió el descuento sorpresa del ${descuento.pct} %! Cuéntaselo con alegría en una frase corta y dale el total ya con el descuento.`
            : `Tiene el ${descuento.pct} % de descuento de bienvenida en los productos: menciónalo al confirmar el total.`,
      };
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
  await cargarNegocio();
  const charla = await leerCharla(telefono);
  let guardado = charla.pedidoId ? await leerPedido(charla.pedidoId, true) : null;
  // Conversación nueva: tras dos horas sin escribir (con el pedido abierto o ya cerrado), se empieza de cero (saludo y pedido nuevos). Del pedido anterior solo se le cuenta al
  // asistente lo justo para responder si el cliente pregunta por él.
  let anterior = null;
  const quieto = Date.now() - (charla.ultimo ?? 0);
  const cerradoHace = guardado && CERRADOS.includes(guardado.status) ? quieto : 0;
  if (quieto > SESION_INACTIVA || cerradoHace > CERRADO_HACE) {
    charla.turnos = [];
    charla.botones = [];
    charla.titulos = [];
    // Un pedido que espera el comprobante sigue vigente: el cliente puede volver a mandar la foto.
    // (si no es de hace más de 6 horas: ese ya se da por abandonado).
    if (guardado && (guardado.status !== "esperando_pago" || Date.now() - guardado.hora > 6 * 3600_000)) {
      if (guardado.status !== "armando" && guardado.status !== "entregado" && Date.now() - guardado.hora < 6 * 3600_000) anterior = guardado;
      guardado = null;
    }
  }
  const existencias = await leerExistencias();
  // Si el pedido aún no tiene dirección, el asistente puede ofrecerle las que usó antes.
  const direcciones = guardado?.direccion ? [] : await leerDirecciones(telefono);
  const ctx = { telefono, texto: String(texto || ""), imagen, fotos: 0, botones: [], existencias, agotados: noDisponibles(await leerAgotados(), existencias), pedido: guardado ?? pedidoNuevo("WhatsApp", telefono) };
  const usar = herramientas(ctx);
  const antes = `${ctx.pedido.id}:${ctx.pedido.status}`;

  // Si tocó un botón con el nombre abreviado ("Coca 1.5 L"), se le agrega a qué producto corresponde.
  const tocado = (charla.titulos ?? []).findIndex((t) => t.toLowerCase() === String(texto || "").trim().toLowerCase());
  if (tocado >= 0 && charla.botones?.[tocado] && charla.botones[tocado].toLowerCase() !== charla.titulos[tocado].toLowerCase()) texto = `${texto} (${charla.botones[tocado]})`;
  const dicho = String(texto || "").slice(0, 2000) + (imagen ? " [El cliente adjuntó una imagen en este mensaje]" : "");
  const nota = `\n\n[Estado del pedido en pantalla #${ctx.pedido.no}: ${JSON.stringify(resumen(ctx.pedido))}. ${charla.turnos.length ? "" : "Es el primer mensaje del cliente en esta conversación: salúdalo según el protocolo. "}${direcciones.length && !ctx.pedido.direccion ? `Direcciones que el cliente usó en pedidos anteriores: ${direcciones.map((d) => `"${d}"`).join(" | ")}. ` : ""}${anterior ? `El cliente tiene un pedido anterior, el #${anterior.no}, en estado ${anterior.status}. No lo menciones a menos que pregunte por él; lo que pida ahora es un pedido nuevo. ` : ""}${horario().nota}${charla.botones?.length ? ` Botones que le ofreciste en tu mensaje anterior: ${charla.botones.join(" | ")}.` : ""}]`;
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
  let textoPrevio = "";
  for (let ronda = 0; ronda < 6; ronda++) {
    const { content, stop_reason } = await paso(mensajes);
    if (stop_reason === "refusal") {
      respuesta = "Veci, con eso no te puedo ayudar por acá. ¿Hay algo más en lo que te pueda colaborar?";
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
    // Hay modelos que escriben la respuesta junto con la llamada a la herramienta y luego no agregan
    // nada: ese texto se guarda por si la última ronda llega vacía.
    textoPrevio = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || textoPrevio;
    // Los bloques de Claude vuelven tal cual, incluido su razonamiento, y se agregan al final.
    mensajes.push({ role: "assistant", content }, { role: "user", content: resultados });
  }
  respuesta ||= textoPrevio || "Dame un momento y te confirmo, veci.";
  // La forma de pago siempre va con botones, aunque el modelo haya olvidado pedirlos.
  if (!ctx.botones.length && ctx.pedido.status === "armando" && ctx.pedido.items.length && !ctx.pedido.pago && PREGUNTA_PAGO.test(respuesta)) ctx.botones = ["Transferencia", "Efectivo"].map((titulo) => ({ titulo, detalle: "" }));

  // De un mensaje al siguiente solo se guarda el texto de cada turno.
  charla.turnos = [...previos, turno, { role: "assistant", content: respuesta }];
  charla.pedidoId = ctx.pedido.id;
  charla.ultimo = Date.now();
  // Para que en el siguiente mensaje sepa qué opciones tenía el cliente a la vista.
  charla.botones = ctx.botones.map((b) => [b.titulo, b.detalle].filter(Boolean).join(" · "));
  charla.titulos = ctx.botones.length && ctx.botones.length <= 3 ? armarBotones("", ctx.botones).titulos : [];
  await guardarCharla(telefono, charla);
  const despues = `${ctx.pedido.id}:${ctx.pedido.status}`;
  return { texto: respuesta, botones: ctx.botones, enviarQr: despues !== antes && ctx.pedido.status === "esperando_pago" && ctx.pedido.pago === "Transferencia" };
}

const AVISOS = {
  alistando: (p) => (p.programado ? `Pago confirmado. Tu pedido queda programado para el ${p.programado.fijo}.` : p.encargo ? "Pago confirmado. Tu pedido queda como encargo y te lo llevamos apenas abramos domicilios." : "Pago confirmado: tu pedido quedó confirmado ✅ y llega en máximo 15 minutos. Gracias por preferir a Sauko."),
  esperando_pago: () => "No pudimos confirmar el pago de tu pedido. ¿Nos envías de nuevo el comprobante, por favor?",
  en_camino: () => "Veci, tu pedido ya va en camino. 🛵",
  entregado: () => "Pedido entregado. Gracias por comprar en Sauko Store.",
  cancelado: () => "Veci, tu pedido fue cancelado. Si fue un error, escribinos y lo armamos de nuevo.",
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
