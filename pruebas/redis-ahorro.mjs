// Consumo de Redis (Upstash cobra cada comando y cada byte): con un Redis de mentira se revisa que las fotos de
// los pedidos van aparte (la lista no las trae), que el panel no relee todo si nada cambió y que el pedido
// completo (con fotos) se sigue leyendo bien para guardarlo.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
process.env.KV_REST_API_URL = "https://redis.prueba";
process.env.KV_REST_API_TOKEN = "x";
import { pathToFileURL } from "node:url";

const datos = new Map(), comandos = [];
function ejecutar([cmd, clave, ...args]) {
  comandos.push(cmd);
  const hash = () => (datos.has(clave) ? datos.get(clave) : datos.set(clave, new Map()).get(clave));
  switch (cmd) {
    case "GET": return datos.get(clave) ?? null;
    case "SET": if (args.includes("NX") && datos.has(clave)) return null; datos.set(clave, args[0]); return "OK";
    case "INCR": datos.set(clave, String(Number(datos.get(clave) ?? 0) + 1)); return Number(datos.get(clave));
    case "DEL": return Number(datos.delete(clave));
    case "HSET": for (let i = 0; i < args.length; i += 2) hash().set(args[i], args[i + 1]); return 1;
    case "HGET": return datos.get(clave)?.get(args[0]) ?? null;
    case "HMGET": return args.map((f) => datos.get(clave)?.get(f) ?? null);
    case "HDEL": return args.filter((f) => datos.get(clave)?.delete(f)).length;
    case "HGETALL": return [...(datos.get(clave) ?? new Map())].flat();
    case "HINCRBY": hash().set(args[0], String(Number(hash().get(args[0]) ?? 0) + Number(args[1]))); return Number(hash().get(args[0]));
    case "RPUSH": datos.set(clave, [...(datos.get(clave) ?? []), ...args]); return datos.get(clave).length;
    case "LRANGE": return (datos.get(clave) ?? []).slice(Number(args[0]));
    case "ZADD": hash().set(args[1], Number(args[0])); return 1;
    case "ZREVRANGE": return [...(datos.get(clave) ?? new Map())].sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, Number(args[1]) + 1);
    case "TTL": return datos.has(clave) ? 600 : -2;
    default: return null;
  }
}
globalThis.fetch = async (url, o = {}) => {
  const cuerpo = JSON.parse(o.body);
  const r = String(url).endsWith("/pipeline") ? cuerpo.map((c) => ({ result: ejecutar(c) })) : { result: ejecutar(cuerpo) };
  return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
};

const { guardarPedido, leerPedido, listarPedidos, borrarPedido, fotosDePedido, registrarMensaje, listarConversaciones, leerConversacion, marcarConversacionLeida, pausar } = await import(pathToFileURL(process.cwd() + "/").href + "lib/store.js");
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const FOTO = "data:image/jpeg;base64," + "A".repeat(5000);
const base = { canal: "WhatsApp", cliente: "573000000000", items: [{ sku: "1", name: "Pan", price: 1000, qty: 1 }], total: 1000, hora: Date.now(), descontado: true };

await guardarPedido({ ...base, id: "pespera1", no: 1, status: "por_confirmar", pago: "Transferencia", proof: FOTO });
await guardarPedido({ ...base, id: "pentrega1", no: 2, status: "entregado", pago: "Transferencia", proof: FOTO, fotoEntrega: FOTO });

const enLista = datos.get("sauko:pedidos").get("pentrega1");
ok("en la lista de Redis el pedido queda sin las fotos", !enLista.includes("base64") && JSON.parse(enLista).tieneComprobante && JSON.parse(enLista).tieneFotoEntrega);
ok("las fotos quedan aparte", JSON.parse(datos.get("sauko:pedidos-fotos").get("pentrega1")).fotoEntrega === FOTO);

const completo = await leerPedido("pentrega1");
ok("el pedido completo trae sus fotos (para guardarlo sin perderlas)", completo.proof === FOTO && completo.fotoEntrega === FOTO && !completo.tieneComprobante);
comandos.length = 0;
const paraCliente = await leerPedido("pentrega1", false, false);
ok("la página del cliente no lee las fotos", !paraCliente.proof && comandos.length === 1);

