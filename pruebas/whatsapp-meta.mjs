// Camino de Meta directo (Cloud API), con WhatsApp, Groq y el modelo simulados.
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
const raiz = pathToFileURL(process.cwd() + "/").href;
delete process.env.YCLOUD_API_KEY; delete process.env.YCLOUD_FROM;
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DATABASE_URL", "POSTGRES_URL"]) delete process.env[k];
Object.assign(process.env, { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_APP_SECRET: "secreto", WHATSAPP_VERIFY_TOKEN: "verif", VERCEL: "1", ANTHROPIC_API_KEY: "prueba", GROQ_API_KEY: "prueba", SAUKO_MODEL: "claude-haiku-5-5" });

const enviados = [], urlsMeta = [];
let respuestasIA = [];
const textoIA = (t) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.startsWith("https://graph.facebook.com")) {
    urlsMeta.push(u + " auth=" + (o.headers?.Authorization ? "sí" : "no"));
    if (u.endsWith("/111/messages")) { const b = JSON.parse(o.body); enviados.push(b); return new Response('{"messages":[{"id":"x"}]}', { status: 200 }); }
    if (u.includes("/media-foto")) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/foto", mime_type: "image/jpeg" }), { status: 200 });
    if (u.includes("/media-audio")) return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/audio", mime_type: "audio/ogg; codecs=opus" }), { status: 200 });
  }
  if (u.startsWith("https://lookaside.fbsbx.com")) return new Response(Buffer.from("bytes"), { status: 200 });
  if (u.includes("groq.com")) return new Response(JSON.stringify({ text: "quiero una coca cola" }), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("anthropic.com")) {
    const r = respuestasIA.shift() ?? textoIA("Listo, veci.");
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 }, ...r }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200 });
};

const store = await import(raiz + "lib/store.js");
const webhook = (await import(raiz + "api/whatsapp.js")).default;
const ok = (n, c) => console.log((c ? "OK    " : "FALLA ") + n);
const llamar = (req) => new Promise((resolve) => webhook(req, { status(c) { this.c = c; return this; }, send(d) { resolve([this.c, d]); } }));
const firmar = (cuerpo) => "sha256=" + createHmac("sha256", "secreto").update(cuerpo).digest("hex");
let n = 0;
const CLIENTE = "573009998877";
const aviso = (mensaje, firma = true) => { const crudo = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid." + ++n, from: CLIENTE, ...mensaje }] } }] }] }); return llamar({ method: "POST", rawBody: crudo, headers: firma ? { "x-hub-signature-256": firmar(crudo) } : {} }); };
const ultimo = () => enviados.at(-1);
const textoDe = (b) => b?.text?.body ?? b?.interactive?.body?.text ?? "";

await store.guardarAjustes({ whatsappActivo: true });

// 1. Verificación del webhook
let [c, d] = await llamar({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "verif", "hub.challenge": "123" } });
ok("verificación del webhook con el token correcto", c === 200 && d === "123");
[c] = await llamar({ method: "GET", query: { "hub.mode": "subscribe", "hub.verify_token": "otro", "hub.challenge": "123" } });
ok("token equivocado: 403", c === 403);

// 2. Firma
[c] = await aviso({ type: "text", text: { body: "hola" } }, false);
ok("aviso sin firma: 401 y no responde", c === 401 && enviados.length === 0);

// 3. Texto con firma: primera respuesta con el aviso de datos al final, sin enlaces
[c] = await aviso({ type: "text", text: { body: "hola" } });
const primera = ultimo();
ok("texto firmado: responde por Meta con messaging_product", c === 200 && primera?.messaging_product === "whatsapp" && primera.to === CLIENTE);
ok("primera respuesta lleva el aviso de datos al final y sin enlaces", /Tus datos .* solo los usamos/.test(textoDe(primera)) && !/https?:\/\//.test(textoDe(primera)) && !/SI PROMOS/.test(textoDe(primera)) && enviados.length === 1);
await aviso({ type: "text", text: { body: "gracias" } });
ok("segunda respuesta ya no lleva el aviso", !/Tus datos/.test(textoDe(ultimo())));

// 4. El asistente ofrece botones
respuestasIA = [
  { content: [{ type: "tool_use", id: "t1", name: "ofrecer_botones", input: { opciones: [{ titulo: "Transferencia" }, { titulo: "Efectivo" }] } }], stop_reason: "tool_use" },
  textoIA("¿Cómo vas a pagar, veci?"),
];
await aviso({ type: "text", text: { body: "ya, eso es todo" } });
const b = ultimo();
ok("botones salen como interactive de Meta", b?.type === "interactive" && b.interactive.type === "button" && b.interactive.action.buttons.map((x) => x.reply.title).join("|") === "Transferencia|Efectivo");

// 5. El cliente toca un botón
const antesIA = respuestasIA.length;
await aviso({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "op1", title: "Efectivo" } } });
ok("toque de botón: se atiende como texto y se responde", textoDe(ultimo()).length > 0);

