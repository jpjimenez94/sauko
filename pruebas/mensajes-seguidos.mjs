// Dos mensajes seguidos del cliente (un texto y un botón en el mismo segundo) reciben UNA sola respuesta,
// que los tiene en cuenta a los dos; y nunca corren dos respuestas a la vez en el mismo chat.
// Con el modelo simulado: no gasta IA real.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
Object.assign(process.env, { ANTHROPIC_API_KEY: "prueba", SAUKO_MODEL: "claude-haiku-5-5", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111", SAUKO_JUNTAR_MS: "250" });
const alModelo = [], aWhatsApp = [];
globalThis.fetch = async (url, o = {}) => {
  if (String(url).includes("anthropic.com")) {
    const pedido = JSON.parse(o.body);
    alModelo.push(pedido.messages.at(-1));
    await new Promise((r) => setTimeout(r, 400)); // el modelo se demora: así se ve si dos respuestas se cruzan
    return new Response(JSON.stringify({ id: "m" + alModelo.length, type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Listo, veci." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (String(url).endsWith("/111/messages")) { aWhatsApp.push(JSON.parse(o.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.r" + aWhatsApp.length }] }), { status: 200 }); }
  return new Response("{}", { status: 200 });
};
const store = await import(raiz + "lib/store.js");
const { atenderEntrante } = await import(raiz + "lib/entrada.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
await store.guardarAjustes({ whatsappActivo: true });
const CL = "573004440001";
const texto = (m) => JSON.stringify(m?.content ?? "");

await Promise.all([
  atenderEntrante({ id: "wamid.a1", telefono: CL, tipo: "text", texto: "Número para transferir por llave" }),
  new Promise((r) => setTimeout(r, 60)).then(() => atenderEntrante({ id: "wamid.a2", telefono: CL, tipo: "text", texto: "Transferencia" })),
]);
ok("dos mensajes en el mismo segundo: el asistente responde una sola vez", alModelo.length === 1 && aWhatsApp.length === 1);
ok("y esa respuesta tiene en cuenta los dos mensajes", /transferir por llave/.test(texto(alModelo[0])) && /Transferencia/.test(texto(alModelo[0])));

// Un mensaje que llega mientras el asistente todavía responde el anterior espera su turno (no se cruzan).
alModelo.length = 0; aWhatsApp.length = 0;
let cruzados = false, corriendo = 0;
const original = globalThis.fetch;
globalThis.fetch = async (url, o) => {
  if (!String(url).includes("anthropic.com")) return original(url, o);
  if (++corriendo > 1) cruzados = true;
  try { return await original(url, o); } finally { corriendo--; }
};
await Promise.all([
  atenderEntrante({ id: "wamid.b1", telefono: CL, tipo: "text", texto: "Una Coca-Cola" }),
  new Promise((r) => setTimeout(r, 450)).then(() => atenderEntrante({ id: "wamid.b2", telefono: CL, tipo: "text", texto: "Y un pan" })),
]);
ok("el segundo espera a que termine el primero: dos respuestas, en orden y sin cruzarse", !cruzados && alModelo.length === 2 && aWhatsApp.length === 2 && /Coca/.test(texto(alModelo[0])) && /pan/.test(texto(alModelo[1])));

// Otro chat no espera a este.
ok("el turno se suelta al terminar", (await store.turnoDelChat(CL, { id: "x" }).then(async (t) => { await t.soltar(); return true; })));
