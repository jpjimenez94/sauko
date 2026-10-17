// Con Meta configurado y sin YCLOUD_FROM, un aviso de YCloud (número de la tienda) no se responde.
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DATABASE_URL", "POSTGRES_URL", "YCLOUD_FROM", "YCLOUD_WEBHOOK_SECRET", "VERCEL"]) delete process.env[k];
Object.assign(process.env, { YCLOUD_API_KEY: "clave", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111", ANTHROPIC_API_KEY: "prueba" });
const salidas = [];
globalThis.fetch = async (url) => { salidas.push(String(url)); return new Response(JSON.stringify({ content: [{ type: "text", text: "Hola veci" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); };
const store = await import(raiz + "lib/store.js");
await store.guardarAjustes({ whatsappActivo: true });
const ycloud = (await import(raiz + "api/ycloud.js")).default;
const crudo = JSON.stringify({ type: "whatsapp.inbound_message.received", whatsappInboundMessage: { wamid: "w1", from: "573001112233", type: "text", text: { body: "hola" } } });
const [c] = await new Promise((r) => ycloud({ method: "POST", rawBody: crudo, headers: {} }, { status(x) { this.c = x; return this; }, send(d) { r([this.c, d]); } }));
const bit = (await store.leerBitacora()).map((b) => b.evento ?? b.que ?? JSON.stringify(b)).join(" | ");
console.log((c === 200 && salidas.length === 0 ? "OK    " : "FALLA ") + "aviso de YCloud sin YCLOUD_FROM: 200, nada enviado, nada a la IA (salidas: " + salidas.length + ")");
console.log((/YCloud ignorado/.test(bit) ? "OK    " : "FALLA ") + "queda anotado en el diagnóstico");
