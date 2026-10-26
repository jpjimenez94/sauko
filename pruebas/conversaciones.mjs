// Conversaciones del panel: se guarda lo que entra y sale, estados, extras, y las acciones del operario.
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
const raiz = pathToFileURL(process.cwd() + "/").href;
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DATABASE_URL", "POSTGRES_URL", "YCLOUD_API_KEY", "YCLOUD_FROM"]) delete process.env[k];
Object.assign(process.env, { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_APP_SECRET: "secreto", VERCEL: "1", ANTHROPIC_API_KEY: "prueba", SAUKO_MODEL: "claude-haiku-5-5", GROQ_API_KEY: "g" });
const enviados = [], subidas = [];
let n = 0;
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.endsWith("/111/messages")) { const b = JSON.parse(o.body); enviados.push(b); return new Response(JSON.stringify({ messages: [{ id: "wamid.out" + ++n }] }), { status: 200 }); }
  if (u.endsWith("/111/media")) { subidas.push(o.body); return new Response('{"id":"99887766"}', { status: 200 }); }
  if (u.includes("/55443322")) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/a", mime_type: "audio/ogg; codecs=opus" }), { status: 200 });
  if (u.startsWith("https://lookaside")) return new Response(Buffer.from("OGGDATA"), { status: 200 });
  if (u.includes("groq.com")) return new Response(JSON.stringify({ text: "una coca cola por favor" }), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("anthropic.com")) return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Listo, veci." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("{}", { status: 200 });
};
const store = await import(raiz + "lib/store.js");
const webhook = (await import(raiz + "api/whatsapp.js")).default;
const usuarios = await import(raiz + "lib/usuarios.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const llamar = (req) => new Promise((r) => webhook({ headers: {}, query: {}, ...req }, { status(c) { this.c = c; return this; }, send(d) { r([this.c, d]); }, json(d) { r([this.c, d]); }, setHeader(k, v) { this.h = { ...(this.h || {}), [k]: v }; } }));
const firmar = (x) => "sha256=" + createHmac("sha256", "secreto").update(x).digest("hex");
const aviso = (value) => { const crudo = JSON.stringify({ entry: [{ changes: [{ value }] }] }); return llamar({ method: "POST", rawBody: crudo, headers: { "x-hub-signature-256": firmar(crudo) } }); };
const CL = "573009998877";
await store.guardarAjustes({ whatsappActivo: true });

// Sesión de un operario
const { usuario } = await usuarios.crear({ usuario: "oper", nombre: "Luisa", rol: "operativo", clave: "clave-de-prueba-1" });
let cookie = "";
await usuarios.abrirSesion({ setHeader: (k, v) => { cookie = String(v).split(";")[0]; } }, (await store.leerUsuarios())[usuario.usuario]);
const panel = (method, accion, extra = {}) => llamar({ method, query: { accion, ...(extra.query || {}) }, headers: { cookie }, body: extra.body || {} });

// 1. Mensaje de texto del cliente + respuesta del asistente
await aviso({ contacts: [{ wa_id: CL, profile: { name: "Ana Pérez" } }], messages: [{ id: "wamid.in1", from: CL, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hola, tienen leche?" } }] });
let [c, d] = await panel("GET", "chats");
ok("lista de chats: aparece Ana con 1 no leído y la vista previa de la respuesta", c === 200 && d.chats[0]?.nombre === "Ana Pérez" && d.chats[0].noLeidos === 1 && d.chats[0].ultimoDir === "out");
[c, d] = await panel("GET", "chat", { query: { c: CL } });
ok("chat: mensaje del cliente y respuesta del asistente (con aviso de datos)", d.mensajes.length === 2 && d.mensajes[0].dir === "in" && d.mensajes[1].de === "asistente" && d.mensajes[1].estado === "sent");

// 2. Reintento de Meta: no duplica
await aviso({ contacts: [{ wa_id: CL, profile: { name: "Ana Pérez" } }], messages: [{ id: "wamid.in1", from: CL, type: "text", text: { body: "hola, tienen leche?" } }] });
[, d] = await panel("GET", "chat", { query: { c: CL } });
ok("reintento del mismo aviso: no se duplica", d.mensajes.filter((m) => m.id === "wamid.in1").length === 1);

// 3. Estados: entregado y leído (no retrocede)
const idSalida = d.mensajes[1].id;
await aviso({ statuses: [{ id: idSalida, status: "read", recipient_id: CL }] });
await aviso({ statuses: [{ id: idSalida, status: "delivered", recipient_id: CL }] });
[, d] = await panel("GET", "chat", { query: { c: CL } });
ok("estado leído no vuelve a entregado", d.mensajes.find((m) => m.id === idSalida).estado === "read");

// 4. Nota de voz con transcripción, y reacción del cliente
await aviso({ contacts: [{ wa_id: CL }], messages: [{ id: "wamid.in2", from: CL, type: "audio", audio: { id: "55443322", mime_type: "audio/ogg; codecs=opus", voice: true } }] });
await aviso({ contacts: [{ wa_id: CL }], messages: [{ id: "wamid.in3", from: CL, type: "reaction", reaction: { message_id: idSalida, emoji: "👍" } }] });
[, d] = await panel("GET", "chat", { query: { c: CL } });
const voz = d.mensajes.find((m) => m.id === "wamid.in2");
ok("nota de voz guardada con su archivo y transcripción", voz?.medio?.id === "55443322" && voz.medio.voz && voz.transcripcion === "una coca cola por favor");
ok("reacción del cliente: queda en el mensaje, no como mensaje nuevo", d.mensajes.find((m) => m.id === idSalida).reaccionCliente === "👍" && !d.mensajes.some((m) => m.id === "wamid.in3"));

// 5. El panel baja el audio por el proxy
const [cm, bytes] = await panel("GET", "medio", { query: { id: "55443322" } });
ok("proxy de archivo: devuelve los bytes", cm === 200 && Buffer.from(bytes).toString() === "OGGDATA");
const [cmal] = await panel("GET", "medio", { query: { id: "../x" } });
ok("proxy rechaza ids raros", cmal === 400);

// 6. El operario responde, reacciona y manda foto
const antes = enviados.length;
[c, d] = await panel("POST", "enviar", { body: { c: CL, texto: "Sí, veci, tenemos Alquería y Colanta", contexto: "wamid.in1" } });
ok("operario envía: sale con context y queda como 'tienda' con su nombre", c === 200 && enviados[antes]?.context?.message_id === "wamid.in1" && enviados[antes].text.body.startsWith("Sí, veci"));
ok("al responder a mano, el asistente queda en pausa en ese chat", await store.enPausa(CL));
[, d] = await panel("GET", "chat", { query: { c: CL } });
const mio = d.mensajes.at(-1);
ok("mensaje de la tienda en el chat con autor y cita", mio.de === "tienda" && mio.por === "Luisa" && mio.contexto === "wamid.in1");
[c] = await panel("POST", "reaccion", { body: { c: CL, id: "wamid.in1", emoji: "❤️" } });
ok("reacción de la tienda enviada y anotada", c === 200 && enviados.at(-1).type === "reaction");
[c] = await panel("POST", "imagen", { body: { c: CL, tipo: "image/jpeg", base64: Buffer.from("JPEGDATA").toString("base64"), pie: "Así es la leche" } });
ok("foto del operario: se sube a Meta y se envía por id", c === 200 && subidas.length === 1 && enviados.at(-1).image?.id === "99887766");

// 7. Leer: no leídos a cero y ✓✓ azules al cliente
[c] = await panel("POST", "leer", { body: { c: CL } });
[, d] = await panel("GET", "chats");
ok("leer: no leídos en cero y se manda el visto a WhatsApp", d.chats[0].noLeidos === 0 && enviados.some((e) => e.status === "read" && e.message_id === "wamid.in2"));

// 8. Devolver al asistente y tomar
await panel("POST", "soltar", { body: { c: CL } });
ok("devolver: el asistente vuelve a atender", !(await store.enPausa(CL)));
await panel("POST", "tomar", { body: { c: CL, horas: 1 } });
ok("tomar: el asistente se calla 1 h", (await store.pausaRestante(CL)) > 3500);

// 9. Fuera de la ventana de 24 h no deja escribir
const VIEJO = "573005554433";
await store.registrarMensaje(VIEJO, { id: "wamid.viejo", dir: "in", de: "cliente", tipo: "text", texto: "hola", hora: Date.now() - 25 * 3600 * 1000, linea: "111" });
[c, d] = await panel("POST", "enviar", { body: { c: VIEJO, texto: "hola" } });
ok("fuera de 24 h: no deja escribir y explica por qué", c === 409 && /24 horas/.test(d.error));

// 10. Sin sesión no hay nada
const [c401] = await llamar({ method: "GET", query: { accion: "chats" }, headers: {} });
ok("sin sesión: 401", c401 === 401);

// 11. Devolver al asistente con un mensaje del cliente sin responder: el asistente lo responde ya
let pedidosIA = [];
const fetchAntes = globalThis.fetch;
globalThis.fetch = async (url, o = {}) => { if (String(url).includes("anthropic.com")) pedidosIA.push(String(o.body ?? "")); return fetchAntes(url, o); };
await store.guardarAjustes({ ...(await store.leerAjustes()), whatsappActivo: true });
await panel("POST", "tomar", { body: { c: CL, horas: 1 } });
await aviso({ contacts: [{ wa_id: CL }], messages: [{ id: "wamid.pend1", from: CL, type: "text", text: { body: "¿y tienen pan integral?" } }] });
ok("mientras atiende la tienda, el asistente no contesta", !pedidosIA.length);
const antesSoltar = enviados.length;
[c, d] = await panel("POST", "soltar", { body: { c: CL } });
ok("al devolver: el asistente responde lo pendiente", c === 200 && d.retomo && enviados.length === antesSoltar + 1 && enviados.at(-1).to === CL);
ok("y sabe lo que se habló mientras tanto", pedidosIA.some((b) => b.includes("La tienda atendió este chat") && b.includes("pan integral")));
[c, d] = await panel("POST", "soltar", { body: { c: CL } });
ok("si ya no hay nada pendiente, devolver no manda nada", !d.retomo && enviados.length === antesSoltar + 1);

// 12. Cambio de número del asistente: un chat de la línea anterior no se contesta desde la actual
const OTRA_LINEA = "573001112233";
await store.registrarMensaje(OTRA_LINEA, { id: "wamid.lineavieja", dir: "in", de: "cliente", tipo: "text", texto: "hola (al 313)", hora: Date.now() - 60000, nombre: "Cliente viejo" });
[, d] = await panel("GET", "chats");
const fichaVieja = d.chats.find((f) => f.id === OTRA_LINEA);
ok("la lista dice cuál es la línea actual y el chat viejo no es de ella", d.linea === "111" && fichaVieja && fichaVieja.linea === "");
const antesViejo = enviados.length;
[c, d] = await panel("POST", "enviar", { body: { c: OTRA_LINEA, texto: "hola veci" } });
ok("responder a mano un chat de la línea anterior: 409 y no sale nada", c === 409 && /línea anterior/.test(d.error) && enviados.length === antesViejo);
await aviso({ metadata: { phone_number_id: "111", display_phone_number: "573017160877" }, contacts: [{ wa_id: OTRA_LINEA }], messages: [{ id: "wamid.nuevo", from: OTRA_LINEA, type: "text", text: { body: "hola (al 301)" } }] });
[, d] = await panel("GET", "chat", { query: { c: OTRA_LINEA } });
ok("cuando escribe a la línea nueva, el mensaje guarda la línea y el número", d.ficha.linea === "111" && d.mensajes.find((m) => m.id === "wamid.nuevo")?.numero === "573017160877");
await panel("POST", "tomar", { body: { c: OTRA_LINEA, horas: 1 } });
[c] = await panel("POST", "enviar", { body: { c: OTRA_LINEA, texto: "hola veci, ¿qué necesitas?" } });
ok("y ya se le puede contestar a mano", c === 200);

// 9. Falla de WhatsApp (sin método de pago): lo que no le llegó al cliente se le responde de nuevo desde el panel.
const SIN = "573004445566";
await aviso({ contacts: [{ wa_id: SIN, profile: { name: "Pedro Sin Respuesta" } }], messages: [{ id: "wamid.sin1", from: SIN, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "una pony personal" } }] });
[, d] = await panel("GET", "chat", { query: { c: SIN } });
const idFallido = d.mensajes.find((m) => m.dir === "out").id;
await aviso({ statuses: [{ id: idFallido, recipient_id: SIN, status: "failed", errors: [{ code: 131042, title: "Business eligibility payment issue" }] }] });
[, d] = await panel("GET", "sin-entregar");
ok("sin entregar: aparece el cliente al que no le llegó la respuesta", d.pendientes.some((p) => p.id === SIN && p.nombre === "Pedro Sin Respuesta" && p.mensajes === 1));
const antesReintento = enviados.length;
[c] = await panel("POST", "reintentar", { body: { c: SIN } });
const nuevo = enviados.slice(antesReintento).find((b) => b.to === SIN);
ok("responder de nuevo: el asistente le vuelve a escribir", c === 200 && Boolean(nuevo));
[, d] = await panel("GET", "sin-entregar");
ok("y ya no sale como pendiente", !d.pendientes.some((p) => p.id === SIN));
[c] = await panel("POST", "reintentar", { body: { c: SIN } });
ok("un segundo toque no le manda otra respuesta", c === 409);
// Si la tienda le escribió a mano y le llegó, tampoco sale.
const MANO = "573004447788";
await aviso({ contacts: [{ wa_id: MANO, profile: { name: "Lucía" } }], messages: [{ id: "wamid.mano1", from: MANO, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hola" } }] });
[, d] = await panel("GET", "chat", { query: { c: MANO } });
await aviso({ statuses: [{ id: d.mensajes.find((m) => m.dir === "out").id, recipient_id: MANO, status: "failed", errors: [{ code: 131042, title: "Business eligibility payment issue" }] }] });
await panel("POST", "enviar", { body: { c: MANO, texto: "Veci, disculpá la demora" } });
[, d] = await panel("GET", "chat", { query: { c: MANO } });
await aviso({ statuses: [{ id: d.mensajes.at(-1).id, recipient_id: MANO, status: "delivered" }] });
[, d] = await panel("GET", "sin-entregar");
ok("si la tienda ya le escribió y le llegó, no sale como pendiente", !d.pendientes.some((p) => p.id === MANO));
