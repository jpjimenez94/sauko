// Lo que comparten las funciones de /api: catálogo, PIN del panel y tope de uso del chat.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { leerAjustes } from "./store.js";

const datos = JSON.parse(readFileSync(new URL("../public/catalog.json", import.meta.url), "utf8"));
/** sku -> { nombre, precio } con los precios publicados: la fuente para recalcular cada pedido. */
export const CATALOGO = new Map();
for (const [sku, nombre, precio, tipo, foto] of datos.rows) if (!CATALOGO.has(sku)) CATALOGO.set(sku, { nombre, precio, tipo, foto: Boolean(foto) });

export const METODOS_PAGO = ["Transferencia", "Contraentrega"];

// Parámetros del negocio. Los cambia el administrador desde el panel (pestaña Ajustes) y se guardan
// con los demás ajustes; mientras no los toque, valen los de las variables de entorno o estos de fábrica.
// Horario de domicilios, en hora de Cali:
// - De domiDesde a domiHasta sale el domiciliario: tarifa normal.
// - De domiHasta a domiPrimeHasta lo lleva el personal del local: tarifa prime, más cara.
//   Para no tener horario prime, se pone domiPrimeHasta igual a domiHasta.
// - El resto del tiempo no hay domicilio: el pedido queda como encargo para el día siguiente.
const numero = (valor, porDefecto) => (Number.isFinite(Number(valor)) && valor !== undefined && valor !== null && valor !== "" ? Number(valor) : porDefecto);
const entero = (valor, porDefecto, min, max) => Math.min(max, Math.max(min, Math.round(numero(valor, porDefecto))));
const corto = (valor, porDefecto, max) => (typeof valor === "string" ? valor.replace(/\s+/g, " ").trim().slice(0, max) : porDefecto);

function deFabrica() {
  return {
    domiDesde: numero(process.env.DOMI_DESDE, 9),
    domiHasta: numero(process.env.DOMI_HASTA, 21),
    domiPrimeHasta: numero(process.env.DOMI_PRIME_HASTA, 22),
    costoDomicilio: numero(process.env.COSTO_DOMICILIO, 2000),
    costoDomicilioPrime: numero(process.env.COSTO_DOMICILIO_PRIME, 4000),
    banco: "",
    cuenta: "",
    titular: "",
    llave: "",
    listaDePrueba: process.env.WHATSAPP_SOLO_NUMEROS ?? "",
    pausaMinutos: 30,
  };
}

/** Deja los parámetros en rangos con sentido; lo que falte o venga mal toma el valor de base. */
export function negocioLimpio(entrada = {}, base = deFabrica()) {
  const domiDesde = entero(entrada.domiDesde, base.domiDesde, 0, 23);
  const domiHasta = entero(entrada.domiHasta, base.domiHasta, domiDesde + 1, 24);
  return {
    domiDesde,
    domiHasta,
    domiPrimeHasta: entero(entrada.domiPrimeHasta, base.domiPrimeHasta, domiHasta, 24),
    costoDomicilio: entero(entrada.costoDomicilio, base.costoDomicilio, 0, 100000),
    costoDomicilioPrime: entero(entrada.costoDomicilioPrime, base.costoDomicilioPrime, 0, 100000),
    banco: corto(entrada.banco, base.banco, 60),
    cuenta: corto(entrada.cuenta, base.cuenta, 40),
    titular: corto(entrada.titular, base.titular, 80),
    llave: corto(entrada.llave, base.llave, 60),
    listaDePrueba: corto(entrada.listaDePrueba, base.listaDePrueba, 600),
    pausaMinutos: entero(entrada.pausaMinutos, base.pausaMinutos, 0, 720),
  };
}

let negocio = negocioLimpio();
export const negocioActual = () => negocio;
let leidoEn = 0;
/** Trae del almacén lo que el administrador haya cambiado. Cada función de /api lo llama al empezar. */
export async function cargarNegocio(forzar = false) {
  if (!forzar && Date.now() - leidoEn < 5000) return negocio;
  negocio = negocioLimpio((await leerAjustes()).negocio ?? {});
  leidoEn = Date.now();
  return negocio;
}

