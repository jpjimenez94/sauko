// Lo que comparten las funciones de /api: catálogo, PIN del panel y tope de uso del chat.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const datos = JSON.parse(readFileSync(new URL("../public/catalog.json", import.meta.url), "utf8"));
/** sku -> { nombre, precio } con los precios publicados: la fuente para recalcular cada pedido. */
export const CATALOGO = new Map();
for (const [sku, nombre, precio] of datos.rows) if (!CATALOGO.has(sku)) CATALOGO.set(sku, { nombre, precio });

export const DOMICILIO_GRATIS_DESDE = 20000;
export const COSTO_DOMICILIO = 2000;

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
