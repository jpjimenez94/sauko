// Lo que comparten las funciones de /api: catálogo, PIN del panel y tope de uso del chat.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { leerAjustes } from "./store.js";

const datos = JSON.parse(readFileSync(new URL("../public/catalog.json", import.meta.url), "utf8"));
/** sku -> { nombre, precio } con los precios publicados: la fuente para recalcular cada pedido. */
export const CATALOGO = new Map();
for (const [sku, nombre, precio] of datos.rows) if (!CATALOGO.has(sku)) CATALOGO.set(sku, { nombre, precio });

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
let leidoEn = 0;
/** Trae del almacén lo que el administrador haya cambiado. Cada función de /api lo llama al empezar. */
export async function cargarNegocio(forzar = false) {
  if (!forzar && Date.now() - leidoEn < 5000) return negocio;
  negocio = negocioLimpio((await leerAjustes()).negocio ?? {});
  leidoEn = Date.now();
  return negocio;
}

const pesos = (n) => "$" + n.toLocaleString("es-CO");
const hora12 = (h) => `${h % 12 || 12} ${h < 12 ? "a.m." : "p.m."}`;

/** Franja vigente y lo que el asistente debe saber de ella. */
export function horario(ahora = new Date()) {
  const { domiDesde: DOMI_DESDE, domiHasta: DOMI_HASTA, domiPrimeHasta: DOMI_PRIME_HASTA, costoDomicilio: COSTO_DOMICILIO, costoDomicilioPrime: COSTO_DOMICILIO_PRIME } = negocio;
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ahora);
  const h = Number(partes.find((p) => p.type === "hour").value) % 24;
  const reloj = `${hora12(h).replace(" ", ":" + partes.find((p) => p.type === "minute").value + " ")}`;
  if (h >= DOMI_DESDE && h < DOMI_HASTA) {
    return { franja: "normal", costoDomicilio: COSTO_DOMICILIO, encargo: "", nota: `Son las ${reloj} en Cali. Hay domicilios: cuesta ${pesos(COSTO_DOMICILIO)} y llega en máximo 10 minutos.` };
  }
  if (h >= DOMI_HASTA && h < DOMI_PRIME_HASTA) {
    return {
      franja: "prime",
      costoDomicilio: COSTO_DOMICILIO_PRIME,
      encargo: "",
      nota: `Son las ${reloj} en Cali. Horario prime (de ${hora12(DOMI_HASTA)} a ${hora12(DOMI_PRIME_HASTA)}): el domicilio cuesta ${pesos(COSTO_DOMICILIO_PRIME)} en vez de ${pesos(COSTO_DOMICILIO)}. Díselo al cliente antes de cerrar el pedido.`,
    };
  }
  const cuando = h >= DOMI_PRIME_HASTA ? "mañana" : "hoy";
  const encargo = `Encargo: entregar ${cuando} desde las ${hora12(DOMI_DESDE)}`;
  return {
    franja: "cerrado",
    costoDomicilio: COSTO_DOMICILIO,
    encargo,
    nota: `Son las ${reloj} en Cali. A esta hora no hay domicilios (van de ${hora12(DOMI_DESDE)} a ${hora12(DOMI_PRIME_HASTA)}). No prometas entrega ahora: ofrece dejar el pedido como encargo para entregarlo ${cuando} desde las ${hora12(DOMI_DESDE)}, con domicilio de ${pesos(COSTO_DOMICILIO)}.`,
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
