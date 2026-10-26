// Conversaciones de WhatsApp en el panel: lo que entra por el webhook de Meta se guarda aquí y el
// operario lo ve como un WhatsApp (fotos, notas de voz, botones, estados de entrega) y puede
// responder a mano. Vive dentro de /api/whatsapp porque Vercel Hobby no deja más funciones.
import { exigirSesion } from "./usuarios.js";
import { atenderEntrante } from "./entrada.js";
import { cargarNegocio } from "./comun.js";
import { domiciliarioDe } from "./domiciliarios.js";
import { registrarMensaje, marcarEstadoMensaje, anotarEnMensaje, listarConversaciones, leerConversacion, marcarConversacionLeida, pausar, despausar, anotar, anotarEnvio, leerEnvio, listarClientes, leerAjustes, guardarAjustes, buscarEnConversaciones } from "./store.js";
import { enviarTexto, enviarImagenSubida, enviarReaccion, avisarLeido, subirMedio, bajarMedio, textoDeBoton, leerPerfil, guardarPerfil, subirFotoPerfil } from "./whatsapp.js";

export const VENTANA = 24 * 3600 * 1000; // WhatsApp solo deja escribir libre 24 h después del último mensaje del cliente
const TIPOS_FOTO = ["image/jpeg", "image/png", "image/webp"];
const MEDIOS = ["image", "audio", "video", "document", "sticker"];
// Categorías que acepta Meta para el perfil.
export const VERTICALES = ["GROCERY", "RETAIL", "RESTAURANT", "OTHER"];

// El asistente cambió de número (313 → 301): cada mensaje del cliente queda con la línea por la que llegó.
// WhatsApp cuenta las 24 horas por número, así que a un chat de la línea anterior no se le puede escribir
// desde la actual hasta que el cliente le escriba a esta.
const lineaActual = () => process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const deEstaLinea = (ficha) => !lineaActual() || ficha.linea === lineaActual();

/** Lo que llega en un aviso de Meta, como mensaje del chat. Las reacciones no son mensaje: se anotan en el mensaje al que reaccionan. */
export async function guardarEntrante(remitente, m, contacto, linea = {}) {
  if (!remitente || !m?.id) return;
  if (m.type === "reaction") return anotarEnMensaje(remitente, m.reaction?.message_id, { reaccionCliente: m.reaction?.emoji ?? "" });
  const medio = MEDIOS.includes(m.type) ? m[m.type] : null;
  const ubicacion = m.type === "location" ? { lat: Number(m.location?.latitude), lng: Number(m.location?.longitude), nombre: String(m.location?.name ?? m.location?.address ?? "").slice(0, 120) } : null;
  await registrarMensaje(remitente, {
    id: m.id,
    dir: "in",
    de: "cliente",
    tipo: textoDeBoton(m) ? "boton" : m.type,
    texto: String(textoDeBoton(m) || m.text?.body || medio?.caption || "").slice(0, 4000),
    ...(medio?.id ? { medio: { id: String(medio.id), tipo: String(medio.mime_type ?? "").split(";")[0], nombre: String(medio.filename ?? "").slice(0, 80), voz: Boolean(medio.voice) } } : {}),
    ...(ubicacion && Number.isFinite(ubicacion.lat) ? { ubicacion } : {}),
    ...(m.context?.id ? { contexto: m.context.id } : {}),
    hora: Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.now(),
    linea: String(linea.phone_number_id || lineaActual()),
    ...(linea.display_phone_number ? { numero: String(linea.display_phone_number) } : {}),
    nombre: contacto?.profile?.name,
    usuario: contacto?.profile?.username ?? contacto?.username,
  });
}

/** Estados de entrega de lo enviado: enviado, entregado, leído o falló (con el motivo). */
export async function guardarEstados(estados) {
  for (const s of estados ?? []) {
    const destino = s.recipient_id || s.recipient_user_id;
    const motivo = s.errors?.[0] ? `${s.errors[0].code ?? ""} ${s.errors[0].title ?? s.errors[0].message ?? ""}`.trim() : "";
    if (s.status === "failed") await anotarEnvio(false, motivo, destino).catch(() => {});
    else if (s.status === "delivered" || s.status === "read") await anotarEnvio(true).catch(() => {});
    await marcarEstadoMensaje(destino, s.id, s.status, motivo).catch(() => {});
  }
}

