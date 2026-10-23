// Dónde se guarda cada cosa:
// - Pedidos: en Postgres si hay DATABASE_URL (queda el historial para reportes); si no, en Redis.
// - Conversaciones de WhatsApp, agotados, ajustes y bitácora: en Redis de Upstash.
// Sin ninguna de las dos bases todo queda en memoria, que solo sirve para probar en local:
// en Vercel cada función tiene su propia memoria.
import { SALDOS_INICIALES } from "./existencias.js";

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
      CREATE TABLE IF NOT EXISTS clientes (
        id text PRIMARY KEY,
        canal text NOT NULL DEFAULT 'WhatsApp',
        nombre text NOT NULL DEFAULT '',
        usuario text NOT NULL DEFAULT '',
        direccion text NOT NULL DEFAULT '',
        primer_contacto timestamptz NOT NULL,
        ultimo_contacto timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conv_mensajes (
        contacto text NOT NULL,
        wamid text NOT NULL,
        hora timestamptz NOT NULL,
        datos jsonb NOT NULL,
        PRIMARY KEY (contacto, wamid)
      );
      CREATE INDEX IF NOT EXISTS conv_mensajes_hora ON conv_mensajes (contacto, hora);
    `);
    // Un pedido cancelado en el panel quedaba archivado; si el cliente seguía con ese mismo pedido,
    // se guardaba pero nunca volvía a aparecer. Se recuperan los que quedaron así.
    await pool.query("UPDATE pedidos SET archivado = false WHERE archivado AND estado IN ('por_confirmar', 'alistando', 'en_camino') AND creado > now() - interval '3 days'");
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

/** @param {boolean} soloVigente true: un pedido cancelado o archivado cuenta como que no existe */
export async function leerPedido(id, soloVigente = false) {
  if (hayPostgres) return (await sql(`SELECT datos FROM pedidos WHERE id = $1${soloVigente ? " AND NOT archivado" : ""}`, [id]))[0]?.datos ?? null;
  if (!hayBase) return memoria.pedidos.get(id) ?? null;
  const texto = await redis("HGET", PEDIDOS, id);
  return texto ? JSON.parse(texto) : null;
}

export async function guardarPedido(pedido) {
  // Cuando el pedido entra a alistarse (pago confirmado o contraentrega) sus unidades salen del
  // inventario, una sola vez.
  if (["alistando", "en_camino", "entregado"].includes(pedido.status) && !pedido.codigo) pedido.codigo = String(1000 + Math.floor(Math.random() * 9000));
  if (["alistando", "en_camino", "entregado"].includes(pedido.status) && !pedido.descontado) {
    await descontar(pedido.items);
    pedido.descontado = true;
  }
  if (hayPostgres) {
    await sql(
      `INSERT INTO pedidos (id, numero, canal, cliente, estado, total, creado, datos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET estado = $5, total = $6, datos = $8, actualizado = now(), archivado = false`,
      [pedido.id, pedido.no, pedido.canal, pedido.cliente ?? null, pedido.status, pedido.total, new Date(pedido.hora).toISOString(), JSON.stringify(pedido)],
    );
  } else if (!hayBase) memoria.pedidos.set(pedido.id, pedido);
  else await redis("HSET", PEDIDOS, pedido.id, JSON.stringify(pedido));
  return pedido;
}

/** Saca el pedido del panel. En Postgres se archiva y queda en el historial; en Redis se borra. */
/** Los que se quitaron del tablero en los últimos 7 días (siguen en la base) y la forma de devolverlos. */
export async function listarArchivados() {
  if (!hayPostgres) return [];
  return (await sql("SELECT datos FROM pedidos WHERE archivado AND actualizado > now() - interval '7 days' ORDER BY actualizado DESC LIMIT 60")).map((f) => f.datos);
}
export async function restaurarPedido(id) {
  if (hayPostgres) await sql("UPDATE pedidos SET archivado = false, actualizado = now() WHERE id = $1", [id]);
}

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

/** El asistente vuelve a atender esa conversación (la tienda la devolvió desde el panel). */
export async function despausar(telefono) {
  if (!hayBase) memoria.pausas.delete(telefono);
  else await redis("DEL", `sauko:pausa:${telefono}`);
}

/** Segundos que le quedan a la pausa de esa conversación (0 si el asistente la atiende). */
export async function pausaRestante(telefono) {
  if (!hayBase) return Math.max(0, Math.round(((memoria.pausas.get(telefono) ?? 0) - Date.now()) / 1000));
  return Math.max(0, Number(await redis("TTL", `sauko:pausa:${telefono}`)) || 0);
}

// ---------- Conversaciones de WhatsApp para el panel ----------
// Cada chat guarda sus últimos 400 mensajes (entrada y salida) por 30 días, con su ficha (nombre,
// último mensaje, no leídos) y aparte el estado de entrega de lo enviado y los extras (reacciones,
// transcripción de notas de voz).
const CONVS = "sauko:convs";
const VIDA_CONV = 30 * 86400;
const RANGO_ESTADO = { sent: 1, delivered: 2, read: 3, failed: 4 };
const enMemoriaConv = (c) => {
  memoria.convs ??= new Map();
  if (!memoria.convs.has(c)) memoria.convs.set(c, { mensajes: [], info: {}, estados: {}, extras: {} });
  return memoria.convs.get(c);
};
const vistaPrevia = (m) => (m.texto ? String(m.texto).slice(0, 90) : { image: "📷 Foto", audio: "🎤 Nota de voz", video: "🎬 Video", document: "📄 Documento", sticker: "Sticker", location: "📍 Ubicación", interactive: "Opciones" }[m.tipo] ?? m.tipo);

/** Guarda un mensaje del chat. m: { id, dir: "in"|"out", de, tipo, texto, medio, botones, contexto, nombre, usuario, por } */
export async function registrarMensaje(contacto, m) {
  const c = String(contacto ?? "");
  if (!c) return;
  // Meta reintenta los avisos que tardan: un mensaje del cliente se guarda una sola vez.
  if (m.dir === "in" && m.id) {
    if (!hayBase) {
      memoria.convVistos ??= new Set();
      if (memoria.convVistos.has(m.id)) return;
      memoria.convVistos.add(m.id);
    } else if ((await redis("SET", `sauko:conv-visto:${m.id}`, "1", "NX", "EX", 86400)) !== "OK") return;
  }
  const hora = m.hora ?? Date.now();
  const { nombre, usuario, ...guardar } = m;
  const mensaje = JSON.stringify({ ...guardar, hora });
  const ficha = { ultimo: vistaPrevia(m), ultimoDir: m.dir, hora: String(hora), ...(m.dir === "in" ? { ultimoCliente: String(hora) } : {}), ...(m.dir === "in" && m.linea ? { linea: String(m.linea), numero: String(m.numero ?? "") } : {}), ...(nombre ? { nombre: String(nombre).slice(0, 60) } : {}), ...(usuario ? { usuario: String(usuario).slice(0, 40) } : {}) };
  if (!hayBase) {
    const conv = enMemoriaConv(c);
    conv.mensajes.push(JSON.parse(mensaje));
    if (conv.mensajes.length > 400) conv.mensajes.shift();
    Object.assign(conv.info, ficha);
    if (m.dir === "in") conv.info.noLeidos = String(Number(conv.info.noLeidos ?? 0) + 1);
    await alHistorial(c, JSON.parse(mensaje));
    if (m.dir === "in") await anotarCliente(c, { nombre, usuario, hora });
    return;
  }
  const comandos = [
    ["RPUSH", `sauko:conv:${c}`, mensaje],
    ["LTRIM", `sauko:conv:${c}`, "-400", "-1"],
    ["EXPIRE", `sauko:conv:${c}`, String(VIDA_CONV)],
    ["ZADD", CONVS, String(hora), c],
    ["HSET", `sauko:conv-info:${c}`, ...Object.entries(ficha).flat()],
    ["EXPIRE", `sauko:conv-info:${c}`, String(VIDA_CONV)],
  ];
  if (m.dir === "in") comandos.push(["HINCRBY", `sauko:conv-info:${c}`, "noLeidos", "1"]);
  await redisVarios(comandos);
  await alHistorial(c, JSON.parse(mensaje));
  if (m.dir === "in") await anotarCliente(c, { nombre, usuario, hora });
}

/** Estado de entrega de un mensaje enviado (sent, delivered, read, failed). No retrocede: leído no vuelve a entregado. */
export async function marcarEstadoMensaje(contacto, wamid, estado, error = "") {
  const c = String(contacto ?? "");
  if (!c || !wamid || !RANGO_ESTADO[estado]) return;
  if (!hayBase) {
    const conv = enMemoriaConv(c);
    const antes = conv.estados[wamid]?.split("|")[0];
    if (!antes || RANGO_ESTADO[estado] > RANGO_ESTADO[antes]) conv.estados[wamid] = estado + (error ? "|" + error : "");
    return;
  }
  const antes = String((await redis("HGET", `sauko:conv-est:${c}`, wamid)) ?? "").split("|")[0];
  if (antes && RANGO_ESTADO[estado] <= RANGO_ESTADO[antes]) return;
  await redisVarios([["HSET", `sauko:conv-est:${c}`, wamid, estado + (error ? "|" + String(error).slice(0, 120) : "")], ["EXPIRE", `sauko:conv-est:${c}`, String(VIDA_CONV)]]);
}

/** Datos que se suman a un mensaje ya guardado: reacción del cliente o de la tienda, transcripción de la nota de voz. */
export async function anotarEnMensaje(contacto, wamid, campos) {
  const c = String(contacto ?? "");
  if (!c || !wamid) return;
  if (!hayBase) {
    const conv = enMemoriaConv(c);
    conv.extras[wamid] = { ...(conv.extras[wamid] ?? {}), ...campos };
    return;
  }
  const antes = JSON.parse((await redis("HGET", `sauko:conv-extra:${c}`, wamid)) ?? "{}");
  await redisVarios([["HSET", `sauko:conv-extra:${c}`, wamid, JSON.stringify({ ...antes, ...campos })], ["EXPIRE", `sauko:conv-extra:${c}`, String(VIDA_CONV)]]);
}

const fichaLimpia = (c, info, pausa) => ({ id: c, nombre: info.nombre ?? "", usuario: info.usuario ?? "", ultimo: info.ultimo ?? "", ultimoDir: info.ultimoDir ?? "", hora: Number(info.hora ?? 0), ultimoCliente: Number(info.ultimoCliente ?? 0), linea: info.linea ?? "", numero: info.numero ?? "", noLeidos: Number(info.noLeidos ?? 0), pausa: Math.max(0, Number(pausa) || 0) });
const deParejas = (lista) => (Array.isArray(lista) ? Object.fromEntries(lista.reduce((a, v, i) => (i % 2 ? (a[a.length - 1].push(v), a) : (a.push([v]), a)), [])) : lista ?? {});

/** Los chats más recientes, con su ficha y si la tienda está atendiendo (pausa en segundos). */
export async function listarConversaciones(limite = 100) {
  if (!hayBase) {
    const lista = [...(memoria.convs ?? new Map()).entries()].map(([c, conv]) => fichaLimpia(c, conv.info, Math.round(((memoria.pausas.get(c) ?? 0) - Date.now()) / 1000)));
    return lista.sort((a, b) => b.hora - a.hora).slice(0, limite);
  }
  const ids = (await redis("ZREVRANGE", CONVS, "0", String(limite - 1))) ?? [];
  if (!ids.length) return [];
  const r = await redisVarios(ids.flatMap((c) => [["HGETALL", `sauko:conv-info:${c}`], ["TTL", `sauko:pausa:${c}`]]));
  return ids.map((c, i) => fichaLimpia(c, deParejas(r[i * 2]?.result), r[i * 2 + 1]?.result)).filter((f) => f.hora);
}

/** Un chat completo: ficha, últimos mensajes con su estado de entrega y sus extras. */
export async function leerConversacion(contacto, limite = 250) {
  const c = String(contacto ?? "");
  if (!hayBase) {
    const conv = enMemoriaConv(c);
    const pausa = Math.round(((memoria.pausas.get(c) ?? 0) - Date.now()) / 1000);
    if (!conv.mensajes.length && hayPostgres) return leerHistorial(c, limite, pausa);
    return { ficha: fichaLimpia(c, conv.info, pausa), mensajes: conv.mensajes.slice(-limite).map((m) => ({ ...m, estado: conv.estados[m.id], ...(conv.extras[m.id] ?? {}) })) };
  }
  const [lista, estados, extras, info, pausa] = (
    await redisVarios([["LRANGE", `sauko:conv:${c}`, String(-limite), "-1"], ["HGETALL", `sauko:conv-est:${c}`], ["HGETALL", `sauko:conv-extra:${c}`], ["HGETALL", `sauko:conv-info:${c}`], ["TTL", `sauko:pausa:${c}`]])
  ).map((x) => x?.result);
  const est = deParejas(estados), ext = deParejas(extras);
  const mensajes = (lista ?? []).map((t) => JSON.parse(t)).map((m) => ({ ...m, estado: est[m.id], ...JSON.parse(ext[m.id] ?? "{}") }));
  if (!mensajes.length && hayPostgres) return leerHistorial(c, limite, pausa);
  return { ficha: fichaLimpia(c, deParejas(info), pausa), mensajes };
}

// ---------- Historial largo de los chats (Postgres) y clientes (permanente) ----------
// Redis guarda los chats 30 días para el panel; el texto de cada mensaje también va a Postgres y se
// conserva lo que diga Ajustes (historialDias, 365 por defecto). Fotos y audios dependen de Meta (30 días).
async function alHistorial(c, m) {
  if (!hayPostgres || !m.id) return;
  try {
    await sql("INSERT INTO conv_mensajes (contacto, wamid, hora, datos) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4) ON CONFLICT (contacto, wamid) DO NOTHING", [c, m.id, m.hora, JSON.stringify(m)]);
    // De vez en cuando se borra lo que pasó del plazo (sin tareas programadas).
    if (Math.random() < 0.01) {
      const dias = Math.max(30, Number((await leerAjustes()).negocio?.historialDias) || 365);
      await sql("DELETE FROM conv_mensajes WHERE hora < now() - make_interval(days => $1)", [dias]);
    }
  } catch (error) {
    console.error("historial:", error);
  }
}

async function leerHistorial(c, limite, pausa) {
  const filas = await sql("SELECT datos FROM conv_mensajes WHERE contacto = $1 ORDER BY hora DESC LIMIT $2", [c, limite]);
  const mensajes = filas.map((f) => (typeof f.datos === "string" ? JSON.parse(f.datos) : f.datos)).reverse();
  const cliente = (await sql("SELECT nombre, usuario FROM clientes WHERE id = $1", [c]))[0] ?? {};
  const ultimoCliente = [...mensajes].reverse().find((m) => m.dir === "in")?.hora ?? 0;
  const ultimo = mensajes.at(-1);
  return { ficha: fichaLimpia(c, { nombre: cliente.nombre, usuario: cliente.usuario, ultimo: ultimo?.texto ?? "", ultimoDir: ultimo?.dir ?? "", hora: ultimo?.hora ?? 0, ultimoCliente }, pausa), mensajes };
}

const CLIENTES = "sauko:clientes";
/** Ficha permanente de quien escribe: nombre, @usuario, dirección, primer y último contacto. */
export async function anotarCliente(id, { nombre = "", usuario = "", direccion = "", hora = Date.now(), canal = "WhatsApp" } = {}) {
  const c = String(id ?? "");
  if (!c) return;
  nombre = String(nombre ?? "").slice(0, 60); usuario = String(usuario ?? "").slice(0, 40); direccion = String(direccion ?? "").slice(0, 160);
  try {
    if (hayPostgres) {
      await sql(
        `INSERT INTO clientes (id, canal, nombre, usuario, direccion, primer_contacto, ultimo_contacto) VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))
         ON CONFLICT (id) DO UPDATE SET
           nombre = CASE WHEN EXCLUDED.nombre <> '' THEN EXCLUDED.nombre ELSE clientes.nombre END,
           usuario = CASE WHEN EXCLUDED.usuario <> '' THEN EXCLUDED.usuario ELSE clientes.usuario END,
           direccion = CASE WHEN EXCLUDED.direccion <> '' THEN EXCLUDED.direccion ELSE clientes.direccion END,
           ultimo_contacto = CASE WHEN EXCLUDED.ultimo_contacto > clientes.ultimo_contacto THEN EXCLUDED.ultimo_contacto ELSE clientes.ultimo_contacto END`,
        [c, canal, nombre, usuario, direccion, hora],
      );
      return;
    }
    const antes = hayBase ? JSON.parse((await redis("HGET", CLIENTES, c)) ?? "null") : (memoria.clientes ??= new Map()).get(c) ?? null;
    const ficha = { id: c, canal, nombre: nombre || antes?.nombre || "", usuario: usuario || antes?.usuario || "", direccion: direccion || antes?.direccion || "", primer: antes?.primer ?? hora, ultimo: Math.max(antes?.ultimo ?? 0, hora) };
    if (hayBase) await redis("HSET", CLIENTES, c, JSON.stringify(ficha));
    else memoria.clientes.set(c, ficha);
  } catch (error) {
    console.error("cliente:", error);
  }
}

/** Todos los clientes con sus compras (pedidos no cancelados) y si autorizaron promociones. */
export async function listarClientes() {
  const promos = hayBase ? deParejas((await redis("HGETALL", PROMOS)) ?? []) : Object.fromEntries([...(memoria.promos ?? new Map())].map(([k, v]) => [k, new Date(v).toISOString()]));
  let lista;
  if (hayPostgres) {
    const filas = await sql(`SELECT c.id, c.canal, c.nombre, c.usuario, c.direccion, c.primer_contacto, c.ultimo_contacto, p.pedidos, p.total, p.ultimo
      FROM clientes c LEFT JOIN (SELECT cliente, count(*) AS pedidos, sum(total) AS total, max(creado) AS ultimo FROM pedidos WHERE estado NOT IN ('armando', 'cancelado') GROUP BY cliente) p ON p.cliente = c.id
      ORDER BY c.ultimo_contacto DESC LIMIT 5000`);
    lista = filas.map((f) => ({ id: f.id, canal: f.canal, nombre: f.nombre, usuario: f.usuario, direccion: f.direccion, primer: new Date(f.primer_contacto).getTime(), ultimo: new Date(f.ultimo_contacto).getTime(), pedidos: Number(f.pedidos ?? 0), total: Number(f.total ?? 0), ultimoPedido: f.ultimo ? new Date(f.ultimo).getTime() : 0 }));
  } else {
    const fichas = hayBase ? Object.values(deParejas((await redis("HGETALL", CLIENTES)) ?? [])).map((t) => JSON.parse(t)) : [...(memoria.clientes ?? new Map()).values()];
    const pedidos = (await listarPedidos()).filter((p) => !["armando", "cancelado"].includes(p.status));
    lista = fichas.map((f) => { const suyos = pedidos.filter((p) => p.cliente === f.id); return { ...f, pedidos: suyos.length, total: suyos.reduce((s, p) => s + (p.total || 0), 0), ultimoPedido: Math.max(0, ...suyos.map((p) => p.hora || 0)) }; }).sort((a, b) => b.ultimo - a.ultimo);
  }
  return lista.map((f) => ({ ...f, promos: Boolean(promos[f.id]), promosFecha: promos[f.id] ? new Date(promos[f.id]).getTime() : 0 }));
}

/** El operario abrió el chat: los no leídos vuelven a cero. */
export async function marcarConversacionLeida(contacto) {
  const c = String(contacto ?? "");
  if (!hayBase) return void (enMemoriaConv(c).info.noLeidos = "0");
  await redis("HSET", `sauko:conv-info:${c}`, "noLeidos", "0");
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

// Productos que los clientes pidieron y no están en el catálogo. La tienda los ve en el panel
// para decidir qué traer. Se cuentan por nombre parecido (sin tildes ni mayúsculas).
const SOLICITADOS = "sauko:solicitados";
const MAX_SOLICITADOS = 400;
const claveDe = (nombre) => String(nombre).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

export async function leerSolicitados() {
  if (!hayBase) return Object.values((memoria.solicitados ??= {}));
  const plano = (await redis("HGETALL", SOLICITADOS)) || [];
  const lista = [];
  for (let i = 1; i < plano.length; i += 2) lista.push(JSON.parse(plano[i]));
  return lista;
}

export async function anotarSolicitado(nombre, canal) {
  const clave = claveDe(nombre);
  if (clave.length < 2) return false;
  const texto = hayBase ? await redis("HGET", SOLICITADOS, clave) : null;
  const previo = hayBase ? (texto ? JSON.parse(texto) : null) : (memoria.solicitados ??= {})[clave];
  if (!previo && (hayBase ? await redis("HLEN", SOLICITADOS) : Object.keys(memoria.solicitados).length) >= MAX_SOLICITADOS) return false;
  const registro = { clave, nombre: previo?.nombre ?? String(nombre).trim().slice(0, 80), veces: (previo?.veces ?? 0) + 1, primera: previo?.primera ?? Date.now(), ultima: Date.now(), canal };
  if (hayBase) await redis("HSET", SOLICITADOS, clave, JSON.stringify(registro));
  else memoria.solicitados[clave] = registro;
  return true;
}

export async function quitarSolicitado(clave) {
  if (hayBase) await redis("HDEL", SOLICITADOS, String(clave));
  else delete (memoria.solicitados ??= {})[clave];
}

// Tratamiento de datos: a cada cliente de WhatsApp se le muestra el aviso una sola vez y queda
// la fecha como constancia. Las promociones solo se le envían a quien las autorizó.
const AVISOS_DATOS = "sauko:aviso-datos";
const PROMOS = "sauko:promos";

/** Devuelve true solo la primera vez: es cuando hay que mostrarle el aviso a ese cliente. */
/**
 * ¿Del otro lado contesta otro bot? Un cliente que arma un pedido largo escribe muchos mensajes, pero
 * no 30 en 10 minutos, ni repite el mismo texto largo (un mensaje automático de bienvenida o de
 * ausencia) 3 veces seguidas. Cualquiera de las dos cosas se toma como cadena de bots.
 */
export async function pareceOtroBot(telefono, texto = "") {
  const tel = String(telefono);
  const huella = String(texto).toLowerCase().replace(/\s+/g, " ").trim();
  const largo = huella.length >= 15;
  if (!hayBase) {
    const r = (memoria.respuestas ??= new Map()), ahora = Date.now(), v = r.get(tel);
    const vigente = v && ahora - v.desde < 600000;
    const cuenta = vigente ? v.cuenta + 1 : 1;
    const repetido = largo && vigente && v.huella === huella ? v.repetido + 1 : 1;
    r.set(tel, { desde: vigente ? v.desde : ahora, cuenta, huella, repetido });
    return cuenta > 30 || repetido >= 3;
  }
  const cuenta = Number(await redis("INCR", `sauko:respuestas:${tel}`));
  if (cuenta === 1) await redis("EXPIRE", `sauko:respuestas:${tel}`, 600);
  let repetido = 1;
  if (largo) {
    const [antes, veces] = String((await redis("GET", `sauko:ultimo-texto:${tel}`)) ?? "|0").split(/\|(?=\d+$)/);
    repetido = antes === huella ? Number(veces) + 1 : 1;
    await redis("SET", `sauko:ultimo-texto:${tel}`, `${huella}|${repetido}`, "EX", 600);
  }
  return cuenta > 30 || repetido >= 3;
}

export async function faltaAvisoDeDatos(telefono) {
  if (!hayBase) return !(memoria.avisos ??= new Map()).has(telefono) && Boolean(memoria.avisos.set(telefono, Date.now()));
  return (await redis("HSETNX", AVISOS_DATOS, String(telefono), new Date().toISOString())) === 1;
}

export async function guardarPromos(telefono, acepta) {
  if (!hayBase) return void (acepta ? (memoria.promos ??= new Map()).set(telefono, Date.now()) : (memoria.promos ??= new Map()).delete(telefono));
  if (acepta) await redis("HSET", PROMOS, String(telefono), new Date().toISOString());
  else await redis("HDEL", PROMOS, String(telefono));
}

// Descuentos de la línea del asistente (lib/promo.js): cuántos se dieron hoy (las llaves del día viven
// dos días; el día es el de Cali) y qué clientes ya tuvieron el suyo, que es uno solo para siempre.
const promoDia = (dia) => `sauko:promo-dia:${dia}`;
const PROMO_CLIENTES = "sauko:promo-clientes";
const promoMemoria = (dia) => ((memoria.promoDia ??= new Map()).get(dia) ?? memoria.promoDia.set(dia, { dia: 0, sorpresa: 0 }).get(dia));
export async function leerPromoDia(dia, cliente = "") {
  if (!hayBase) { const d = promoMemoria(dia); return { dia: d.dia, sorpresa: d.sorpresa, usoCliente: Boolean(cliente) && (memoria.promoClientes ??= new Map()).has(String(cliente)) }; }
  const [h, existe] = (await redisVarios([["HGETALL", promoDia(dia)], ["HEXISTS", PROMO_CLIENTES, String(cliente)]])).map((x) => x?.result);
  const v = deParejas(h);
  return { dia: Number(v.dia ?? 0), sorpresa: Number(v.sorpresa ?? 0), usoCliente: Boolean(cliente) && Number(existe) === 1 };
}
/** Marca que el cliente ya tuvo su descuento (queda la fecha). Devuelve false si ya lo había tenido. */
export async function tomarClientePromo(cliente) {
  if (!hayBase) { const m = (memoria.promoClientes ??= new Map()); if (m.has(String(cliente))) return false; m.set(String(cliente), Date.now()); return true; }
  return (await redis("HSETNX", PROMO_CLIENTES, String(cliente), new Date().toISOString())) === 1;
}
export async function soltarClientePromo(cliente) {
  if (!hayBase) return void (memoria.promoClientes ??= new Map()).delete(String(cliente));
  await redis("HDEL", PROMO_CLIENTES, String(cliente));
}
/** Suma (o resta) a un contador del día y devuelve el valor nuevo. Atómico: dos cierres a la vez no se pisan. */
export async function sumarPromoDia(dia, campo, n) {
  if (!hayBase) { const d = promoMemoria(dia); d[campo] = (d[campo] ?? 0) + n; return d[campo]; }
  const valor = Number(await redis("HINCRBY", promoDia(dia), campo, String(n)));
  await redis("EXPIRE", promoDia(dia), 172800);
  return valor;
}

/** Cuántos clientes autorizaron promociones. */
export async function contarPromos() {
  return hayBase ? Number(await redis("HLEN", PROMOS)) : (memoria.promos ??= new Map()).size;
}

// Existencias: unidades que quedan de cada producto que la tienda decidió controlar. Las escribe
// el panel (conteo físico) y se descuentan solas con cada pedido que entra a alistarse.
// Un producto sin dato no se controla: se vende hasta que alguien lo marque agotado.
const EXISTENCIAS = "sauko:existencias";
export const POCAS_UNIDADES = 2;

// Cada producto arranca con el inventario de lib/existencias.js. En la base solo se guarda lo que
// cambió desde entonces: un número (lo que queda) o SIN_CONTROL si la tienda dejó de contarlo.
const SIN_CONTROL = "-";

async function leerCambios() {
  if (!hayBase) return (memoria.existencias ??= {});
  const plano = (await redis("HGETALL", EXISTENCIAS)) || [];
  const mapa = {};
  for (let i = 0; i < plano.length; i += 2) mapa[plano[i]] = plano[i + 1];
  return mapa;
}

/** sku -> unidades que quedan, solo de los productos que se están contando. */
export async function leerExistencias() {
  const mapa = { ...SALDOS_INICIALES };
  const cambios = await leerCambios();
  for (const sku in cambios) {
    if (cambios[sku] === SIN_CONTROL) delete mapa[sku];
    else mapa[sku] = Number(cambios[sku]);
  }
  return mapa;
}

/** @param {number | null} unidades null deja el producto sin control de unidades */
export async function fijarExistencia(sku, unidades) {
  const valor = unidades === null ? SIN_CONTROL : String(unidades);
  if (!hayBase) (memoria.existencias ??= {})[sku] = valor;
  else await redis("HSET", EXISTENCIAS, sku, valor);
}

/** Devuelve al inventario las unidades de un pedido cancelado (solo de los productos que se cuentan). */
export async function reponer(items) {
  const existencias = await leerExistencias();
  for (const it of Array.isArray(items) ? items : []) if (it.sku in existencias) await fijarExistencia(it.sku, existencias[it.sku] + it.qty);
}

async function descontar(items) {
  const existencias = await leerExistencias();
  for (const it of Array.isArray(items) ? items : []) if (it.sku in existencias) await fijarExistencia(it.sku, existencias[it.sku] - it.qty);
}

/** Lo que no se puede vender: lo marcado agotado a mano y lo que se quedó sin unidades. */
export function noDisponibles(agotados, existencias) {
  const mapa = { ...agotados };
  for (const sku in existencias) if (existencias[sku] <= 0) mapa[sku] = true;
  return mapa;
}

// Consumo del asistente: cuánto se ha gastado en la API de Anthropic (estimado a partir de lo que
// informa cada respuesta) y si el servicio está caído por falta de saldo o por la clave.
const CONSUMO = "sauko:consumo";
const fechaCali = (ahora = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(ahora); // AAAA-MM-DD

/** Varios comandos de Redis en un solo viaje. */
async function redisVarios(comandos) {
  const r = await fetch(`${URL_KV}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_KV}`, "Content-Type": "application/json" },
    body: JSON.stringify(comandos),
  });
  if (!r.ok) throw new Error(`Redis respondió ${r.status}`);
  return r.json();
}

/** Suma el costo de una respuesta. esMensaje: la llamada atiende un mensaje nuevo del cliente (no una ronda de herramientas). */
export async function sumarConsumo(usd, esMensaje, modelo = "") {
  const dia = fechaCali();
  const mes = dia.slice(0, 7);
  if (!hayBase) {
    const c = (memoria.consumo ??= {});
    for (const k of ["usd", `usd:${dia}`, `usd:${mes}`]) c[k] = (Number(c[k]) || 0) + usd;
    if (esMensaje) for (const k of ["n", `n:${dia}`, `n:${mes}`]) c[k] = (Number(c[k]) || 0) + 1;
    delete c.caido;
    c.modelo = modelo;
    c.respondio = String(Date.now());
    return;
  }
  const comandos = ["usd", `usd:${dia}`, `usd:${mes}`].map((k) => ["HINCRBYFLOAT", CONSUMO, k, String(usd)]);
  if (esMensaje) for (const k of ["n", `n:${dia}`, `n:${mes}`]) comandos.push(["HINCRBY", CONSUMO, k, "1"]);
  comandos.push(["HDEL", CONSUMO, "caido"]); // si respondió, el servicio está arriba
  comandos.push(["HSET", CONSUMO, "modelo", modelo, "respondio", String(Date.now())]);
  await redisVarios(comandos);
}

/** @param {{motivo: string, hora: string} | null} dato null quita la marca */
export async function marcarAsistenteCaido(dato) {
  if (!hayBase) return void (dato ? ((memoria.consumo ??= {}).caido = JSON.stringify(dato)) : delete (memoria.consumo ??= {}).caido);
  if (dato) await redis("HSET", CONSUMO, "caido", JSON.stringify(dato));
  else await redis("HDEL", CONSUMO, "caido");
}

/**
 * Sin saldo o sin clave el asistente no puede atender: se apaga solo en WhatsApp para no contestarle
 * "no disponible" a cada cliente. Lo vuelve a encender el administrador desde el panel.
 */
export async function apagarPorCaida(motivo) {
  await marcarAsistenteCaido({ motivo, hora: new Date().toISOString() });
  const ajustes = await leerAjustes();
  if (!ajustes.whatsappActivo) return;
  await guardarAjustes({ ...ajustes, whatsappActivo: false, apagadoSolo: true });
  await anotar("asistente apagado automáticamente", motivo);
}

export async function leerConsumo() {
  const dia = fechaCali();
  const mes = dia.slice(0, 7);
  const campos = ["usd", `usd:${dia}`, `usd:${mes}`, `n:${dia}`, `n:${mes}`, "caido", "modelo", "respondio"];
  const v = hayBase ? await redis("HMGET", CONSUMO, ...campos) : campos.map((k) => (memoria.consumo ??= {})[k] ?? null);
  return { total: Number(v[0]) || 0, hoy: Number(v[1]) || 0, mes: Number(v[2]) || 0, mensajesHoy: Number(v[3]) || 0, mensajesMes: Number(v[4]) || 0, caido: v[5] ? JSON.parse(v[5]) : null, modelo: v[6] || "", respondio: Number(v[7]) || 0 };
}

// Opiniones: al entregar un pedido de WhatsApp se le pregunta al cliente cómo le fue, máximo una vez
// cada 15 días. La respuesta y, si algo falló, lo que cuente, quedan para que la tienda los vea.
const OPINIONES = "sauko:opiniones";
const CADA_CUANTO = 15 * 86400;

/** Marca que a este cliente se le acaba de preguntar. Devuelve false si ya se le preguntó hace poco. */
export async function marcarEncuesta(telefono, no) {
  const dato = JSON.stringify({ no, hora: Date.now() });
  if (!hayBase) {
    const previa = (memoria.encuestas ??= new Map()).get(telefono);
    if (previa && Date.now() - JSON.parse(previa).hora < CADA_CUANTO * 1000) return false;
    memoria.encuestas.set(telefono, dato);
    return true;
  }
  return (await redis("SET", `sauko:encuesta:${telefono}`, dato, "NX", "EX", CADA_CUANTO)) === "OK";
}

/** La última pregunta que se le hizo a este cliente: { no, hora } o null. */
export async function leerEncuesta(telefono) {
  const texto = hayBase ? await redis("GET", `sauko:encuesta:${telefono}`) : ((memoria.encuestas ??= new Map()).get(telefono) ?? null);
  return texto ? JSON.parse(texto) : null;
}

/** Guarda o actualiza una opinión. id estable: sirve para agregarle luego el comentario. */
export async function guardarOpinion(opinion) {
  if (!hayBase) (memoria.opiniones ??= {})[opinion.id] = JSON.stringify(opinion);
  else await redis("HSET", OPINIONES, opinion.id, JSON.stringify(opinion));
  return opinion;
}

export async function leerOpinion(id) {
  const texto = hayBase ? await redis("HGET", OPINIONES, id) : ((memoria.opiniones ??= {})[id] ?? null);
  return texto ? JSON.parse(texto) : null;
}

export async function leerOpiniones() {
  if (!hayBase) return Object.values((memoria.opiniones ??= {})).map((t) => JSON.parse(t));
  const plano = (await redis("HGETALL", OPINIONES)) || [];
  const lista = [];
  for (let i = 1; i < plano.length; i += 2) lista.push(JSON.parse(plano[i]));
  return lista;
}

/** Cuando el cliente dice que algo falló, su siguiente mensaje es el comentario de esa opinión (por una hora). */
export async function esperarComentario(telefono, idOpinion) {
  if (!hayBase) (memoria.comentarios ??= new Map()).set(telefono, idOpinion);
  else await redis("SET", `sauko:opinion-pendiente:${telefono}`, idOpinion, "EX", 3600);
}

/** Devuelve la opinión que espera comentario de este cliente y la deja de esperar. */
export async function tomarComentarioPendiente(telefono) {
  if (!hayBase) {
    const id = (memoria.comentarios ??= new Map()).get(telefono) ?? null;
    memoria.comentarios.delete(telefono);
    return id;
  }
  return redis("GETDEL", `sauko:opinion-pendiente:${telefono}`);
}

// Direcciones de entrega que ha usado cada cliente de WhatsApp, para ofrecérselas en el siguiente
// pedido. Se guardan las 3 más recientes durante 6 meses (la política de datos lo informa).
const SEIS_MESES = 180 * 86400;
const igualDireccion = (a, b) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

export async function leerDirecciones(telefono) {
  const texto = hayBase ? await redis("GET", `sauko:direcciones:${telefono}`) : ((memoria.direcciones ??= new Map()).get(telefono) ?? null);
  return texto ? JSON.parse(texto) : [];
}

export async function recordarDireccion(telefono, direccion) {
  const limpia = String(direccion ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!telefono || limpia.length < 4) return;
  const lista = [limpia, ...(await leerDirecciones(telefono)).filter((d) => !igualDireccion(d, limpia))].slice(0, 3);
  if (!hayBase) (memoria.direcciones ??= new Map()).set(telefono, JSON.stringify(lista));
  else await redis("SET", `sauko:direcciones:${telefono}`, JSON.stringify(lista), "EX", SEIS_MESES);
  await anotarCliente(telefono, { direccion: limpia });
}

// Turno del domiciliario: mientras haya escrito en las últimas 24 horas, WhatsApp deja enviarle los
// pedidos como mensajes normales. Y el código que mandó sin foto, a la espera de la foto.
const dig = (t) => String(t ?? "").replace(/\D/g, "");
// clave = el id del domiciliario; destino = por dónde escribió (número, o identificador si usa @usuario).
export async function marcarTurno(clave, destino) {
  if (!hayBase) return void (memoria.turnos ??= new Map()).set(clave, { destino, hora: Date.now() });
  await redis("SET", `sauko:turno:${clave}`, String(destino), "EX", 86400);
}
/** A dónde escribirle si su turno está abierto (escribió en las últimas 24 horas); null si no. */
export async function turnoDe(clave) {
  if (!hayBase) { const t = (memoria.turnos ??= new Map()).get(clave); return t && Date.now() - t.hora < 86400_000 ? t.destino : null; }
  return redis("GET", `sauko:turno:${clave}`);
}
export async function esperarFotoDe(telefono, codigo) {
  if (!hayBase) return void (memoria.codigosDomi ??= new Map()).set(dig(telefono), codigo);
  await redis("SET", `sauko:domi-codigo:${dig(telefono)}`, codigo, "EX", 1800);
}
export async function tomarCodigoEsperado(telefono) {
  if (!hayBase) { const c = (memoria.codigosDomi ??= new Map()).get(dig(telefono)) ?? null; memoria.codigosDomi.delete(dig(telefono)); return c; }
  return redis("GETDEL", `sauko:domi-codigo:${dig(telefono)}`);
}

/**
 * Deja en cero los datos de prueba antes de abrir al público. Los pedidos no se borran de Postgres: se
 * archivan (salen del panel y de los reportes, pero quedan en el historial). Lo demás sí se borra.
 * Usuarios, ajustes, domiciliarios y agotados no se tocan.
 * @param {{pedidos?: boolean, opiniones?: boolean, solicitados?: boolean, inventario?: boolean}} que
 */
export async function reiniciarDatos(que) {
  const hecho = {};
  if (que.pedidos) {
    hecho.pedidos = (await listarPedidos()).length;
    if (hayPostgres) await sql("UPDATE pedidos SET archivado = true, actualizado = now() WHERE NOT archivado");
    if (!hayBase) memoria.pedidos.clear();
    else await redis("DEL", PEDIDOS);
  }
  if (que.opiniones) {
    hecho.opiniones = (await leerOpiniones()).length;
    if (!hayBase) memoria.opiniones = {};
    else await redis("DEL", OPINIONES);
  }
  if (que.solicitados) {
    hecho.solicitados = (await leerSolicitados()).length;
    if (!hayBase) memoria.solicitados = {};
    else await redis("DEL", SOLICITADOS);
  }
  if (que.inventario) {
    // Las unidades vuelven a las de arranque (100 o 10 según la rotación).
    if (!hayBase) memoria.existencias = {};
    else await redis("DEL", EXISTENCIAS);
    hecho.inventario = true;
  }
  return hecho;
}
