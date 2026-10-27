// Recordatorio de pedido sin cerrar: a los 20 minutos, una sola vez, con botones; nunca si el cliente
// escribió después, si la tienda tomó el chat, fuera de horario o antes de tiempo. Sin servicios reales.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_|RECORDATORIOS_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
Object.assign(process.env, { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_APP_SECRET: "secreto", VERCEL: "1" });
const enviados = [];
globalThis.fetch = async (url, o = {}) => {
  if (String(url).endsWith("/111/messages")) { enviados.push(JSON.parse(o.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.r" + enviados.length }] }), { status: 200 }); }
  return new Response("{}", { status: 200 });
};
const store = await import(raiz + "lib/store.js");
const { enviarRecordatorios } = await import(raiz + "lib/recordatorios.js");
const webhook = (await import(raiz + "api/whatsapp.js")).default;
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);

// 10:00 a. m. de hoy en Cali: hay domicilios (hoy: el panel solo lista los pedidos de los últimos tres días).
const HOY = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const AHORA = Date.parse(`${HOY}T10:00:00-05:00`);
await store.guardarAjustes({ whatsappActivo: true });
const pedido = (id, cliente) => ({ id, no: 100 + enviados.length, canal: "WhatsApp", cliente, status: "armando", items: [{ sku: "x", name: "Limón (libra)", price: 4000, qty: 0.5 }], total: 0, hora: AHORA - 30 * 60000 });
const conversacion = (cliente, id, hace, ultimoRol = "assistant") => store.guardarCharla(cliente, { turnos: [{ role: "user", content: "½ libra de limón" }, { role: ultimoRol, content: "Anotado." }], pedidoId: id, ultimo: AHORA - hace });

await store.guardarPedido(pedido("pr1", "573001110001")); await conversacion("573001110001", "pr1", 25 * 60000);
await store.guardarPedido(pedido("pr2", "573001110002")); await conversacion("573001110002", "pr2", 10 * 60000);
await store.guardarPedido(pedido("pr3", "573001110003")); await conversacion("573001110003", "pr3", 25 * 60000, "user");
await store.guardarPedido(pedido("pr4", "573001110004")); await conversacion("573001110004", "pr4", 25 * 60000); await store.pausar("573001110004", 3600);

let r = await enviarRecordatorios(AHORA);
const msg = enviados[0];
ok("a los 25 minutos le llega el recordatorio con el resumen y dos botones", r.enviados === 1 && msg?.to === "573001110001" && /cerramos tu pedido/.test(msg.interactive?.body?.text) && msg.interactive?.action?.buttons?.length === 2);
ok("no a los 10 minutos, ni si el cliente escribió después, ni si la tienda tomó el chat", enviados.every((m) => m.to === "573001110001"));
r = await enviarRecordatorios(AHORA + 10 * 60000);
ok("una sola vez por pedido", enviados.filter((m) => m.to === "573001110001").length === 1);
ok("queda en la conversación para que el asistente sepa qué preguntó", /cerramos tu pedido/.test((await store.leerCharla("573001110001")).turnos.at(-1).content));

await store.guardarPedido(pedido("pr5", "573001110005")); await conversacion("573001110005", "pr5", 25 * 60000);
r = await enviarRecordatorios(Date.parse(`${HOY}T23:30:00-05:00`) );
ok("fuera del horario de domicilios no se le escribe", r.enviados === 0);

// El enlace para una tarea programada, con clave.
process.env.RECORDATORIOS_CLAVE = "clave-cron";
const llamar = (query) => new Promise((resolve) => webhook({ method: "GET", headers: {}, query }, { status(c) { this.c = c; return this; }, json(d) { resolve([this.c, d]); }, send(d) { resolve([this.c, d]); }, setHeader() {} }));
let [c] = await llamar({ accion: "recordatorios" });
ok("sin la clave: 403", c === 403);
[c] = await llamar({ accion: "recordatorios", clave: "clave-cron" });
ok("con la clave: responde", c === 200);

// De paso (sin servicios externos): como máximo una vez por minuto.
const { revisarRecordatoriosDePaso } = await import(raiz + "lib/recordatorios.js");
const { tocaRevisarRecordatorios } = store;
ok("de paso: la primera vez toca revisar y la siguiente, dentro del minuto, no", (await tocaRevisarRecordatorios()) === true && (await tocaRevisarRecordatorios()) === false);
await revisarRecordatoriosDePaso();
ok("y revisar de paso nunca hace fallar la consulta", true);

// Los minutos se ajustan en Ajustes: con 30, a los 25 minutos todavía no; con 0, nunca.
const { cargarNegocio } = await import(raiz + "lib/comun.js");
await store.guardarPedido(pedido("pr6", "573001110006")); await conversacion("573001110006", "pr6", 25 * 60000);
await store.guardarAjustes({ ...(await store.leerAjustes()), whatsappActivo: true, negocio: { recordarMinutos: 30 } }); await cargarNegocio(true);
const antes6 = enviados.length;
await enviarRecordatorios(AHORA);
ok("con 30 minutos en Ajustes: a los 25 todavía no", enviados.length === antes6);
await store.guardarAjustes({ ...(await store.leerAjustes()), negocio: { recordarMinutos: 0 } }); await cargarNegocio(true);
await conversacion("573001110006", "pr6", 60 * 60000);
await enviarRecordatorios(AHORA);
ok("con 0: apagado, no se le recuerda", enviados.length === antes6);
await store.guardarAjustes({ ...(await store.leerAjustes()), negocio: { recordarMinutos: 30 } }); await cargarNegocio(true);
await enviarRecordatorios(AHORA);
ok("con 30 y una hora sin escribir: sí", enviados.length === antes6 + 1);

// Si la tienda le escribió a mano después del asistente ("ya sale para allá"), no se le recuerda.
await store.guardarPedido(pedido("pr7", "573001110007")); await conversacion("573001110007", "pr7", 40 * 60000);
await store.registrarMensaje("573001110007", { id: "wamid.tienda7", dir: "out", de: "tienda", tipo: "text", texto: "Ya sale para allá", hora: AHORA - 35 * 60000 });
const antes7 = enviados.length;
await enviarRecordatorios(AHORA);
ok("la tienda ya le escribió a mano: no se le recuerda", !enviados.slice(antes7).some((m) => m.to === "573001110007"));