// Errores de Meta que son de la cuenta (le pasan a todos los clientes) y los que son de un solo cliente.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const DE_LA_CUENTA = {
  131042: "Meta no deja salir mensajes por un problema de pago de la cuenta de WhatsApp. Un administrador debe agregar o revisar la tarjeta en el Administrador de WhatsApp → Configuración de pagos.",
  131031: "Meta bloqueó la cuenta de WhatsApp. Revisen el Administrador de WhatsApp y el correo de Meta.",
  131048: "Meta está frenando los envíos porque muchos clientes marcaron los mensajes como spam o los bloquearon.",
  130429: "Meta está frenando los envíos porque se mandaron demasiados mensajes seguidos.",
  133010: "El número del asistente no está registrado en WhatsApp.",
  131045: "El número del asistente perdió su registro en WhatsApp.",
  190: "El permiso (token) de WhatsApp venció o lo quitaron: hay que poner uno nuevo en Vercel.",
  368: "Meta bloqueó temporalmente la cuenta por incumplir sus políticas.",
};
const DE_UN_CLIENTE = new Set([131026, 131047, 131051, 131049, 130472, 131056, 131052, 131053, 131021, 131050]);

/** Si los clientes no están recibiendo los mensajes, qué decirle a la tienda; null si todo va bien. */
export function envioCaido(e) {
  if (!e?.falloHora || (e.okHora && e.okHora > e.falloHora) || Date.now() - e.falloHora > 6 * 3600_000) return null;
  const codigo = Number(String(e.falloMotivo).match(/\d+/)?.[0]);
  const deLaCuenta = DE_LA_CUENTA[codigo];
  if (!deLaCuenta && (DE_UN_CLIENTE.has(codigo) || e.falloN < 3 || e.falloClientes < 2)) return null;
  return { desde: e.falloDesde || e.falloHora, mensajes: e.falloN, clientes: e.falloClientes, motivo: e.falloMotivo, explicacion: deLaCuenta || "Meta está rechazando los mensajes (" + e.falloMotivo + "). Revisen el Administrador de WhatsApp." };
}

/**
 * Lo que no le llegó a un cliente por una falla de WhatsApp de la cuenta (pago, token, bloqueo) y nadie ha
 * vuelto a intentar: los mensajes que fallaron después de lo último que sí le llegó. Los que fallan por algo
 * del cliente (lo bloqueó, número sin WhatsApp) no cuentan: reintentar no sirve.
 */
export function sinEntregar(mensajes) {
  const salieron = (mensajes ?? []).filter((m) => m.dir === "out");
  const ultimoBueno = Math.max(0, ...salieron.filter((m) => /^(delivered|read)/.test(String(m.estado ?? ""))).map((m) => m.hora || 0));
  return salieron.filter((m) => {
    const [estado, motivo = ""] = String(m.estado ?? "").split("|");
    return estado === "failed" && !m.reintentado && (m.hora || 0) > ultimoBueno && !DE_UN_CLIENTE.has(Number(motivo.match(/\d+/)?.[0]));
  });
}

// Avisos de Meta sobre la cuenta (calidad del número, infracciones, revisiones, límites). Todos quedan en el
// Diagnóstico; los graves, además, en rojo arriba en el panel, para reaccionar antes de que bloqueen la cuenta.
const GRAVE = /DISABLE|RESTRICT|BAN|FLAG|VIOLATION|RED\b|YELLOW|REJECT|SUSPEND|LOCK|DOWNGRADE|WARNING|ERROR|CRITICAL|HIGH/i;
const TRADUCCION = { account_update: "cuenta", account_alerts: "alerta de la cuenta", phone_number_quality_update: "calidad del número", account_review_update: "revisión de la cuenta", business_capability_update: "límites de envío", phone_number_name_update: "nombre visible" };
export async function guardarAvisosDeCuenta(cambios) {
  for (const c of cambios ?? []) {
    const v = c.value ?? {};
    const partes = [v.event, v.decision, v.current_limit, v.ban_info?.waba_ban_state, v.violation_info?.violation_type, v.alert_type, v.alert_severity, v.alert_status, v.alert_description, v.requested_verified_name && "nombre: " + v.requested_verified_name, v.rejection_reason].filter(Boolean);
    const resumen = (partes.length ? partes.join(" · ") : JSON.stringify(v)).slice(0, 300);
    const tema = TRADUCCION[c.field] ?? c.field;
    await anotar(`Meta avisó: ${tema}`, resumen).catch(() => {});
    const texto = JSON.stringify(v);
    // Buenas noticias (se quitó la marca, subió el límite, aprobado) no son alarma.
    if (/UNFLAG|UPGRADE|APPROVED|ONBOARDED|VERIFIED/i.test(texto) || !GRAVE.test(texto)) continue;
    const ajustes = await leerAjustes();
    await guardarAjustes({ ...ajustes, alertasMeta: [{ tema, resumen, hora: Date.now() }, ...(ajustes.alertasMeta ?? [])].slice(0, 10) });
  }
}

