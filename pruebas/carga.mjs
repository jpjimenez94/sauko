// Prueba de carga: 40 clientes a la vez por el webhook de Meta, con WhatsApp, Groq y la IA SIMULADOS.
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
// Cero llamadas reales: cualquier conexión que no esté simulada falla (no se gasta crédito de Claude).
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
const raiz = pathToFileURL(process.cwd() + "/").href;
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
Object.assign(process.env, { WHATSAPP_TOKEN: "simulado", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_APP_SECRET: "secreto", VERCEL: "1", ANTHROPIC_API_KEY: "simulado-sin-credito", GROQ_API_KEY: "simulado", SAUKO_MODEL: "claude-haiku-5-5" });

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => a + Math.random() * (b - a);
const enviados = [];
let llamadasIA = 0, salidasBloqueadas = 0, idSalida = 0;
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.endsWith("/111/messages")) {
    await espera(azar(40, 160)); // latencia de Meta
    const b = JSON.parse(o.body);
    enviados.push({ ...b, t: Date.now() });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.s" + ++idSalida }] }), { status: 200 });
  }
  if (u.startsWith("https://graph.facebook.com/v21.0/med")) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/x", mime_type: u.includes("medaud") ? "audio/ogg" : "image/jpeg" }), { status: 200 });
  if (u.startsWith("https://lookaside.fbsbx.com")) return new Response(Buffer.from("bytes-simulados"), { status: 200 });
  if (u.includes("api.groq.com")) { await espera(azar(300, 700)); return new Response(JSON.stringify({ text: "quiero una leche y un pan" }), { status: 200, headers: { "content-type": "application/json" } }); }
  if (u.includes("api.anthropic.com")) {
    llamadasIA++;
    await espera(azar(900, 2600)); // lo que tarda Haiku
    const cuerpo = String(o.body ?? "");
    const etiqueta = (cuerpo.match(/\[C\d+\]/g) || ["[C?]"]).at(-1);
    const conHerramienta = /leche/.test(cuerpo) && !/tool_result/.test(cuerpo);
    const r = conHerramienta
      ? { content: [{ type: "tool_use", id: "t" + llamadasIA, name: "buscar_productos", input: { consulta: "leche" } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: "Listo, veci " + etiqueta + " 🛒" }], stop_reason: "end_turn" };
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 }, ...r }), { status: 200, headers: { "content-type": "application/json" } });
  }
  salidasBloqueadas++;
  throw new Error("Conexión real bloqueada en la prueba: " + u);
};

const store = await import(raiz + "lib/store.js");
const webhook = (await import(raiz + "api/whatsapp.js")).default;
await store.guardarAjustes({ whatsappActivo: true });
const firmar = (x) => "sha256=" + createHmac("sha256", "secreto").update(x).digest("hex");
const avisar = (value) => new Promise((r) => { const crudo = JSON.stringify({ entry: [{ changes: [{ value }] }] }); webhook({ method: "POST", rawBody: crudo, headers: { "x-hub-signature-256": firmar(crudo) }, query: {}, body: {} }, { status(c) { this.c = c; return this; }, send() { r(this.c); }, json() { r(this.c); }, setHeader() {} }); });

const CLIENTES = 40;
const GUIONES = [
  ["hola", "necesito leche", "y un pan tajado", "Efectivo", "con un billete de 50"],
  ["buenas", "algo de tomar", "Gaseosa", "dos por favor", "a la torre 3 apto 502", "Transferencia"],
  ["hola veci", "{audio}", "eso", "Efectivo", "gracias"],
  ["hola", "{foto}", "¿tienen esto?", "listo, dos", "Transferencia", "{foto}"],
  ["buenas noches", "media libra de tomate", "y una cebolla", "para las 7 pm", "Efectivo", "con 20 mil", "gracias"],
];
let wamid = 0, entrantes = 0, duplicadosEnviados = 0;
const tiempos = [];
async function cliente(i) {
  const tel = "5730000" + String(1000 + i);
  const etiqueta = `[C${i}]`;
  const guion = GUIONES[i % GUIONES.length];
  await espera(azar(0, 3000)); // no llegan todos en el mismo milisegundo
  for (const paso of guion) {
    const id = "wamid.e" + ++wamid;
    const base = { from: tel, id, timestamp: String(Math.floor(Date.now() / 1000)) };
    const m = paso === "{audio}" ? { ...base, type: "audio", audio: { id: "medaud" + wamid, voice: true } }
      : paso === "{foto}" ? { ...base, type: "image", image: { id: "medimg" + wamid, caption: etiqueta } }
      : ["Efectivo", "Transferencia", "Gaseosa"].includes(paso) ? { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "op0", title: paso + " " + etiqueta } } }
      : { ...base, type: "text", text: { body: paso + " " + etiqueta } };
    const antes = enviados.filter((e) => e.to === tel).length;
    const t0 = Date.now();
    entrantes++;
    const aviso = avisar({ contacts: [{ wa_id: tel, profile: { name: "Cliente " + i } }], messages: [m] });
    // Meta a veces reintenta el mismo aviso: 1 de cada 8 llega dos veces
    if (Math.random() < 0.125) { duplicadosEnviados++; await espera(azar(50, 400)); avisar({ contacts: [{ wa_id: tel }], messages: [m] }); }
    await aviso;
    if (enviados.filter((e) => e.to === tel).length > antes) tiempos.push(Date.now() - t0);
    await espera(azar(300, 2500)); // lo que tarda la persona en escribir el siguiente
  }
}
// Un bot de otro negocio que contesta solo, metido en medio
async function botAjeno() {
  for (let k = 0; k < 8; k++) { await avisar({ contacts: [{ wa_id: "573009990000" }], messages: [{ from: "573009990000", id: "wamid.bot" + k, type: "text", text: { body: "Gracias por escribir a Ferretería El Tornillo, en este momento no podemos atenderte." } }] }); await espera(200); }
}

