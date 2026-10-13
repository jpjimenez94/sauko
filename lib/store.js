// Dónde se guarda cada cosa:
// - Pedidos: en Postgres si hay DATABASE_URL (queda el historial para reportes); si no, en Redis.
// - Conversaciones de WhatsApp, agotados, ajustes y bitácora: en Redis de Upstash.
// Sin ninguna de las dos bases todo queda en memoria, que solo sirve para probar en local:
// en Vercel cada función tiene su propia memoria.
const URL_KV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_KV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const URL_PG = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const hayBase = Boolean(URL_KV && TOKEN_KV);
export const hayPostgres = Boolean(URL_PG);

const PEDIDOS = "sauko:pedidos";
const AGOTADOS = "sauko:agotados";

globalThis.__sauko ??= { pedidos: new Map(), agotados: {}, charlas: new Map(), vistos: new Set(), ajustes: null, bitacora: [], pausas: new Map() };
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

/* ---------- Postgres: pedidos ---------- */

// Una conexión por instancia del servidor, que se reutiliza entre peticiones.
async function sql(texto, valores = []) {
  globalThis.__saukoPg ??= (async () => {
    const pg = globalThis.__saukoPgModulo ?? (await import("pg")).default; // las pruebas ponen uno en memoria
    const sinSsl = /localhost|127\.0\.0\.1|sslmode=disable/.test(URL_PG);
    const pool = new pg.Pool({ connectionString: URL_PG, max: 2, ssl: sinSsl ? false : { rejectUnauthorized: false } });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id text PRIMARY KEY,
        numero integer NOT NULL,
        canal text NOT NULL,
        cliente text,
        estado text NOT NULL,
        total integer NOT NULL DEFAULT 0,
        creado timestamptz NOT NULL,
        actualizado timestamptz NOT NULL DEFAULT now(),
        archivado boolean NOT NULL DEFAULT false,
        datos jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pedidos_vigentes ON pedidos (archivado, creado DESC);
    `);
    return pool;
  })();
  const pool = await globalThis.__saukoPg;
  return (await pool.query(texto, valores)).rows;
}

/** Los pedidos que ve el panel: los que no se han archivado, de los últimos tres días. */
export async function listarPedidos() {
  if (hayPostgres) return (await sql("SELECT datos FROM pedidos WHERE NOT archivado AND creado > now() - interval '3 days' ORDER BY creado")).map((f) => f.datos);
  if (!hayBase) return [...memoria.pedidos.values()];
  const plano = (await redis("HGETALL", PEDIDOS)) || [];
  const pedidos = [];
  for (let i = 1; i < plano.length; i += 2) pedidos.push(JSON.parse(plano[i]));
  return pedidos;
}

export async function leerPedido(id) {
  if (hayPostgres) return (await sql("SELECT datos FROM pedidos WHERE id = $1", [id]))[0]?.datos ?? null;
  if (!hayBase) return memoria.pedidos.get(id) ?? null;
  const texto = await redis("HGET", PEDIDOS, id);
  return texto ? JSON.parse(texto) : null;
}

export async function guardarPedido(pedido) {
  if (hayPostgres) {
    await sql(
      `INSERT INTO pedidos (id, numero, canal, cliente, estado, total, creado, datos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET estado = $5, total = $6, datos = $8, actualizado = now()`,
      [pedido.id, pedido.no, pedido.canal, pedido.cliente ?? null, pedido.status, pedido.total, new Date(pedido.hora).toISOString(), JSON.stringify(pedido)],
    );
  } else if (!hayBase) memoria.pedidos.set(pedido.id, pedido);
  else await redis("HSET", PEDIDOS, pedido.id, JSON.stringify(pedido));
  return pedido;
}

/** Saca el pedido del panel. En Postgres se archiva y queda en el historial; en Redis se borra. */
export async function borrarPedido(id) {
  if (hayPostgres) await sql("UPDATE pedidos SET archivado = true, actualizado = now() WHERE id = $1", [id]);
  else if (!hayBase) memoria.pedidos.delete(id);
  else await redis("HDEL", PEDIDOS, id);
}

/* ---------- Redis: lo demás ---------- */

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

// Cuando alguien de la tienda le contesta a mano a un cliente, el asistente se calla un rato
// en esa conversación para no hablar los dos a la vez.
export async function pausar(telefono, segundos) {
  if (!hayBase) memoria.pausas.set(telefono, Date.now() + segundos * 1000);
  else await redis("SET", `sauko:pausa:${telefono}`, "1", "EX", segundos);
}

export async function enPausa(telefono) {
  if (!hayBase) return (memoria.pausas.get(telefono) ?? 0) > Date.now();
  return (await redis("EXISTS", `sauko:pausa:${telefono}`)) === 1;
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

// Bitácora corta del canal de WhatsApp, para diagnosticar desde el panel sin entrar a Vercel.
export async function anotar(paso, detalle = "") {
  const linea = JSON.stringify({ hora: new Date().toISOString(), paso, detalle: String(detalle).slice(0, 300) });
  try {
    if (!hayBase) return void (memoria.bitacora.unshift(linea), memoria.bitacora.splice(40));
    await redis("LPUSH", "sauko:bitacora", linea);
    await redis("LTRIM", "sauko:bitacora", 0, 39);
  } catch (error) {
    console.error("bitácora:", error);
  }
}

export async function leerBitacora() {
  const lineas = hayBase ? (await redis("LRANGE", "sauko:bitacora", 0, 39)) || [] : memoria.bitacora;
  return lineas.map((l) => JSON.parse(l));
}

/* ---------- Usuarios del panel ---------- */

// Son pocos, así que van todos en un solo documento: { usuario: registro }.
export async function leerUsuarios() {
  if (!hayBase) return (memoria.usuarios ??= {});
  const texto = await redis("GET", "sauko:usuarios");
  return texto ? JSON.parse(texto) : {};
}

export async function guardarUsuarios(usuarios) {
  if (!hayBase) memoria.usuarios = usuarios;
  else await redis("SET", "sauko:usuarios", JSON.stringify(usuarios));
}

/** Secreto con el que se firman las sesiones. Se genera solo la primera vez y queda guardado. */
export async function secretoDeSesiones(nuevo) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!hayBase) return (memoria.secreto ??= nuevo);
  await redis("SET", "sauko:secreto", nuevo, "NX");
  return redis("GET", "sauko:secreto");
}

/** Cuenta un intento fallido de inicio de sesión; el contador se borra solo a los 15 minutos. */
export async function sumarIntento(clave) {
  if (!hayBase) {
    const m = (memoria.intentos ??= new Map());
    const actual = m.get(clave);
    const cuenta = actual && actual.hasta > Date.now() ? actual.n + 1 : 1;
    m.set(clave, { n: cuenta, hasta: Date.now() + 900_000 });
    return cuenta;
  }
  const cuenta = await redis("INCR", `sauko:intentos:${clave}`);
  if (cuenta === 1) await redis("EXPIRE", `sauko:intentos:${clave}`, 900);
  return cuenta;
}

export async function leerIntentos(clave) {
  if (!hayBase) {
    const actual = memoria.intentos?.get(clave);
    return actual && actual.hasta > Date.now() ? actual.n : 0;
  }
  return Number(await redis("GET", `sauko:intentos:${clave}`)) || 0;
}

export async function borrarIntentos(clave) {
  if (!hayBase) memoria.intentos?.delete(clave);
  else await redis("DEL", `sauko:intentos:${clave}`);
}