const textoParaAsistente = (m) => m.texto || m.transcripcion || ({ image: "[mandó una foto]", audio: "[mandó una nota de voz]", video: "[mandó un video]", document: "[mandó un documento]", sticker: "[mandó un sticker]", location: "[mandó una ubicación]" })[m.tipo] || "[mensaje]";
const dentroDeVentana = (ficha) => deEstaLinea(ficha) && Boolean(ficha.ultimoCliente) && Date.now() - ficha.ultimoCliente < VENTANA;
const ultimoDelCliente = (mensajes) => [...mensajes].reverse().find((m) => m.dir === "in")?.id;

/** Acciones del panel: /api/whatsapp?accion=… (con sesión). */
export async function atenderPanel(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const yo = await exigirSesion(req, res);
  if (!yo) return;
  const accion = String(req.query.accion);
  const c = String(req.query.c ?? req.body?.c ?? "").slice(0, 140);
  try {
    if (req.method === "GET" && accion === "chats") {
      const chats = await listarConversaciones(150);
      const envio = envioCaido(await leerEnvio().catch(() => null));
      return res.status(200).json({ chats, ventana: VENTANA, linea: lineaActual(), ...(envio ? { envio } : {}) });
    }
    // Clientes a los que no les llegaron las respuestas (falla de WhatsApp) y todavía se les puede escribir.
    // Lee cada chat de las últimas 24 h: se pide al abrir Conversaciones, no en cada refresco.
    if (req.method === "GET" && accion === "sin-entregar") {
      const pendientes = [];
      for (const f of (await listarConversaciones(150)).filter(dentroDeVentana)) {
        const fallos = sinEntregar((await leerConversacion(f.id, 60)).mensajes);
        if (!fallos.length || (await domiciliarioDe(f.id, f.usuario))) continue;
        pendientes.push({ id: f.id, nombre: f.nombre || (f.usuario ? "@" + f.usuario : ""), mensajes: fallos.length, desde: fallos[0].hora });
      }
      return res.status(200).json({ pendientes });
    }
    if (req.method === "GET" && accion === "chat") {
      if (!c) return res.status(400).json({ error: "Falta el chat" });
      return res.status(200).json({ ...(await leerConversacion(c)), ventana: VENTANA, linea: lineaActual() });
    }
    // Buscar dentro de los mensajes de todas las conversaciones (solo lectura).
    if (req.method === "GET" && accion === "buscar") {
      try {
        return res.status(200).json({ resultados: await buscarEnConversaciones(req.query.q) });
      } catch (error) {
        // El motivo ayuda a diagnosticar (es de la base de datos, sin datos de clientes).
        console.error("buscar:", error);
        return res.status(500).json({ error: "No se pudo buscar: " + String(error.message).slice(0, 200) });
      }
    }
    if (req.method === "GET" && accion === "clientes") return res.status(200).json({ clientes: await listarClientes() });
    if (req.method === "GET" && accion === "medio") {
      const id = String(req.query.id ?? "");
      if (!/^\d{5,30}$/.test(id)) return res.status(400).json({ error: "Archivo inválido" });
      const archivo = await bajarMedio(id);
      if (!archivo) return res.status(404).json({ error: "El archivo ya no está disponible en WhatsApp (dura 30 días) o pesa más de 4 MB." });
      res.setHeader("Content-Type", archivo.mediaType || "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=86400");
      return res.status(200).send(archivo.bytes);
    }
    // Perfil del número del asistente (lo que ven los clientes): solo el administrador.
    if (accion === "perfil" || accion === "perfil-foto") {
      if (yo.rol !== "admin") return res.status(403).json({ error: "Solo el administrador cambia el perfil de WhatsApp." });
      if (req.method === "GET") return res.status(200).json({ perfil: await leerPerfil() });
      if (accion === "perfil-foto") {
        const tipo = String(req.body?.tipo ?? "");
        const bytes = Buffer.from(String(req.body?.base64 ?? ""), "base64");
        if (!["image/jpeg", "image/png"].includes(tipo) || bytes.length < 1000) return res.status(400).json({ error: "La foto debe ser JPG o PNG." });
        if (bytes.length > 3_000_000) return res.status(413).json({ error: "La foto pesa demasiado (máximo 3 MB)." });
        await guardarPerfil({ profile_picture_handle: await subirFotoPerfil(bytes, tipo) });
        await anotar(`${yo.nombre || yo.usuario} cambió la foto del perfil de WhatsApp`, "");
        return res.status(200).json({ perfil: await leerPerfil() });
      }
      const b = req.body ?? {};
      const texto = (v, max) => String(v ?? "").trim().slice(0, max);
      const sitios = (Array.isArray(b.websites) ? b.websites : []).map((s) => texto(s, 256)).filter((s) => /^https?:\/\/\S+\.\S+/.test(s)).slice(0, 2);
      const campos = { about: texto(b.about, 139) || " ", description: texto(b.description, 512), address: texto(b.address, 256), email: texto(b.email, 128), websites: sitios, vertical: VERTICALES.includes(b.vertical) ? b.vertical : "OTHER" };
      if (campos.email && !/^\S+@\S+\.\S+$/.test(campos.email)) return res.status(400).json({ error: "El correo no es válido." });
      await guardarPerfil(campos);
      await anotar(`${yo.nombre || yo.usuario} actualizó el perfil de WhatsApp`, "");
      return res.status(200).json({ perfil: await leerPerfil() });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
    if (!c) return res.status(400).json({ error: "Falta el chat" });
    const { ficha, mensajes } = await leerConversacion(c, 60);
    const minutos = (await cargarNegocio()).pausaMinutos || 30;

    if (accion === "leer") {
      await marcarConversacionLeida(c);
      if (dentroDeVentana(ficha)) await avisarLeido(ultimoDelCliente(mensajes)).catch(() => {});
      return res.status(200).json({ ok: true });
    }
    if (accion === "escribiendo") {
      if (dentroDeVentana(ficha)) await avisarLeido(ultimoDelCliente(mensajes), true).catch(() => {});
      return res.status(200).json({ ok: true });
    }
    if (accion === "tomar") {
      const horas = Math.min(12, Math.max(0.25, Number(req.body?.horas) || 2));
      await pausar(c, Math.round(horas * 3600));
      await anotar(`${yo.nombre || yo.usuario} tomó el chat: el asistente no contesta por ${horas} h`, String(c).slice(-4));
      return res.status(200).json({ ok: true });
    }
    if (accion === "soltar") {
      await despausar(c);
      await anotar(`${yo.nombre || yo.usuario} devolvió el chat al asistente`, String(c).slice(-4));
      // Si lo último es del cliente y nadie le respondió, el asistente retoma ya, sabiendo lo que se habló
      // mientras atendía la tienda (esos mensajes no los vio).
      const ultimo = mensajes.at(-1);
      if (ultimo?.dir === "in" && dentroDeVentana(ficha)) {
        const desde = mensajes.map((m) => m.de).lastIndexOf("asistente");
        const mientras = mensajes.slice(desde + 1).map((m) => `${m.dir === "in" ? "Cliente" : "Tienda"}: ${textoParaAsistente(m)}`).join("\n");
        const texto = `[La tienda atendió este chat a mano y ahora te lo devuelve. Lo que se habló mientras tanto:
${mientras}
Responde lo que el cliente dejó pendiente, sin repetir lo que la tienda ya le dijo.]`;
        await atenderEntrante({ id: "retomar-" + ultimo.id, telefono: c, usuario: ficha.usuario, tipo: "text", texto });
        return res.status(200).json({ ok: true, retomo: true });
      }
      return res.status(200).json({ ok: true });
    }
    // Las respuestas no le llegaron (falla de WhatsApp): el asistente le vuelve a responder, sabiendo qué no le
    // llegó, con una disculpa corta por la demora. Lo pide alguien de la tienda desde el panel.
    if (accion === "reintentar") {
      if (!deEstaLinea(ficha) || !dentroDeVentana(ficha)) return res.status(409).json({ error: "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no deja escribirle hasta que vuelva a escribir." });
      const fallos = sinEntregar(mensajes);
      if (!fallos.length) return res.status(409).json({ error: "A este cliente no le quedó nada sin entregar." });
      if (await domiciliarioDe(c, ficha.usuario)) return res.status(409).json({ error: "Es un domiciliario: escríbele a mano." });
      if (!(await leerAjustes()).whatsappActivo) return res.status(409).json({ error: "El asistente está apagado: escríbele a mano." });
      // Se marcan antes, para que dos toques seguidos no le manden dos respuestas.
      for (const m of fallos) await anotarEnMensaje(c, m.id, { reintentado: Date.now() });
      await despausar(c);
      const cliente = mensajes.filter((m) => m.dir === "in").slice(-4).map((m) => `- ${textoParaAsistente(m).slice(0, 300)}`).join("\n");
      const noLlego = fallos.slice(-6).map((m) => `- ${m.de === "tienda" ? "La tienda" : "Tú"}: ${textoParaAsistente(m).slice(0, 300)}`).join("\n");
      const texto = `[Falla de WhatsApp: estas respuestas NO le llegaron al cliente (WhatsApp las rechazó y él no las vio):
${noLlego}
Lo último que escribió el cliente:
${cliente}
Empieza con una disculpa corta por la demora ("Veci, disculpá la demora, tuvimos una falla con WhatsApp") y respóndele de nuevo lo que quedó pendiente, con lo que siga vigente ahora (revisa el estado del pedido). Si lo que no le llegó era solo un aviso que ya no aplica, discúlpate y pregúntale si necesita algo más.]`;
      await anotar(`${yo.nombre || yo.usuario} pidió al asistente responder de nuevo (no le habían llegado ${fallos.length} mensajes)`, String(c).slice(-4));
      await atenderEntrante({ id: "reintento-" + fallos.at(-1).id, telefono: c, usuario: ficha.usuario, tipo: "text", texto });
      return res.status(200).json({ ok: true });
    }
    if (accion === "reaccion") {
      const wamid = String(req.body?.id ?? "");
      const emoji = String(req.body?.emoji ?? "").slice(0, 8);
      if (!wamid) return res.status(400).json({ error: "Falta el mensaje" });
      if (!(await enviarReaccion(c, wamid, emoji))) return res.status(502).json({ error: "WhatsApp no aceptó la reacción." });
      await anotarEnMensaje(c, wamid, { reaccionTienda: emoji });
      return res.status(200).json({ ok: true });
    }
    if (accion === "enviar" || accion === "imagen") {
      if (!deEstaLinea(ficha)) return res.status(409).json({ error: "Este chat es de la línea anterior del asistente. El cliente todavía no le ha escrito a la línea nueva, así que WhatsApp no deja escribirle desde aquí; cuando escriba, ya podrás contestarle." });
      if (!dentroDeVentana(ficha)) return res.status(409).json({ error: "Pasaron más de 24 horas desde el último mensaje del cliente. WhatsApp solo deja escribirle de nuevo con una plantilla aprobada; espera a que el cliente escriba." });
      const opciones = { de: "tienda", por: yo.nombre || yo.usuario, contexto: String(req.body?.contexto ?? "") || undefined };
      let enviado;
      if (accion === "enviar") {
        const texto = String(req.body?.texto ?? "").trim().slice(0, 4000);
        if (!texto) return res.status(400).json({ error: "Escribe un mensaje" });
        enviado = await enviarTexto(c, texto, opciones);
      } else {
        const tipo = String(req.body?.tipo ?? "");
        const base64 = String(req.body?.base64 ?? "");
        if (!TIPOS_FOTO.includes(tipo) || !base64) return res.status(400).json({ error: "La foto debe ser JPG, PNG o WEBP" });
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length > 3_000_000) return res.status(413).json({ error: "La foto pesa demasiado (máximo 3 MB)" });
        const idMedio = await subirMedio(bytes, tipo);
        if (!idMedio) return res.status(502).json({ error: "WhatsApp no aceptó la foto." });
        enviado = await enviarImagenSubida(c, idMedio, String(req.body?.pie ?? "").slice(0, 1000), opciones);
      }
      if (!enviado) return res.status(502).json({ error: "WhatsApp no aceptó el mensaje. Revisa el Diagnóstico en Ajustes." });
      // Mientras la tienda atiende ese chat, el asistente se calla un rato (como al responder desde la app).
      await pausar(c, minutos * 60);
      return res.status(200).json({ ok: true, id: enviado });
    }
    return res.status(400).json({ error: "Acción desconocida" });
  } catch (error) {
    console.error("conversaciones:", error);
    // En el perfil, el motivo que da Meta (permiso del token, campo inválido) es lo que sirve para arreglarlo.
    if (String(req.query.accion).startsWith("perfil")) return res.status(502).json({ error: String(error?.message ?? error).slice(0, 700) });
    return res.status(500).json({ error: "No se pudo completar. Intenta de nuevo." });
  }
}
