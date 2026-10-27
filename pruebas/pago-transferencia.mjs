// Un pedido por transferencia que ya espera el comprobante no pasa a efectivo (ni a la tienda sin validar
// el pago) porque el cliente escribe un valor como "100000". Con el modelo simulado: no gasta IA real.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
Object.assign(process.env, { ANTHROPIC_API_KEY: "prueba", SAUKO_MODEL: "claude-haiku-5-5" });
// Lo que "responde" el modelo, en orden.
const guion = [];
let n = 0;
const herramienta = (name, input) => ({ content: [{ type: "tool_use", id: "t" + ++n, name, input }], stop_reason: "tool_use" });
const texto = (t) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
globalThis.fetch = async (url) => {
  if (!String(url).includes("anthropic.com")) return new Response("{}", { status: 200 });
  const r = guion.shift() ?? texto("Listo, veci.");
  return new Response(JSON.stringify({ id: "m" + n, type: "message", role: "assistant", model: "claude-haiku-5-5", ...r, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const store = await import(raiz + "lib/store.js");
const { atenderWhatsApp } = await import(raiz + "lib/conversacion.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const CL = "573004445566";
const items = [{ sku: "7702535024423", cantidad: 2 }];

guion.push(herramienta("guardar_pedido", { items, direccion: "Caleñitas torre 3 apto 573", metodo_pago: "Transferencia" }), herramienta("cerrar_pedido", {}), texto("Pasame el comprobante, porfa."));
await atenderWhatsApp(CL, "transferencia");
let pedido = await store.leerPedido((await store.leerCharla(CL)).pedidoId);
ok("cerrado por transferencia: espera el comprobante", pedido.status === "esperando_pago" && pedido.pago === "Transferencia");

guion.push(herramienta("guardar_pedido", { items, direccion: "Caleñitas torre 3 apto 573", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 100000 }), texto("Listo."));
await atenderWhatsApp(CL, "100000");
pedido = await store.leerPedido(pedido.id);
ok("el cliente escribe '100000': sigue por transferencia esperando el comprobante (no va a la tienda)", pedido.status === "esperando_pago" && pedido.pago === "Transferencia");

guion.push(herramienta("guardar_pedido", { items, direccion: "Caleñitas torre 3 apto 573", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 100000 }), texto("Listo, en efectivo."));
await atenderWhatsApp(CL, "mejor pago en efectivo con 100000");
pedido = await store.leerPedido(pedido.id);
ok("si pide efectivo con palabras, sí cambia", pedido.status === "alistando" && pedido.pago === "Contraentrega" && pedido.pagaCon === 100000);

// El descuento que el pedido ya tenía no se pierde si un nuevo intento de cierre falla.
await store.guardarAjustes({ promo: { activa: true, pct: 5, cupo: 10, sorpresaPct: 10, sorpresaTope: 0, sorpresaCada: 8 } });
const CL2 = "573007778899";
guion.push(herramienta("guardar_pedido", { items, direccion: "Torre 1 apto 101", metodo_pago: "Transferencia" }), herramienta("cerrar_pedido", {}), texto("Pasame el comprobante."));
await atenderWhatsApp(CL2, "transferencia");
let p2 = await store.leerPedido((await store.leerCharla(CL2)).pedidoId);
ok("cerrado con el 5 % de bienvenida", p2.descuento?.pct === 5);
guion.push(herramienta("guardar_pedido", { items, direccion: "Torre 1 apto 101", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 1000 }), texto("¿Con cuánto pagás?"));
await atenderWhatsApp(CL2, "mejor en efectivo");
p2 = await store.leerPedido(p2.id);
ok("un cierre que falla (falta con cuánto paga) no le quita el descuento", p2.descuento?.pct === 5);

// Después de un pedido cancelado, lo que pide el cliente es un pedido nuevo (el cancelado no revive).
const CL3 = "573001231234";
guion.push(herramienta("guardar_pedido", { items, direccion: "Torre 2 apto 202", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 50000 }), texto("Confirmado."));
await atenderWhatsApp(CL3, "efectivo con 50000");
const primero = await store.leerPedido((await store.leerCharla(CL3)).pedidoId);
await store.guardarPedido({ ...primero, status: "cancelado", motivoCancelacion: "El cliente canceló" });
guion.push(herramienta("guardar_pedido", { items, direccion: "Torre 2 apto 202", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 50000 }), texto("Confirmado."));
await atenderWhatsApp(CL3, "dame lo mismo en efectivo con 50000");
const segundo = await store.leerPedido((await store.leerCharla(CL3)).pedidoId);
ok("pedido nuevo después de uno cancelado (el cancelado sigue cancelado)", segundo.id !== primero.id && segundo.status === "alistando" && (await store.leerPedido(primero.id)).status === "cancelado");

// Billetes de Colombia: no se acepta "un billete de 1.000.000" ni valores que no se pueden pagar en efectivo.
const { revisarEfectivo } = await import(raiz + "lib/tienda.js");
ok("con $100.000 para $23.500 está bien", revisarEfectivo(100000, 23500) === null);
ok("con $95.000 (varios billetes) para $23.500 está bien", revisarEfectivo(95000, 23500) === null);
ok("con $1.000.000 para $23.500 no se acepta", /devuelta/.test(revisarEfectivo(1000000, 23500) ?? ""));
ok("con $200.000 para $50.000 no se acepta (sobra un billete)", revisarEfectivo(200000, 50000) !== null);
ok("con $95.030 no se acepta (no hay monedas de $30)", /billetes son/.test(revisarEfectivo(95030, 23500) ?? ""));
ok("con $20.000 para $23.500 no alcanza", /no alcanza/.test(revisarEfectivo(20000, 23500) ?? ""));
const CL4 = "573009990000";
guion.push(herramienta("guardar_pedido", { items, direccion: "Torre 6 apto 606", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 1000000 }), texto("¿Con un billete de $100.000, veci?"));
await atenderWhatsApp(CL4, "efectivo, pago con 1000000");
const p4 = await store.leerPedido((await store.leerCharla(CL4)).pedidoId);
ok("cerrar con 'un billete de 1.000.000' no manda el pedido a la tienda", p4.status === "armando" && !p4.pagaCon);