// 6. Foto
await aviso({ type: "image", image: { id: "media-foto", caption: "este" } });
ok("foto: la baja de Meta con el token (ficha y archivo) y responde", urlsMeta.some((x) => x.includes("/media-foto auth=sí")) && textoDe(ultimo()).length > 0);

// 7. Nota de voz
const antesAudio = enviados.length;
await aviso({ type: "audio", audio: { id: "media-audio", voice: true } });
ok("nota de voz: la baja de Meta, la transcribe y responde", urlsMeta.some((x) => x.includes("/media-audio auth=sí")) && enviados.length === antesAudio + 1);

// 8. Mensaje repetido por Meta (mismo wamid)
const antesRep = enviados.length;
const crudo = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid." + n, from: CLIENTE, type: "text", text: { body: "hola" } }] } }] }] });
await llamar({ method: "POST", rawBody: crudo, headers: { "x-hub-signature-256": firmar(crudo) } });
ok("aviso repetido de Meta: no responde dos veces", enviados.length === antesRep);

// 9. Avisos de estado (statuses) sin mensajes: no responde
const antesEst = enviados.length;
const est = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "read" }] } }] }] });
[c] = await llamar({ method: "POST", rawBody: est, headers: { "x-hub-signature-256": firmar(est) } });
ok("aviso de leído: 200 y no responde", c === 200 && enviados.length === antesEst);

// 10. Cliente con pedido largo: 15 mensajes más, incluidos "Sí" repetidos de botones, todos se responden
const antesLargo = enviados.length;
const pedidoLargo = ["agregame un arroz", "Sí", "y un aceite", "Sí", "también huevos", "Sí", "una leche", "pan tajado", "Sí", "queso", "jamón", "gaseosa 1.5", "Sí", "eso es todo", "Efectivo"];
for (const t of pedidoLargo) await aviso({ type: "text", text: { body: t } });
ok("pedido largo con 15 mensajes seguidos: se responden todos", enviados.length === antesLargo + pedidoLargo.length);

// 10b. Usuario con nombre de usuario: sin "from", llega su BSUID; se le responde con "recipient"
const BSUID = "CO.13491208655302741918";
const crudoU = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ user_id: BSUID, profile: { name: "Juan", username: "jpjimenez94" } }], messages: [{ id: "wamid.usr1", from_user_id: BSUID, type: "text", text: { body: "hola" } }] } }] }] });
await llamar({ method: "POST", rawBody: crudoU, headers: { "x-hub-signature-256": firmar(crudoU) } });
const aUsr = enviados.filter((e) => e.recipient === BSUID);
ok("usuario con @: se atiende y se le responde por recipient (no por to)", aUsr.length === 1 && !aUsr[0].to);
const crudoU2 = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ user_id: BSUID }], messages: [{ id: "wamid.usr2", user_id: BSUID, type: "text", text: { body: "otra" } }] } }] }] });
await llamar({ method: "POST", rawBody: crudoU2, headers: { "x-hub-signature-256": firmar(crudoU2) } });
ok("también si el campo se llama user_id", enviados.filter((e) => e.recipient === BSUID).length === 2);

// 11. Otro bot: el mismo mensaje automático largo 3 veces
const BOT = "573001112222";
const deBot = (id) => { const crudo = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.bot" + id, from: BOT, type: "text", text: { body: "Gracias por comunicarte con Ferretería X. En este momento no estamos disponibles." } }] } }] }] }); return llamar({ method: "POST", rawBody: crudo, headers: { "x-hub-signature-256": firmar(crudo) } }); };
for (let i = 0; i < 6; i++) await deBot(i);
const aBot = enviados.filter((e) => e.to === BOT);
ok("otro bot: 2 respuestas normales, un aviso y luego silencio (salieron " + aBot.length + ")", aBot.length === 3 && /te atiende alguien de la tienda/.test(textoDe(aBot.at(-1))) && (await store.enPausa(BOT)));