const inicio = Date.now();
await Promise.all([...Array.from({ length: CLIENTES }, (_, i) => cliente(i)), botAjeno()]);
const duracion = (Date.now() - inicio) / 1000;

// Resultados
const ordenados = [...tiempos].sort((a, b) => a - b);
const pct = (p) => (ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * p))] / 1000).toFixed(1) + " s";
const respuestas = enviados.filter((e) => e.to?.startsWith("5730000"));
const cruzados = respuestas.filter((e) => { const txt = e.text?.body ?? e.interactive?.body?.text ?? ""; const et = txt.match(/\[C(\d+)\]/); return et && "5730000" + String(1000 + Number(et[1])) !== e.to; });
const porCliente = {};
for (const e of respuestas) porCliente[e.to] = (porCliente[e.to] || 0) + 1;
const sinRespuesta = Array.from({ length: CLIENTES }, (_, i) => "5730000" + String(1000 + i)).filter((t) => !porCliente[t]);
const bit = await store.leerBitacora();
const cortesFalsos = bit.filter((b) => /parece otro bot/.test(JSON.stringify(b)) && /5730000/.test(JSON.stringify(b)));
const alBot = enviados.filter((e) => e.to === "573009990000").length;
const errores = bit.filter((b) => /error al atender|envío falló/.test(JSON.stringify(b)));
const chats = await store.listarConversaciones(200);
console.log(`
PRUEBA DE CARGA (todo simulado, 0 créditos de Claude)
- Clientes simultáneos: ${CLIENTES} + 1 bot ajeno · duración ${duracion.toFixed(0)} s
- Mensajes de clientes: ${entrantes} (+${duplicadosEnviados} reintentos duplicados de Meta)
- Respuestas enviadas a clientes: ${respuestas.length} · clientes sin ninguna respuesta: ${sinRespuesta.length}
- Tiempo de respuesta: mediana ${pct(0.5)} · 95% en menos de ${pct(0.95)} · peor ${(ordenados.at(-1) / 1000).toFixed(1)} s
- Respuestas cruzadas (a otro cliente): ${cruzados.length}
- Reintentos de Meta respondidos dos veces: ${Math.max(0, respuestas.length - entrantes)} (debe ser 0)
- Clientes normales cortados por el freno anti-bot: ${cortesFalsos.length}
- Mensajes al bot ajeno: ${alBot} (2 normales + 1 aviso y silencio = 3)
- Errores al atender o envíos fallidos: ${errores.length}
- Chats en Conversaciones: ${chats.length} · llamadas a la IA simulada: ${llamadasIA} · conexiones reales intentadas: ${salidasBloqueadas}
`);
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
ok("todos los clientes recibieron respuesta", sinRespuesta.length === 0);
ok("cada mensaje recibió exactamente una respuesta", respuestas.length === entrantes);
ok("ninguna respuesta le llegó a otro cliente", cruzados.length === 0);
ok("el freno anti-bots no cortó a clientes normales", cortesFalsos.length === 0);
ok("el bot ajeno recibió 2 respuestas, el aviso y silencio", alBot === 3);
ok("sin errores al atender ni envíos fallidos", errores.length === 0);
ok("ninguna conexión real (0 créditos)", salidasBloqueadas === 0);