const pesos = (n) => "$" + n.toLocaleString("es-CO");
const hora12 = (h) => `${h % 12 || 12} ${h % 24 < 12 ? "a.m." : "p.m."}`;

/** El horario de domicilios vigente en una frase, tal como está en los Ajustes del panel. */
export function horarioEnTexto() {
  const { domiDesde, domiHasta, domiPrimeHasta, costoDomicilio, costoDomicilioPrime } = negocio;
  const prime = domiPrimeHasta > domiHasta ? `; de ${hora12(domiHasta)} a ${hora12(domiPrimeHasta)} es horario prime y cuesta ${pesos(costoDomicilioPrime)}` : "";
  return `Horario de domicilios: de ${hora12(domiDesde)} a ${hora12(domiHasta)} cuesta ${pesos(costoDomicilio)}${prime}. Después de las ${hora12(domiPrimeHasta)} no hay domicilio y el pedido queda como encargo para el día siguiente.`;
}

/** Saludo según la hora en Cali. */
export function saludoDeLaHora(ahora = new Date()) {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hour12: false }).format(ahora)) % 24;
  return h < 12 ? "Buenos días" : h < 18 ? "Buenas tardes" : "Buenas noches";
}

/** Franja vigente y lo que el asistente debe saber de ella. */
export function horario(ahora = new Date()) {
  const { domiDesde: DOMI_DESDE, domiHasta: DOMI_HASTA, domiPrimeHasta: DOMI_PRIME_HASTA, costoDomicilio: COSTO_DOMICILIO, costoDomicilioPrime: COSTO_DOMICILIO_PRIME } = negocio;
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ahora);
  const h = Number(partes.find((p) => p.type === "hour").value) % 24;
  const reloj = `${hora12(h).replace(" ", ":" + partes.find((p) => p.type === "minute").value + " ")}`;
  // El horario completo va en todas las notas, para que el asistente no dependa de horas fijas.
  const completo = `${horarioEnTexto()} Saludo de la hora: ${saludoDeLaHora(ahora)}.`;
  if (h >= DOMI_DESDE && h < DOMI_HASTA) {
    return { franja: "normal", costoDomicilio: COSTO_DOMICILIO, encargo: "", nota: `Son las ${reloj} en Cali. Hay domicilios: cuesta ${pesos(COSTO_DOMICILIO)} y llega en máximo 10 minutos. ${completo}` };
  }
  if (h >= DOMI_HASTA && h < DOMI_PRIME_HASTA) {
    return {
      franja: "prime",
      costoDomicilio: COSTO_DOMICILIO_PRIME,
      encargo: "",
      nota: `Son las ${reloj} en Cali. Horario prime (de ${hora12(DOMI_HASTA)} a ${hora12(DOMI_PRIME_HASTA)}): el domicilio cuesta ${pesos(COSTO_DOMICILIO_PRIME)} en vez de ${pesos(COSTO_DOMICILIO)}. Díselo al cliente antes de cerrar el pedido. ${completo}`,
    };
  }
  const cuando = h >= DOMI_PRIME_HASTA ? "mañana" : "hoy";
  const encargo = `Encargo: entregar ${cuando} desde las ${hora12(DOMI_DESDE)}`;
  return {
    franja: "cerrado",
    costoDomicilio: COSTO_DOMICILIO,
    encargo,
    nota: `Son las ${reloj} en Cali. A esta hora no hay domicilios (van de ${hora12(DOMI_DESDE)} a ${hora12(DOMI_PRIME_HASTA)}). No prometas entrega ahora: ofrece dejar el pedido como encargo para entregarlo ${cuando} desde las ${hora12(DOMI_DESDE)}, con domicilio de ${pesos(COSTO_DOMICILIO)}. ${completo}`,
  };
}

