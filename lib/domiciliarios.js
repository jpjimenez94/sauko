// El domiciliario recibe cada pedido por WhatsApp desde el número de la tienda y, al entregarlo,
// responde con el código y una foto; con eso el pedido queda entregado solo. El código lo tiene el
// domiciliario, no el cliente: la foto y el código prueban que la tienda entregó bien.
//
// WhatsApp solo deja escribirle libremente a quien escribió en las últimas 24 horas, por eso el
// domiciliario escribe "inicio turno" al empezar el día (y cada entrega renueva la ventana).
import { leerAjustes, listarPedidos, guardarPedido, anotar, marcarTurno, turnoDe, esperarFotoDe, tomarCodigoEsperado, leerConversacion } from "./store.js";
import { enviarTexto } from "./whatsapp.js";
import { avisoDeTienda } from "./conversacion.js";
import { avisarEntrega } from "./opiniones.js";

const digitos = (t) => String(t ?? "").replace(/\D/g, "");
const pesos = (n) => "$" + Math.round(n).toLocaleString("es-CO");

/**
 * WhatsApp del domiciliario como se compara: un celular colombiano de 10 dígitos lleva el 57 adelante.
 * Quien usa nombre de usuario en WhatsApp no comparte su número: se registra como "@usuario".
 */
export function telefonoDomiciliario(t) {
  const texto = String(t ?? "").trim();
  if (texto.startsWith("@")) return "@" + texto.slice(1).replace(/\s/g, "").toLowerCase();
  const d = digitos(texto);
  return d.length === 10 && d.startsWith("3") ? "57" + d : d;
}

export async function leerDomiciliarios() {
  const lista = (await leerAjustes()).domiciliarios;
  return Array.isArray(lista) ? lista : [];
}

/** El domiciliario activo que escribió (por su número o por su @usuario de WhatsApp), o null. */
export async function domiciliarioDe(telefono, usuario = "") {
  const arroba = usuario ? "@" + String(usuario).replace(/^@/, "").toLowerCase() : "";
  return (await leerDomiciliarios()).find((d) => {
    if (!d.activo) return false;
    const registrado = telefonoDomiciliario(d.telefono);
    return registrado.startsWith("@") ? registrado === arroba : registrado === digitos(telefono);
  }) ?? null;
}

// Palabras de tipo de producto que no ayudan a reconocer la bolsa.
const GENERICAS = new Set(["cerveza", "gaseosa", "jugo", "agua", "bebida", "galleta", "galletas", "salsa", "alimento"]);

/** "Manzano torre 2 apto 208" → "Manzano T2-208". */
export function ubicacionCorta(direccion) {
  return String(direccion ?? "")
    .replace(/,/g, " ")
    .replace(/\b(conjunto|unidad|residencial|edificio|cr|conj)\b\.?/gi, "")
    .replace(/\btorre\s*/gi, "T")
    .replace(/\s*\b(apartamento|apto|apt|ap)\b\.?\s*/gi, "-")
    .replace(/\s*\bcasa\b\s*/gi, " casa ")
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .trim()
    .slice(0, 30);
}

/** Lo más visible del pedido: el producto con más unidades (o el más caro si empatan), abreviado. */
function principal(items) {
  const it = [...items].sort((a, b) => b.qty - a.qty || b.qty * b.price - a.qty * a.price)[0];
  if (!it) return "";
  const palabras = String(it.name).split(" ").filter((p, i) => !(i === 0 && GENERICAS.has(p.toLowerCase())));
  let nombre = "";
  for (const p of palabras) {
    if (`${nombre} ${p}`.trim().length > 20) break;
    nombre = `${nombre} ${p}`.trim();
  }
  return `${it.qty} ${nombre}`;
}

/** El título que distingue un pedido de otro en el chat del domiciliario. */
export const tituloDePedido = (p) => [p.codigo, ubicacionCorta(p.direccion), principal(p.items)].filter(Boolean).join(" · ");

export function mensajeParaDomiciliario(p) {
  const lineas = [`*${tituloDePedido(p)}*`, "", `Entregar en: ${p.direccion}`];
  if (p.programado?.fijo) lineas.push(`Hora de entrega: ${p.programado.fijo}`);
  lineas.push(...p.items.map((i) => `• ${i.qty} ${i.name}`), "");
  if (p.pago === "Contraentrega") {
    const devuelta = Math.max(0, (p.pagaCon || 0) - p.total);
    lineas.push(`💵 *Cobrar ${pesos(p.total)} en efectivo.*${p.pagaCon ? ` Paga con ${pesos(p.pagaCon)}: llevar ${pesos(devuelta)} de devuelta.` : ""} No entregar sin cobrar. El dinero va a la caja.`);
  } else lineas.push("✅ *Pagado por transferencia: no cobrar nada.*");
  lineas.push("", `Al entregar, respondé con el número de la bolsa (*${p.codigo}*) y una foto del pedido entregado.`);
  return lineas.join("\n");
}

/**
 * Al despachar: asigna el domiciliario (el elegido o, si hay uno solo activo, ese) y le manda el pedido.
 * Devuelve el domiciliario asignado y si el mensaje salió (no sale si no ha iniciado turno).
 */
