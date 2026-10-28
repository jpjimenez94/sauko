// Fruver pedido por unidades ("3 tomates"): queda por pesar, la tienda lo pesa desde el chat del panel, queda en
// el pedido con su valor y el asistente se lo cuenta al cliente. Sin servicios reales.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
Object.assign(process.env, { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_APP_SECRET: "secreto", VERCEL: "1", ANTHROPIC_API_KEY: "prueba", SAUKO_MODEL: "claude-haiku-5-5" });
const guion = [], alModelo = [], enviados = [];
let n = 0;
const herramienta = (name, input) => ({ content: [{ type: "tool_use", id: "t" + ++n, name, input }], stop_reason: "tool_use" });
const texto = (t) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const resultados = [];
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.endsWith("/111/messages")) { enviados.push(JSON.parse(o.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.out" + enviados.length }] }), { status: 200 }); }
  if (u.includes("anthropic.com")) {
    const pedido = JSON.parse(o.body);
    alModelo.push(pedido.messages.at(-1));
    const ultimo = pedido.messages.at(-1);
    if (Array.isArray(ultimo.content)) for (const b of ultimo.content) if (b.type === "tool_result") resultados.push(String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
    const r = guion.shift() ?? texto("Listo, veci.");
    return new Response(JSON.stringify({ id: "m" + n, type: "message", role: "assistant", model: "claude-haiku-5-5", ...r, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200 });
};
const store = await import(raiz + "lib/store.js");
const { CATALOGO } = await import(raiz + "lib/comun.js");
const { atenderEntrante } = await import(raiz + "lib/entrada.js");
const webhook = (await import(raiz + "api/whatsapp.js")).default;
const usuarios = await import(raiz + "lib/usuarios.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const llamar = (req) => new Promise((r) => webhook({ headers: {}, query: {}, ...req }, { status(c) { this.c = c; return this; }, send(d) { r([this.c, d]); }, json(d) { r([this.c, d]); }, setHeader() {} }));
await store.guardarAjustes({ whatsappActivo: true });
const { usuario } = await usuarios.crear({ usuario: "pesa", nombre: "Luisa", rol: "operativo", clave: "clave-de-prueba-1" });
let cookie = "";
await usuarios.abrirSesion({ setHeader: (k, v) => { cookie = String(v).split(";")[0]; } }, (await store.leerUsuarios())[usuario.usuario]);
const panel = (method, accion, extra = {}) => llamar({ method, query: { accion, ...(extra.query || {}) }, headers: { cookie }, body: extra.body || {} });

const TOMATE = [...CATALOGO].find(([, p]) => p.porLibra && /tomate/i.test(p.nombre))?.[0] ?? [...CATALOGO].find(([, p]) => p.porLibra)[0];
const PRECIO = CATALOGO.get(TOMATE).precio;
const COCA = "7702535024423";
const CL = "573006661234";
// El cliente escribe (para que el chat exista y la ventana de 24 h esté abierta).
await store.registrarMensaje(CL, { id: "wamid.c1", dir: "in", de: "cliente", tipo: "text", texto: "3 tomates y una coca 1.5", hora: Date.now(), linea: "111" });

guion.push(herramienta("guardar_pedido", { items: [{ sku: TOMATE, unidades: 3 }, { sku: COCA, cantidad: 1 }] }), texto("Veci, los tomates te los pesan en la tienda y ya te digo cuánto valen."));
await atenderEntrante({ id: "wamid.c1", telefono: CL, tipo: "text", texto: "3 tomates y una coca 1.5" });
let p = await store.leerPedido((await store.leerCharla(CL)).pedidoId);
const tom = p.items.find((i) => i.sku === TOMATE);
ok("'3 tomates': queda por pesar (3 unidades), sin sumar al total todavía", tom?.porPesar?.unidades === 3 && tom.qty === 0 && p.total === 8200 + 2000 + 200);
ok("el asistente sabe que está por pesar y que no lo cierre", resultados.some((r) => /Por pesar en la tienda/.test(r)));

let [c, d] = await panel("GET", "chats");
ok("en la lista de chats sale el aviso ⚖️ en ese chat", d.chats.find((f) => f.id === CL)?.porPesar?.[0]?.unidades === 3);
[c, d] = await panel("GET", "chat", { query: { c: CL } });
ok("dentro del chat, el aviso con el producto y el precio por libra", d.ficha.porPesar?.[0]?.sku === TOMATE && d.ficha.porPesar[0].precioLibra === PRECIO);

// Intentar cerrar antes de pesar: no se cierra.
guion.push(herramienta("guardar_pedido", { items: [{ sku: TOMATE, unidades: 3 }, { sku: COCA, cantidad: 1 }], direccion: "Torre 1 apto 101", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 50000 }), texto("Apenas pesen los tomates te confirmo."));
await atenderEntrante({ id: "wamid.c2", telefono: CL, tipo: "text", texto: "efectivo, torre 1 apto 101, con 50 mil" });
p = await store.leerPedido(p.id);
ok("sin pesar no se cierra el pedido", p.status === "armando" && p.items.find((i) => i.sku === TOMATE)?.porPesar);

// La tienda pesa: 680 g.
const antes = alModelo.length;
[c, d] = await panel("POST", "pesar", { body: { c: CL, sku: TOMATE, gramos: 680 } });
const esperado = Math.round((PRECIO * 680) / 500 / 50) * 50;
p = await store.leerPedido(p.id);
const pesado = p.items.find((i) => i.sku === TOMATE);
ok("pesar 680 g: queda en el pedido con su valor (precio por libra × peso)", c === 200 && d.valor === esperado && pesado.price === esperado && pesado.qty === 1 && pesado.pesado?.gramos === 680 && /680 g/.test(pesado.name));
ok("el total ya lo incluye", p.total === esperado + 8200 + 2000 + 200);
ok("el asistente recibe la nota con el peso y el precio", alModelo.slice(antes).some((m) => /La tienda pesó 3 de .*680 g/.test(JSON.stringify(m.content))));
[c, d] = await panel("GET", "chats");
ok("el aviso se quita", !d.chats.find((f) => f.id === CL)?.porPesar);
[c, d] = await panel("POST", "pesar", { body: { c: CL, sku: TOMATE, gramos: 700 } });
ok("pesar otra vez lo mismo: 409", c === 409);

// El asistente vuelve a mandar la lista con las mismas unidades: lo pesado se conserva y ya se puede cerrar.
guion.push(herramienta("guardar_pedido", { items: [{ sku: TOMATE, unidades: 3 }, { sku: COCA, cantidad: 1 }], direccion: "Torre 1 apto 101", metodo_pago: "Contraentrega" }), herramienta("cerrar_pedido", { paga_con: 50000 }), texto("Listo, veci."));
await atenderEntrante({ id: "wamid.c3", telefono: CL, tipo: "text", texto: "dale, cerralo" });
p = await store.leerPedido(p.id);
ok("con lo pesado conservado, el pedido se cierra con ese valor", p.status === "alistando" && p.items.find((i) => i.sku === TOMATE)?.price === esperado);