/** Cuenta y llave para transferir, tal como se le dictan al cliente. Vacío mientras no se configure. */
export function datosTransferencia() {
  const { banco, cuenta, titular, llave } = negocio;
  if (!cuenta && !llave) return (process.env.DATOS_TRANSFERENCIA ?? "").trim();
  const partes = [];
  if (cuenta) partes.push([banco, "cuenta " + cuenta].filter(Boolean).join(", ") + (titular ? ", a nombre de " + titular : ""));
  if (llave) partes.push("Llave: " + llave);
  return partes.join(". ");
}
/** Dirección pública del sitio, para los enlaces que se mandan por WhatsApp (como el QR de pago). */
export const sitio = () => (process.env.SITIO_URL || "https://www.saukostoreminimarket.com").replace(/\/+$/, "");

// Entregas programadas: el cliente puede pedir que le llegue a una hora de hoy o de mañana, dentro
// del horario de domicilios. El domicilio se cobra según la franja de esa hora. Cali va 5 horas
// detrás de UTC todo el año.
const CALI = 5 * 3600_000;
const fechaCali = (fecha) => new Date(fecha.getTime() - CALI).toISOString().slice(0, 10);

/** Revisa un momento de entrega. Devuelve { ts, texto, fijo } o { error } con lo que hay que decirle al cliente. */
export function revisarProgramado(ts, ahora = new Date()) {
  ts = Number(ts);
  if (!Number.isFinite(ts)) return { error: "No se entendió la hora de entrega." };
  const { domiDesde, domiPrimeHasta } = negocio;
  const local = new Date(ts - CALI);
  const h = local.getUTCHours();
  const min = local.getUTCMinutes();
  if (h < domiDesde || h >= domiPrimeHasta) return { error: `A esa hora no hay domicilios. Las entregas se programan entre las ${hora12(domiDesde)} y las ${hora12(domiPrimeHasta)}` };
  if (ts < ahora.getTime() + 15 * 60_000) return { error: "Esa hora ya pasó o es en menos de 15 minutos. Si es para ya, no se programa: el pedido sale de inmediato." };
  if (ts > ahora.getTime() + 48 * 3600_000) return { error: "Solo se programan entregas para hoy o para mañana." };
  const reloj = `${h % 12 || 12}:${String(min).padStart(2, "0")} ${h < 12 ? "a.m." : "p.m."}`;
  const dia = fechaCali(new Date(ts)) === fechaCali(ahora) ? "hoy" : "mañana";
  const fecha = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", weekday: "long", day: "numeric", month: "long" }).format(new Date(ts));
  return { ts, texto: `${dia} a las ${reloj}`, fijo: `${fecha}, ${reloj}` };
}

/** @param {string} dia "hoy" o "mañana" @param {string} hora en 24 horas: "21:30" */
export function programar(dia, hora, ahora = new Date()) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(hora ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) return { error: 'La hora de entrega debe venir en formato de 24 horas, por ejemplo "21:30".' };
  const [anio, mes, d] = fechaCali(ahora).split("-").map(Number);
  const maniana = /ma[ñn]ana/i.test(String(dia ?? ""));
  return revisarProgramado(Date.UTC(anio, mes - 1, d + (maniana ? 1 : 0), Number(m[1]) + 5, Number(m[2] ?? 0)), ahora);
}

/** El momento con el que se cobra el domicilio de un pedido: su hora programada o ahora mismo. */
export const momentoDe = (pedido) => (pedido?.programado?.ts ? new Date(pedido.programado.ts) : new Date());

/** El domicilio depende de la hora en que se calcula. @param {{qty: number, price: number}[]} items */
export function totales(items, ahora = new Date()) {
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const domicilio = subtotal === 0 ? 0 : horario(ahora).costoDomicilio;
  return { subtotal, domicilio, total: subtotal + domicilio };
}

/**
 * PIN de instalación (PANEL_PIN): solo sirve para crear el primer administrador del panel.
 * Después de eso el panel se usa con usuario y contraseña. En local, sin PIN definido, se acepta.
 */
export function pinDeInstalacionValido(req) {
  const esperado = process.env.PANEL_PIN;
  if (!esperado) return !process.env.VERCEL;
  const recibido = String(req.headers["x-panel-pin"] ?? "");
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
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
