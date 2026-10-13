// Lo que comparten las funciones de /api: catálogo, PIN del panel y tope de uso del chat.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const datos = JSON.parse(readFileSync(new URL("../public/catalog.json", import.meta.url), "utf8"));
/** sku -> { nombre, precio } con los precios publicados: la fuente para recalcular cada pedido. */
export const CATALOGO = new Map();
for (const [sku, nombre, precio] of datos.rows) if (!CATALOGO.has(sku)) CATALOGO.set(sku, { nombre, precio });

export const METODOS_PAGO = ["Transferencia", "Contraentrega"];

// Horario de domicilios, en hora de Cali:
// - De DOMI_DESDE a DOMI_HASTA sale el domiciliario: tarifa normal.
// - De DOMI_HASTA a DOMI_PRIME_HASTA lo lleva el personal del local: tarifa prime, más cara.
//   Para no tener horario prime, se pone DOMI_PRIME_HASTA igual a DOMI_HASTA.
// - El resto del tiempo no hay domicilio: el pedido queda como encargo para el día siguiente.
const numero = (valor, porDefecto) => (Number.isFinite(Number(valor)) && valor !== undefined && valor !== "" ? Number(valor) : porDefecto);
const DOMI_DESDE = numero(process.env.DOMI_DESDE, 9);
const DOMI_HASTA = numero(process.env.DOMI_HASTA, 21);
const DOMI_PRIME_HASTA = Math.max(DOMI_HASTA, numero(process.env.DOMI_PRIME_HASTA, 22));
export const COSTO_DOMICILIO = numero(process.env.COSTO_DOMICILIO, 2000);
const COSTO_DOMICILIO_PRIME = numero(process.env.COSTO_DOMICILIO_PRIME, 4000);

const pesos = (n) => "$" + n.toLocaleString("es-CO");
const hora12 = (h) => `${h % 12 || 12} ${h < 12 ? "a.m." : "p.m."}`;

/** Franja vigente y lo que el asistente debe saber de ella. */
export function horario(ahora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ahora);
  const h = Number(partes.find((p) => p.type === "hour").value) % 24;
  const reloj = `${hora12(h).replace(" ", ":" + partes.find((p) => p.type === "minute").value + " ")}`;
  if (h >= DOMI_DESDE && h < DOMI_HASTA) {
    return { franja: "normal", costoDomicilio: COSTO_DOMICILIO, encargo: "", nota: `Son las ${reloj} en Cali.Hay domicilios: cuesta ${pesos(COSTO_DOMICILIO)} y llega en máximo 10 minutos.` };
  }
  if (h >= DOMI_HASTA && h < DOMI_PRIME_HASTA) {
    return {
      franja: "prime",
      costoDomicilio: COSTO_DOMICILIO_PRIME,
      encargo: "",
      nota: `Son las ${reloj} en Cali.Horario prime (de ${hora12(DOMI_HASTA)} a ${hora12(DOMI_PRIME_HASTA)}): el domicilio cuesta ${pesos(COSTO_DOMICILIO_PRIME)} en vez de ${pesos(COSTO_DOMICILIO)}. Díselo al cliente antes de cerrar el pedido.`,
    };
  }
  const cuando = h >= DOMI_PRIME_HASTA ? "mañana" : "hoy";
  const encargo = `Encargo: entregar ${cuando} desde las ${hora12(DOMI_DESDE)}`;
  return {
    franja: "cerrado",
    costoDomicilio: COSTO_DOMICILIO,
    encargo,
    nota: `Son las ${reloj} en Cali.A esta hora no hay domicilios (van de ${hora12(DOMI_DESDE)} a ${hora12(DOMI_PRIME_HASTA)}). No prometas entrega ahora: ofrece dejar el pedido como encargo para entregarlo ${cuando} desde las ${hora12(DOMI_DESDE)}, con domicilio de ${pesos(COSTO_DOMICILIO)}.`,
  };
}

/** Cuenta y llave para transferir, tal como se le dictan al cliente. Vacío mientras no se configure. */
export const datosTransferencia = () => (process.env.DATOS_TRANSFERENCIA ?? "").trim();
/** Dirección pública del sitio, para los enlaces que se mandan por WhatsApp (como el QR de pago). */
export const sitio = () => (process.env.SITIO_URL || "https://www.saukostoreminimarket.com").replace(/\/+$/, "");

/** El domicilio depende de la hora en que se calcula. @param {{qty: number, price: number}[]} items */
export function totales(items, ahora = new Date()) {
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const domicilio = subtotal === 0 ? 0 : horario(ahora).costoDomicilio;
  return { subtotal, domicilio, total: subtotal + domicilio };
}

/** El panel y sus acciones piden el PIN de la tienda. En local, sin PANEL_PIN definido, queda abierto. */
export function pinValido(req) {
  const esperado = process.env.PANEL_PIN;
  if (!esperado) return !process.env.VERCEL;
  const recibido = String(req.headers["x-panel-pin"] ?? "");
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function exigirPin(req, res) {
  if (pinValido(req)) return true;
  res.status(process.env.PANEL_PIN ? 401 : 503).json({
    error: process.env.PANEL_PIN ? "PIN incorrecto." : "Falta configurar PANEL_PIN en el servidor.",
  });
  return false;
}

// Tope de mensajes al asistente, para que nadie gaste la cuenta de IA. Es por instancia del
// servidor, así que en Vercel es aproximado; el tope duro se pone en la consola de Anthropic.
const MAX_HORA_IP = Number(process.env.CHAT_MAX_POR_HORA_IP || 120);
const MAX_DIA = Number(process.env.CHAT_MAX_POR_DIA || 4000);
globalThis.__saukoUso ??= { dia: "", total: 0, porIp: new Map() };
const uso = globalThis.__saukoUso;

export function dentroDelTope(req) {
  const ahora = Date.now();
  const hoy = new Date(ahora).toISOString().slice(0, 10);
  if (uso.dia !== hoy) Object.assign(uso, { dia: hoy, total: 0, porIp: new Map() });
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "local").split(",")[0].trim();
  const recientes = (uso.porIp.get(ip) ?? []).filter((t) => ahora - t < 3600_000);
  if (uso.total >= MAX_DIA || recientes.length >= MAX_HORA_IP) return false;
  recientes.push(ahora);
  uso.porIp.set(ip, recientes);
  uso.total += 1;
  return true;
}