const lista = await listarPedidos();
const espera = lista.find((p) => p.id === "pespera1"), entregado = lista.find((p) => p.id === "pentrega1");
ok("el panel ve el comprobante del que espera confirmación", espera?.proof === FOTO);
ok("del entregado solo sabe que tiene fotos", entregado && !entregado.proof && !entregado.fotoEntrega && entregado.tieneComprobante && entregado.tieneFotoEntrega);

comandos.length = 0;
await listarPedidos();
ok("si nada cambió, el panel no relee los pedidos (un GET pequeño)", !comandos.includes("HGETALL") && comandos.filter((c) => c === "GET").length === 1);

await guardarPedido({ ...completo, status: "cancelado" });
comandos.length = 0;
const despues = await listarPedidos();
ok("cuando algo cambia, el panel lo ve en la siguiente consulta", comandos.includes("HGETALL") && despues.find((p) => p.id === "pentrega1")?.status === "cancelado");
ok("guardar el pedido completo no pierde las fotos", (await fotosDePedido("pentrega1")).fotoEntrega === FOTO);

await guardarPedido({ ...(await leerPedido("pespera1")), status: "esperando_pago", proof: "" });
ok("si se rechaza el comprobante, la foto se quita también aparte", !datos.get("sauko:pedidos-fotos").has("pespera1") && !(await leerPedido("pespera1")).proof);

await borrarPedido("pentrega1");
ok("quitar un pedido borra también sus fotos", !datos.get("sauko:pedidos").has("pentrega1") && !datos.get("sauko:pedidos-fotos").has("pentrega1") && !(await listarPedidos()).some((p) => p.id === "pentrega1"));

// Conversaciones: la lista del panel son 2 comandos por chat; solo se relee si algo cambió.
await registrarMensaje("573111111111", { id: "wamid.1", dir: "in", tipo: "text", texto: "Hola veci", nombre: "Ana" });
await registrarMensaje("573222222222", { id: "wamid.2", dir: "in", tipo: "text", texto: "Buenas" });
const chats = await listarConversaciones(150);
ok("la lista de chats trae los dos con sus no leídos", chats.length === 2 && chats.find((f) => f.id === "573111111111")?.noLeidos === 1);
await leerConversacion("573111111111");
comandos.length = 0;
await listarConversaciones(150);
await leerConversacion("573111111111");
ok("si nada cambió, la lista y el chat abierto no se releen", !comandos.includes("HGETALL") && !comandos.includes("LRANGE"));
await marcarConversacionLeida("573111111111");
ok("al marcar leído, la lista lo ve enseguida", (await listarConversaciones(150)).find((f) => f.id === "573111111111")?.noLeidos === 0);
await registrarMensaje("573111111111", { id: "wamid.3", dir: "in", tipo: "text", texto: "¿Tienen pan?" });
ok("un mensaje nuevo aparece en el chat abierto", (await leerConversacion("573111111111")).mensajes.at(-1)?.texto === "¿Tienen pan?");
await pausar("573222222222", 600);
ok("tomar el chat se ve en la lista", (await listarConversaciones(150)).find((f) => f.id === "573222222222")?.pausa > 0);

// El domiciliario entrega con foto un pedido sacado de la lista (sin fotos): no se pierde el comprobante.
await guardarPedido({ ...base, id: "pcamino1", no: 3, status: "en_camino", pago: "Transferencia", proof: FOTO });
const deLista = (await listarPedidos()).find((p) => p.id === "pcamino1");
Object.assign(deLista, { status: "entregado", fotoEntrega: "data:image/jpeg;base64,BBBB" });
await guardarPedido(deLista);
const guardado = await leerPedido("pcamino1");
ok("entregar desde la lista conserva el comprobante y guarda la foto de entrega", guardado.proof === FOTO && guardado.fotoEntrega === "data:image/jpeg;base64,BBBB" && !guardado.tieneComprobante);