export async function asignarYAvisar(pedido, idElegido) {
  const activos = (await leerDomiciliarios()).filter((d) => d.activo);
  const domi = activos.find((d) => d.id === idElegido) ?? (activos.length === 1 ? activos[0] : null);
  if (!domi) return { asignado: null, enviado: false };
  pedido.domiciliario = { id: domi.id, nombre: domi.nombre };
  // Se le escribe por donde escribió al iniciar turno (sirve también si usa @usuario).
  const destino = await turnoDe(domi.id);
  const abierto = Boolean(destino);
  const enviado = abierto ? await enviarTexto(destino, mensajeParaDomiciliario(pedido)) : false;
  pedido.avisoDomiciliario = enviado ? "enviado" : abierto ? "falló" : "sin turno";
  if (!enviado) await anotar(abierto ? "no se pudo avisar al domiciliario" : "el domiciliario no ha iniciado turno", `pedido #${pedido.no}`);
  return { asignado: domi, enviado };
}

/** Marca entregado el pedido con la foto del domiciliario y avisa al cliente. */
async function entregar(pedido, domi, foto) {
  Object.assign(pedido, {
    status: "entregado",
    entregadoEn: Date.now(),
    entregadoPor: domi.nombre,
    fotoEntrega: foto && foto.length <= 300_000 ? foto : "",
    fotoPesada: Boolean(foto && foto.length > 300_000),
    // Lo cobrado en efectivo queda pendiente de llegar a la caja.
    efectivoPorEntregar: pedido.pago === "Contraentrega" ? pedido.total : 0,
  });
  await guardarPedido(pedido);
  const aviso = await avisoDeTienda(pedido);
  if (aviso) await avisarEntrega(pedido, aviso);
}

/**
 * Si el domiciliario escribió antes de que lo agregaran (o activaran) en el panel, ese mensaje no abrió
 * su turno porque el sistema aún no lo conocía. Al agregarlo se revisa: si escribió a la línea actual en
 * las últimas 24 horas, el turno se abre de una y le llegan los pedidos pendientes.
 */
export async function abrirTurnoSiYaEscribio(domi) {
  if (!domi?.activo || String(domi.telefono).startsWith("@") || (await turnoDe(domi.id))) return false;
  const { ficha } = await leerConversacion(domi.telefono, 1);
  const linea = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!ficha?.ultimoCliente || Date.now() - ficha.ultimoCliente > 23.5 * 3600_000 || (linea && ficha.linea !== linea)) return false;
  await atenderDomiciliario({ telefono: domi.telefono, tipo: "text", texto: "" });
  await anotar("turno abierto al agregar al domiciliario", `${domi.nombre}: ya había escrito`);
  return true;
}

/**
 * Atiende un mensaje del domiciliario. Devuelve true si el teléfono es de un domiciliario activo
 * (sus mensajes nunca van al asistente de ventas).
 */
export async function atenderDomiciliario({ telefono, usuario = "", tipo, texto = "", bajar }) {
  const domi = await domiciliarioDe(telefono, usuario);
  if (!domi) return false;
  const yaTeniaTurno = Boolean(await turnoDe(domi.id));
  await marcarTurno(domi.id, telefono);
  const codigo = /\b(\d{4})\b/.exec(String(texto))?.[1] ?? null;
  const enCamino = (await listarPedidos()).filter((p) => p.status === "en_camino" && p.domiciliario?.id === domi.id);

  if (tipo === "image") {
    const elCodigo = codigo ?? (await tomarCodigoEsperado(telefono));
    if (!elCodigo) {
      await enviarTexto(telefono, enCamino.length ? "Recibí la foto, pero ¿de cuál pedido es? Mandame el número de la bolsa (4 cifras)." : "Recibí la foto, pero no tenés pedidos en camino.");
      return true;
    }
    const pedido = enCamino.find((p) => p.codigo === elCodigo);
    if (!pedido) {
      await enviarTexto(telefono, `El número ${elCodigo} no corresponde a ninguno de tus pedidos en camino. Revisalo y mandalo de nuevo con la foto.`);
      return true;
    }
    const imagen = await bajar?.();
    await entregar(pedido, domi, imagen ? `data:${imagen.mediaType};base64,${imagen.base64}` : "");
    await anotar("el domiciliario entregó", `pedido #${pedido.no}`);
    await enviarTexto(telefono, `✅ Entregado: ${tituloDePedido(pedido)}${pedido.pago === "Contraentrega" ? `\nRecordá llevar ${pesos(pedido.total)} a la caja.` : ""}`);
    return true;
  }

  if (codigo) {
    const pedido = enCamino.find((p) => p.codigo === codigo);
    if (!pedido) await enviarTexto(telefono, `El número ${codigo} no corresponde a ninguno de tus pedidos en camino. Revisalo y mandalo de nuevo.`);
    else {
      await esperarFotoDe(telefono, codigo);
      await enviarTexto(telefono, `Listo, ${tituloDePedido(pedido)}. Ahora mandá la foto del pedido entregado.`);
    }
    return true;
  }

  // Cualquier otro mensaje abre o renueva el turno. Los pedidos que se le despacharon mientras no tenía
  // turno (no se le pudo escribir) le llegan ahora completos.
  for (const p of enCamino.filter((x) => x.avisoDomiciliario !== "enviado")) {
    if (await enviarTexto(telefono, mensajeParaDomiciliario(p))) {
      p.avisoDomiciliario = "enviado";
      await guardarPedido(p);
    }
  }
  const pendientes = enCamino.length ? `\nTenés ${enCamino.length} ${enCamino.length === 1 ? "pedido" : "pedidos"} en camino:\n${enCamino.map((p) => "• " + tituloDePedido(p)).join("\n")}` : "";
  await enviarTexto(telefono, yaTeniaTurno
    ? `Hola, ${domi.nombre}. Al entregar, respondé con el número de la bolsa y una foto.${pendientes}`
    : `Turno iniciado, ${domi.nombre}. 👍 Te aviso por aquí cada pedido.${pendientes}`);
  return true;
}
