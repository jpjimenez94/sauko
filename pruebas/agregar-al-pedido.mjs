// Agregar a un pedido ya cerrado (caso real: pidió una Ponymalta después de cerrar). Mientras el domicilio no
// sale: mismo pedido, sin otro domicilio; en efectivo se vuelve a preguntar con cuánto paga; si ya pagó por
// transferencia, la diferencia la paga como elija. Si ya salió: pedido nuevo. Con el modelo simulado.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
Object.assign(process.env, { ANTHROPIC_API_KEY: "prueba", SAUKO_MODEL: "claude-haiku-5-5" });
const guion = [], herramientasVistas = [];
let n = 0;
const herramienta = (name, input) => ({ content: [{ type: "tool_use", id: "t" + ++n, name, input }], stop_reason: "tool_use" });
const texto = (t) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const resultados = [];
globalThis.fetch = async (url, o = {}) => {
  if (!String(url).includes("anthropic.com")) return new Response("{}", { status: 200 });
  const cuerpo = JSON.parse(o.body);
  herramientasVistas.push(cuerpo.tools.map((t) => t.name));
  const ultimo = cuerpo.messages.at(-1)?.content;
  if (Array.isArray(ultimo)) for (const b of ultimo) if (b.type === "tool_result") resultados.push(b);
  const r = guion.shift() ?? texto("Listo, veci.");
  return new Response(JSON.stringify({ id: "m" + n, type: "message", role: "assistant", model: "claude-haiku-5-5", ...r, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const store = await import(raiz + "lib/store.js");
const { atenderWhatsApp } = await import(raiz + "lib/conversacion.js");
const { mensajeParaDomiciliario } = await import(raiz + "lib/domiciliarios.js");
const { cobroEnEfectivo } = await import(raiz + "lib/tienda.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const COCA = "7702535024423", POKER = "7702004007360";
const ultimoResultado = () => JSON.parse(resultados.at(-1)?.content.replace(/^Error: /, '"') ?? "{}");
const pedidoDe = async (cl) => store.leerPedido((await store.leerCharla(cl)).pedidoId);

// 1) Contraentrega, alistando: se agrega al mismo pedido y se vuelve a preguntar con cuánto paga.
const CL = "573004440001";
guion.push(herramienta("guardar_pedido", { items: [{ sku: COCA, cantidad: 1 }], direccion: "Torre 3 apto 501", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 20000 }), texto("Confirmado."));
await atenderWhatsApp(CL, "efectivo con 20000");
let p = await pedidoDe(CL);
const totalAntes = p.total, domicilio = p.domicilioFijo;
ok("en WhatsApp el asistente tiene la herramienta agregar_al_pedido", herramientasVistas.at(-1).includes("agregar_al_pedido"));
guion.push(herramienta("agregar_al_pedido", { items: [{ sku: POKER, cantidad: 2 }] }), texto("Agregado. ¿Con cuánto pagás?"));
await atenderWhatsApp(CL, "agregame dos poker");
const p1 = await pedidoDe(CL);
ok("se agrega al mismo pedido, sin otro domicilio", p1.id === p.id && p1.status === "alistando" && p1.items.length === 2 && p1.domicilioFijo === domicilio && p1.total === totalAntes + 2 * p1.items[1].price);
ok("queda registrado lo agregado y se vuelve a preguntar con cuánto paga", p1.agregados?.length === 1 && p1.pagaConPorConfirmar === true && /cuánto paga/.test(ultimoResultado().siguiente));
guion.push(herramienta("agregar_al_pedido", { paga_con: 50000 }), texto("Listo, devuelta lista."));
await atenderWhatsApp(CL, "con 50 mil");
const p1b = await pedidoDe(CL);
ok("con la respuesta queda el nuevo billete y la devuelta", p1b.pagaCon === 50000 && !p1b.pagaConPorConfirmar && ultimoResultado().devuelta === 50000 - p1b.total);
ok("al domiciliario le llega el total nuevo a cobrar", mensajeParaDomiciliario({ ...p1b, codigo: "1234" }).includes("Cobrar $" + p1b.total.toLocaleString("es-CO")));

// 2) Transferencia ya confirmada (alistando): la diferencia, en efectivo al recibir.
const CL2 = "573004440002";
guion.push(herramienta("guardar_pedido", { items: [{ sku: COCA, cantidad: 1 }], direccion: "Torre 1 apto 101", metodo_pago: "Transferencia" }), herramienta("cerrar_pedido", {}), texto("Pasame el comprobante."));
await atenderWhatsApp(CL2, "transferencia");
p = await pedidoDe(CL2);
await store.guardarPedido({ ...p, status: "alistando" }); // la tienda confirmó el pago
guion.push(herramienta("agregar_al_pedido", { items: [{ sku: POKER, cantidad: 1 }] }), texto("¿Cómo pagás la diferencia?"));
await atenderWhatsApp(CL2, "agregame una poker");
let p2 = await pedidoDe(CL2);
ok("pagado por transferencia: queda una diferencia por definir", p2.diferencia?.valor === p2.items[1].price && p2.diferencia.estado === "por_definir" && p2.diferencia.pagado === p.total);
guion.push(herramienta("agregar_al_pedido", { pago_diferencia: "Efectivo" }), texto("¿Con cuánto pagás?"));
await atenderWhatsApp(CL2, "efectivo al recibir");
guion.push(herramienta("agregar_al_pedido", { paga_con: 10000 }), texto("Listo."));
await atenderWhatsApp(CL2, "con 10 mil");
p2 = await pedidoDe(CL2);
const cobro = cobroEnEfectivo(p2);
ok("la diferencia en efectivo: el domiciliario cobra solo lo agregado, con la devuelta", cobro.valor === p2.diferencia.valor && cobro.pagaCon === 10000 && cobro.diferencia && /Cobrar \$[\d.]+ en efectivo \(lo agregado\)/.test(mensajeParaDomiciliario({ ...p2, codigo: "1" })));

// 3) Transferencia ya pagada, la diferencia por transferencia: comprobante y la tienda la confirma.
const CL3 = "573004440003";
guion.push(herramienta("guardar_pedido", { items: [{ sku: COCA, cantidad: 1 }], direccion: "Torre 2 apto 202", metodo_pago: "Transferencia" }), herramienta("cerrar_pedido", {}), texto("Pasame el comprobante."));
await atenderWhatsApp(CL3, "transferencia");
p = await pedidoDe(CL3);
await store.guardarPedido({ ...p, status: "alistando" });
guion.push(herramienta("agregar_al_pedido", { items: [{ sku: POKER, cantidad: 1 }], pago_diferencia: "Transferencia" }), texto("Pasame el comprobante de la diferencia."));
await atenderWhatsApp(CL3, "agregame una poker, te transfiero");
let p3 = await pedidoDe(CL3);
ok("diferencia por transferencia: espera el comprobante", p3.diferencia?.estado === "esperando_comprobante" && p3.diferencia.pago === "Transferencia");
ok("el domiciliario ve que ese pago no está confirmado", /no está confirmado/.test(mensajeParaDomiciliario({ ...p3, codigo: "1" })));
guion.push(herramienta("registrar_comprobante", { es_comprobante: true, monto: p3.diferencia.valor }), texto("Recibido."));
await atenderWhatsApp(CL3, "", { mediaType: "image/jpeg", base64: "AAAA" });
p3 = await pedidoDe(CL3);
ok("el comprobante de la diferencia queda por confirmar en la tienda", p3.diferencia.estado === "por_confirmar" && p3.diferencia.monto === p3.diferencia.valor && p3.status === "alistando");

// 4) El domicilio ya salió: es un pedido nuevo.
const CL4 = "573004440004";
guion.push(herramienta("guardar_pedido", { items: [{ sku: COCA, cantidad: 1 }], direccion: "Torre 4 apto 404", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 20000 }), texto("Confirmado."));
await atenderWhatsApp(CL4, "efectivo con 20000");
p = await pedidoDe(CL4);
await store.guardarPedido({ ...p, status: "en_camino" });
guion.push(herramienta("agregar_al_pedido", { items: [{ sku: POKER, cantidad: 1 }] }), texto("Ese ya salió, armamos uno nuevo."));
await atenderWhatsApp(CL4, "agregame una poker");
const p4 = await store.leerPedido(p.id);
ok("si ya salió, no se toca ese pedido y se le explica que es uno nuevo", p4.items.length === 1 && ultimoResultado().pedido_nuevo === true);

// 5) Si el asistente intenta reemplazar el pedido cerrado con la lista completa, se le pide usar agregar_al_pedido.
const CL5 = "573004440005";
guion.push(herramienta("guardar_pedido", { items: [{ sku: COCA, cantidad: 1 }], direccion: "Torre 5 apto 505", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 20000 }), texto("Confirmado."));
await atenderWhatsApp(CL5, "efectivo con 20000");
p = await pedidoDe(CL5);
guion.push(herramienta("guardar_pedido", { items: [{ sku: COCA, cantidad: 1 }, { sku: POKER, cantidad: 1 }] }), texto("..."));
await atenderWhatsApp(CL5, "y una poker");
ok("guardar_pedido con todo lo anterior + lo nuevo no crea otro pedido: pide agregar_al_pedido", (await pedidoDe(CL5)).id === p.id && /agregar_al_pedido/.test(resultados.at(-1).content));
