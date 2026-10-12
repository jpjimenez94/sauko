// Pedidos y productos agotados. Con una base Redis de Upstash (la que ofrece Vercel en su
// Marketplace) los datos son compartidos y duraderos; sin ella quedan en memoria, que solo sirve
// para probar en local: en Vercel cada función tiene su propia memoria.
const URL_KV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_KV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const hayBase = Boolean(URL_KV && TOKEN_KV);

const PEDIDOS = "sauko:pedidos";
const AGOTADOS = "sauko:agotados";

globalThis.__sauko ??= { pedidos: new Map(), agotados: {}, charlas: new Map(), vistos: new Set(), ajustes: null };
const memoria = globalThis.__sauko;

async function redis(...comando) {
  const r = await fetch(URL_KV, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_KV}`, "Content-Type": "application/json" },
    body: JSON.stringify(comando),
  });
  const datos = await r.json();
  if (!r.ok || datos.error) throw new Error(datos.error || `Redis respondió ${r.status}`);
  return datos.result;
}

export async function listarPedidos() {
  if (!hayBase) return [...memoria.pedidos.values()];
  const plano = (await redis("HGETALL", PEDIDOS)) || [];
  const pedidos = [];
  for (let i = 1; i < plano.length; i += 2) pedidos.push(JSON.parse(plano[i]));
  return pedidos;
}

export async function leerPedido(id) {
  if (!hayBase) return memoria.pedidos.get(id) ?? null;
  const texto = await redis("HGET", PEDIDOS, id);
  return texto ? JSON.parse(texto) : null;
}

export async function guardarPedido(pedido) {
  if (!hayBase) memoria.pedidos.set(pedido.id, pedido);
  else await redis("HSET", PEDIDOS, pedido.id, JSON.stringify(pedido));
  return pedido;
}

export async function borrarPedido(id) {
  if (!hayBase) memoria.pedidos.delete(id);
  else await redis("HDEL", PEDIDOS, id);
}

export async function leerAgotados() {
  if (!hayBase) return memoria.agotados;
  const texto = await redis("GET", AGOTADOS);
  return texto ? JSON.parse(texto) : {};
}

export async function guardarAgotados(skus) {
  if (!hayBase) memoria.agotados = skus;
  else await redis("SET", AGOTADOS, JSON.stringify(skus));
  return skus;
}

// Conversaciones de WhatsApp: los turnos en texto y el pedido en curso de cada teléfono. Duran dos días.
export async function leerCharla(telefono) {
  if (!hayBase) return memoria.charlas.get(telefono) ?? { turnos: [], pedidoId: null };
  const texto = await redis("GET", `sauko:wa:${telefono}`);
  return texto ? JSON.parse(texto) : { turnos: [], pedidoId: null };
}

export async function guardarCharla(telefono, charla) {
  if (!hayBase) memoria.charlas.set(telefono, charla);
  else await redis("SET", `sauko:wa:${telefono}`, JSON.stringify(charla), "EX", 172800);
}

/** Meta reintenta los avisos: devuelve true solo la primera vez que llega un mensaje. */
export async function esNuevo(mensajeId) {
  if (!hayBase) return !memoria.vistos.has(mensajeId) && Boolean(memoria.vistos.add(mensajeId));
  return (await redis("SET", `sauko:visto:${mensajeId}`, "1", "NX", "EX", 3600)) === "OK";
}

// Ajustes que la tienda cambia desde el panel. El asistente de WhatsApp arranca apagado.
const AJUSTES_INICIALES = { whatsappActivo: false };

export async function leerAjustes() {
  if (!hayBase) return { ...AJUSTES_INICIALES, ...memoria.ajustes };
  const texto = await redis("GET", "sauko:ajustes");
  return { ...AJUSTES_INICIALES, ...(texto ? JSON.parse(texto) : {}) };
}

export async function guardarAjustes(ajustes) {
  if (!hayBase) memoria.ajustes = ajustes;
  else await redis("SET", "sauko:ajustes", JSON.stringify(ajustes));
  return ajustes;
}
