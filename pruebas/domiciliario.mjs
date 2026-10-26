// Flujo completo del domiciliario con WhatsApp simulado y sin modelo de IA.
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
import { pathToFileURL } from "node:url";
const raiz = pathToFileURL(process.cwd() + "/").href;
process.env.YCLOUD_API_KEY = "prueba";
process.env.YCLOUD_FROM = "573000000000";
process.env.ANTHROPIC_API_KEY = "prueba";
const enviados = [];
let llamadasIA = 0;
const FOTO = Buffer.from("foto-de-la-entrega").toString("base64");
globalThis.fetch = async (url, o) => {
  const u = String(url);
  if (u.includes("ycloud.com")) {
    const b = JSON.parse(o.body);
    enviados.push({ a: b.to || b.recipient, texto: b.text?.body ?? b.interactive?.body?.text ?? "(" + b.type + ")" });
    return new Response("{}", { status: 200 });
  }
  llamadasIA++;
  return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Listo, veci." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const store = await import(raiz + "lib/store.js");
const { atenderEntrante } = await import(raiz + "lib/entrada.js");
const pedidos = (await import(raiz + "api/orders.js")).default;
const { crear } = await import(raiz + "lib/usuarios.js");
const ok = (n, c) => console.log((c ? "OK    " : "FALLA ") + n);
const DOMI = "573152213872", CLIENTE = "573009998877";
const ultimoA = (tel) => enviados.filter((e) => e.a === tel).at(-1)?.texto ?? "";

// El panel actúa con sesión: se arma una cookie de un admin de prueba.
const { usuario } = await crear({ usuario: "dueno", nombre: "D", rol: "admin", clave: "clave-de-prueba-1" });
const registro = (await store.leerUsuarios())[usuario.usuario];
let cookie = "";
await (await import(raiz + "lib/usuarios.js")).abrirSesion({ setHeader: (k, v) => { cookie = String(v).split(";")[0]; } }, registro);
const llamar = (body) => new Promise((resolve) => pedidos({ method: "PATCH", headers: { cookie }, query: {}, body }, { status(c) { this.c = c; return this; }, json(d) { resolve([this.c, d]); }, setHeader() {} }));

await store.guardarAjustes({ whatsappActivo: true, domiciliarios: [{ id: "d1", nombre: "Juan Pablo", telefono: DOMI, activo: true }] });
let n = 0;
const escribe = (tel, tipo, texto = "") => atenderEntrante({ id: "w" + ++n, telefono: tel, tipo, texto, bajar: async () => ({ mediaType: "image/jpeg", base64: FOTO }) });

// Pedido en alistamiento: se le asigna código.
const pedido = { id: "pdomi00000001", no: 2050, canal: "WhatsApp", cliente: CLIENTE, status: "alistando", pago: "Contraentrega", pagaCon: 20000, direccion: "Manzano torre 2 apto 208", items: [{ sku: "7702004003508", name: "Cerveza Club Colombia Lata 330 Cc", price: 4200, qty: 2 }], total: 10400, hora: Date.now() };
await store.guardarPedido(pedido);
const codigo = (await store.leerPedido(pedido.id)).codigo;
ok("al alistar recibe un código de 4 números: " + codigo, /^\d{4}$/.test(codigo));

// Despacha sin que el domiciliario haya iniciado turno.
await llamar({ id: pedido.id, cambios: { status: "en_camino" } });
let p = await store.leerPedido(pedido.id);
ok("sin turno: queda asignado pero el aviso no sale", p.domiciliario?.nombre === "Juan Pablo" && p.avisoDomiciliario === "sin turno" && !enviados.some((e) => e.a === DOMI));

// Inicia turno.
await escribe(DOMI, "text", "inicio turno");
ok("al iniciar turno le llega el pedido que se despachó antes", enviados.filter((e) => e.a === DOMI).some((e) => e.texto.startsWith("*" + codigo + " · Manzano T2-208")) && (await store.leerPedido(pedido.id)).avisoDomiciliario === "enviado");
ok("inicio de turno: se le confirma y no pasa por el asistente", /Turno iniciado, Juan Pablo/.test(ultimoA(DOMI)) && llamadasIA === 0 && (await store.turnoDe("d1")) === DOMI);

// Otro pedido, ya con turno: le llega el mensaje.
const otro = { ...pedido, id: "pdomi00000002", no: 2051, pago: "Transferencia", pagaCon: 0, direccion: "Conjunto Sauko, Torre 4, Apto 901", items: [{ sku: "1", name: "Gaseosa Coca Cola 3 Lt Pet", price: 12000, qty: 1 }], total: 14000, codigo: undefined };
await store.guardarPedido(otro);
await llamar({ id: otro.id, cambios: { status: "en_camino" } });
const msj = ultimoA(DOMI);
p = await store.leerPedido(otro.id);
console.log("\n--- Mensaje al domiciliario ---\n" + msj + "\n-------------------------------");
ok("con turno: le llega el pedido con título, sin número de pedido y sin cobrar (transferencia)", p.avisoDomiciliario === "enviado" && msj.startsWith(`*${p.codigo} · Sauko T4-901 · 1 Coca Cola 3 Lt`) && !/#2051/.test(msj) && /no cobrar nada/.test(msj));

// Código equivocado.
await escribe(DOMI, "text", "0000");
ok("código equivocado: se le dice que no existe", /No encuentro ningún pedido con el número 0000/.test(ultimoA(DOMI)));

// Código bien, sin foto: se le pide la foto.
await escribe(DOMI, "text", p.codigo);
ok("código sin foto: se le pide la foto", /mandá la foto/.test(ultimoA(DOMI)));
await escribe(DOMI, "image", "");
p = await store.leerPedido(otro.id);
ok("foto después del código: entregado, con foto y quién entregó", p.status === "entregado" && p.entregadoPor === "Juan Pablo" && p.fotoEntrega.startsWith("data:image/jpeg"));

ok("al domiciliario le confirma con el título", ultimoA(DOMI).startsWith("✅ Entregado: " + p.codigo));
// Caso real (#6052): la tienda le dio "Marcar entregado" en el panel antes de que llegara la foto del domiciliario.
const tercero = { ...otro, id: "pdomi00000003", no: 2052, codigo: undefined };
await store.guardarPedido(tercero);
await llamar({ id: tercero.id, cambios: { status: "en_camino" } });
await llamar({ id: tercero.id, cambios: { status: "entregado" } });
const t3 = await store.leerPedido(tercero.id);
await escribe(DOMI, "image", t3.codigo);
const t3b = await store.leerPedido(tercero.id);
ok("ya marcado entregado por la tienda: la foto queda en el pedido y se le dice al domiciliario", /ya lo había marcado entregado/.test(ultimoA(DOMI)) && t3b.status === "entregado" && t3b.fotoEntrega?.startsWith("data:image/jpeg") && t3b.entregadoPor === "Juan Pablo");
await escribe(DOMI, "image", t3.codigo);
ok("si ya tiene foto, se le dice que ya aparece entregado", /ya aparece entregado/.test(ultimoA(DOMI)));
ok("al cliente le llega el aviso de entregado", /entregado/i.test(ultimoA(CLIENTE)));

// El primer pedido: le llega cuando despacha de nuevo? No: ya estaba en camino. Entrega con foto y código en el mismo mensaje.
const primero = await store.leerPedido(pedido.id);
await escribe(DOMI, "image", "listo " + primero.codigo);
p = await store.leerPedido(pedido.id);
ok("foto con el código escrito: entregado, efectivo pendiente de caja", p.status === "entregado" && p.efectivoPorEntregar === 10400 && /llevar \$10\.400 a la caja/.test(ultimoA(DOMI)));

// El efectivo se marca recibido en caja.
await llamar({ id: pedido.id, cambios: { efectivoEnCaja: true } });
ok("recibido en caja: ya no queda pendiente", (await store.leerPedido(pedido.id)).efectivoPorEntregar === 0);

// Foto sin código ni pendiente.
await escribe(DOMI, "image", "");
ok("foto suelta: se le dice que no tiene pedidos en camino", /no tenés pedidos en camino/.test(ultimoA(DOMI)));

// Mensaje repetido por el proveedor: no repite la entrega.
const antes = enviados.length;
await atenderEntrante({ id: "w" + n, telefono: DOMI, tipo: "text", texto: "inicio turno" });
ok("un mensaje repetido no se procesa dos veces", enviados.length === antes);

// Desactivado: vuelve a ser cliente.
await store.guardarAjustes({ ...(await store.leerAjustes()), domiciliarios: [{ id: "d1", nombre: "Juan Pablo", telefono: DOMI, activo: false }] });
await escribe(DOMI, "text", "hola, quiero una gaseosa");
ok("desactivado: sus mensajes los atiende el asistente como a un cliente", llamadasIA > 0);

// Domiciliario nuevo que escribió "inicio turno" antes de que lo agregaran en el panel: al agregarlo
// se le abre el turno sin que tenga que volver a escribir.
const { abrirTurnoSiYaEscribio } = await import(raiz + "lib/domiciliarios.js");
const NUEVO = "573151112233";
await store.registrarMensaje(NUEVO, { id: "wnuevo", dir: "in", de: "cliente", tipo: "text", texto: "Inicio turno", hora: Date.now() - 10 * 60000 });
const carlos = { id: "d2", nombre: "Carlos", telefono: NUEVO, activo: true };
await store.guardarAjustes({ ...(await store.leerAjustes()), domiciliarios: [carlos] });
const abierto = await abrirTurnoSiYaEscribio(carlos);
ok("agregado después de escribir: el turno queda abierto y se le avisa", abierto && Boolean(await store.turnoDe("d2")) && /Turno iniciado, Carlos/.test(ultimoA(NUEVO)));
ok("si nunca escribió, no se le abre nada", !(await abrirTurnoSiYaEscribio({ id: "d3", nombre: "Otro", telefono: "573150000000", activo: true })));

// Lo mismo con un domiciliario registrado por su @usuario (el chat lleva su identificador de WhatsApp).
const BSUID = "CO.9988776655";
await store.registrarMensaje(BSUID, { id: "wghost", dir: "in", de: "cliente", tipo: "text", texto: "Inicio turno", hora: Date.now() - 5 * 60000, usuario: "ghost_bicht" });
const hache = { id: "d4", nombre: "Hache", telefono: "@ghost_bicht", activo: true };
await store.guardarAjustes({ ...(await store.leerAjustes()), domiciliarios: [hache] });
ok("con @usuario: también se le abre el turno y se le escribe por su identificador", (await abrirTurnoSiYaEscribio(hache)) && (await store.turnoDe("d4")) === BSUID && /Turno iniciado, Hache/.test(ultimoA(BSUID)));

// Anular un pedido de prueba que ya quedó entregado: queda cancelado, sale de la caja y no se le avisa al cliente.
await store.guardarPedido({ id: "pprueba01", no: 3208, canal: "WhatsApp", cliente: CLIENTE, status: "entregado", pago: "Contraentrega", items: [{ sku: "7702004007360", name: "Cerveza Poker", price: 4000, qty: 10 }], total: 42200, efectivoPorEntregar: 0, hora: Date.now() });
let [cod] = await llamar({ id: "pprueba01", cambios: { status: "cancelado", motivo: "El cliente canceló" } });
ok("un pedido entregado no se cancela con un motivo cualquiera", cod === 400);
const avisosAntes = enviados.filter((e) => e.a === CLIENTE).length;
[cod] = await llamar({ id: "pprueba01", cambios: { status: "cancelado", motivo: "Pedido de prueba", devolver: true } });
const anulado = await store.leerPedido("pprueba01");
ok("como pedido de prueba sí: queda cancelado y no se le avisa al cliente", cod === 200 && anulado.status === "cancelado" && anulado.motivoCancelacion === "Pedido de prueba" && enviados.filter((e) => e.a === CLIENTE).length === avisosAntes);

// Foto de entrega puesta a mano desde el panel (la que el domiciliario dejó en el chat).
await store.guardarPedido({ id: "pfotomano1", no: 6052, canal: "WhatsApp", cliente: CLIENTE, status: "entregado", pago: "Transferencia", items: [{ sku: "1", name: "Pan", price: 1000, qty: 1 }], total: 3200, hora: Date.now(), domiciliario: { id: "d1", nombre: "Juan Esteban" } });
const FOTO_PANEL = "data:image/jpeg;base64," + "B".repeat(2000);
let [cf] = await llamar({ id: "pfotomano1", cambios: { fotoEntrega: FOTO_PANEL } });
const conFoto = await store.leerPedido("pfotomano1");
ok("desde el panel se guarda la foto de entrega de un pedido entregado (y quién entregó)", cf === 200 && conFoto.fotoEntrega === FOTO_PANEL && conFoto.entregadoPor === "Juan Esteban" && conFoto.status === "entregado");
[cf] = await llamar({ id: "pfotomano1", cambios: { fotoEntrega: FOTO_PANEL } });
ok("no reemplaza una foto que ya tiene", cf === 409);
