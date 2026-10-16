// Conversaciones de WhatsApp en el panel: lo que entra por el webhook de Meta se guarda aquí y el
// operario lo ve como un WhatsApp (fotos, notas de voz, botones, estados de entrega) y puede
// responder a mano. Vive dentro de /api/whatsapp porque Vercel Hobby no deja más funciones.
import { exigirSesion } from "./usuarios.js";
import { cargarNegocio } from "./comun.js";
import { registrarMensaje, marcarEstadoMensaje, anotarEnMensaje, listarConversaciones, leerConversacion, marcarConversacionLeida, pausar, despausar, anotar } from "./store.js";
import { enviarTexto, enviarImagenSubida, enviarReaccion, avisarLeido, subirMedio, bajarMedio, textoDeBoton, leerPerfil, guardarPerfil, subirFotoPerfil } from "./whatsapp.js";

export const VENTANA = 24 * 3600 * 1000; // WhatsApp solo deja escribir libre 24 h después del último mensaje del cliente
const TIPOS_FOTO = ["image/jpeg", "image/png", "image/webp"];
const MEDIOS = ["image", "audio", "video", "document", "sticker"];
// Categorías que acepta Meta para el perfil.
export const VERTICALES = ["GROCERY", "RETAIL", "RESTAURANT", "OTHER"];

/** Lo que llega en un aviso de Meta, como mensaje del chat. Las reacciones no son mensaje: se anotan en el mensaje al que reaccionan. */
export async function guardarEntrante(remitente, m, contacto) {
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
    nombre: contacto?.profile?.name,
    usuario: contacto?.profile?.username ?? contacto?.username,
  });
}

/** Estados de entrega de lo enviado: enviado, entregado, leído o falló (con el motivo). */
export async function guardarEstados(estados) {
  for (const s of estados ?? []) {
    const destino = s.recipient_id || s.recipient_user_id;
    const motivo = s.errors?.[0] ? `${s.errors[0].code ?? ""} ${s.errors[0].title ?? s.errors[0].message ?? ""}`.trim() : "";
    await marcarEstadoMensaje(destino, s.id, s.status, motivo).catch(() => {});
  }
}

const dentroDeVentana = (ficha) => Boolean(ficha.ultimoCliente) && Date.now() - ficha.ultimoCliente < VENTANA;
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
      return res.status(200).json({ chats, ventana: VENTANA });
    }
    if (req.method === "GET" && accion === "chat") {
      if (!c) return res.status(400).json({ error: "Falta el chat" });
      return res.status(200).json({ ...(await leerConversacion(c)), ventana: VENTANA });
    }
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
    return res.status(500).json({ error: "No se pudo completar. Intenta de nuevo." });
  }
}
