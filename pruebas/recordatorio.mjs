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

// 10:00 a. m. en Cali: hay domicilios.
const AHORA = Date.parse("2026-10-23T10:00:00-05:00");
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
r = await enviarRecordatorios(Date.parse("2026-10-23T23:30:00-05:00") );
ok("fuera del horario de domicilios no se le escribe", r.enviados === 0);

// El enlace que llama cron-job.org, con clave.
process.env.RECORDATORIOS_CLAVE = "clave-cron";
const llamar = (query) => new Promise((resolve) => webhook({ method: "GET", headers: {}, query }, { status(c) { this.c = c; return this; }, json(d) { resolve([this.c, d]); }, send(d) { resolve([this.c, d]); }, setHeader() {} }));
let [c] = await llamar({ accion: "recordatorios" });
ok("sin la clave: 403", c === 403);
[c] = await llamar({ accion: "recordatorios", clave: "clave-cron" });
ok("con la clave: responde", c === 200);
