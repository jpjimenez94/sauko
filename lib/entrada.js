// Lo común a los dos webhooks de WhatsApp (Meta y YCloud): leer el cuerpo tal como llegó
// y atender un mensaje entrante sin repetirlo.
import { atenderWhatsApp } from "./conversacion.js";
import { enviarTexto, enviarImagen, enviarBotones, esTelefono } from "./whatsapp.js";
import { sitio, cargarNegocio } from "./comun.js";
import { esNuevo, leerAjustes, anotar, enPausa, faltaAvisoDeDatos, guardarPromos, pareceOtroBot, pausar, anotarEnMensaje } from "./store.js";
import { hayClave } from "./agente.js";
import { hayVoz, transcribir } from "./voz.js";
import { atenderOpinion, esOpinion } from "./opiniones.js";
import { atenderDomiciliario } from "./domiciliarios.js";

// WhatsApp marca las notas de voz como "audio"; algunos proveedores usan "voice".
const ES_AUDIO = ["audio", "voice"];

/** El cuerpo sin tocar, para comprobar la firma. */
export async function cuerpoCrudo(req) {
  if (typeof req.rawBody === "string") return req.rawBody; // servidor local
  if (!req.readableEnded) {
    const trozos = [];
    for await (const trozo of req) trozos.push(trozo);
    if (trozos.length) return Buffer.concat(trozos).toString("utf8");
  }
  return JSON.stringify(req.body ?? {});
}

// Modo de prueba: con la lista de prueba (Ajustes del panel, o WHATSAPP_SOLO_NUMEROS) el asistente solo le contesta a quienes estén en la
// lista (separados por coma) y deja pasar el resto, que la tienda sigue atendiendo a mano.
// Cada entrada es un teléfono con indicativo (573001112233) o, para quien no comparte su número,
// su nombre de usuario de WhatsApp (@usuario).
const digitos = (t) => String(t).replace(/\D/g, "");
const sinArroba = (t) => String(t ?? "").trim().replace(/^@/, "").toLowerCase();
function permitido(telefono, usuario, listaDePrueba) {
  // Se toleran comillas y otros separadores, que es fácil dejar al pegar el valor en Vercel.
  const lista = String(listaDePrueba ?? "").split(/[,;\n]/).map((e) => e.replace(/["'`]/g, "").trim()).filter(Boolean);
  if (!lista.length) return true;
  // También vale el identificador de Meta (BSUID, "CO.1234…") de quien usa nombre de usuario.
  return lista.some((entrada) =>
    esTelefono(entrada.replace(/\s/g, "")) ? esTelefono(telefono) && digitos(entrada) === digitos(telefono) : (Boolean(usuario) && sinArroba(entrada) === sinArroba(usuario)) || sinArroba(entrada) === sinArroba(telefono),
  );
}

// Tratamiento de datos (Ley 1581 de 2012): el aviso va una sola vez por cliente, al final de la primera
// respuesta y no como mensaje aparte. Sin enlaces ni invitación a promociones: un mensaje automático con
// enlaces a un dominio nuevo es de lo que el filtro de estafas de WhatsApp marca. SI PROMOS sigue
// funcionando si el cliente lo escribe.
const AVISO_DE_DATOS = "Tus datos (número, dirección y pedido) solo los usamos para llevarte el domicilio. La política de datos está en nuestra página web.";
const QUIERE_PROMOS = /^\s*s[ií]\s+promos?\W*$/i;
const NO_QUIERE_PROMOS = /^\s*no\s+(m[aá]s\s+)?promos?\W*$/i;

/** Para el domiciliario, el control de repetidos va antes (su flujo no pasa por el del cliente). */
async function esNuevoDomi(id, telefono, usuario) {
  const { domiciliarioDe } = await import("./domiciliarios.js");
  return (await domiciliarioDe(telefono, usuario)) ? esNuevo(id) : true;
}

/** Envía la respuesta del asistente y, si acaba de pedir una transferencia, el código QR de pago. */
async function contestar(telefono, { texto, enviarQr, botones = [] }) {
  let enviado = false;
  if (botones.length) {
    // El texto con botones admite hasta 1.024 caracteres: si es más largo va aparte y los botones después.
    if (texto.length > 1024) enviado = (await enviarTexto(telefono, texto)) && ((await enviarBotones(telefono, "Elegí una opción, veci:", botones)) || true);
    else enviado = await enviarBotones(telefono, texto, botones);
  }
  // Sin botones, o si WhatsApp no los aceptó: el mismo mensaje como texto, con las opciones escritas.
  if (!enviado) enviado = await enviarTexto(telefono, botones.length ? `${texto}\n\n${botones.map((b) => "- " + [b.titulo, b.detalle].filter(Boolean).join(": ")).join("\n")}` : texto);
  if (enviado && enviarQr && !(await enviarImagen(telefono, `${sitio()}/qr-pago.jpg`, "Código QR para pagar desde la app de tu banco"))) await anotar("no se pudo enviar el QR de pago", "termina en " + String(telefono).slice(-4));
  return enviado;
}

/**
 * @param {{id: string, telefono: string, usuario?: string, tipo: string, texto?: string, bajar?: () => Promise<{mediaType: string, base64: string} | null>, bajarAudio?: () => Promise<{mediaType: string, bytes: Buffer} | null>}} mensaje
 */
export async function atenderEntrante({ id, telefono, usuario = "", tipo, texto = "", bajar, bajarAudio }) {
  try {
    const cola = String(telefono ?? "").slice(-4);
    // En el diagnóstico: los últimos dígitos si es un teléfono; si es el identificador de quien usa nombre de usuario, su @usuario.
    const quien = esTelefono(telefono) ? "termina en " + cola : usuario ? "@" + sinArroba(usuario) : "id …" + cola;
    if (!id || !telefono) return void (await anotar("mensaje sin datos", tipo));
    if (!(await esNuevoDomi(id, telefono, usuario))) return void (await anotar("mensaje repetido", quien));
    // El domiciliario: sus mensajes (inicio de turno, código y foto de la entrega) los atiende el sistema,
    // aunque el asistente esté apagado o el número no esté en la lista de prueba.
    if (await atenderDomiciliario({ telefono, usuario, tipo, texto, bajar })) return void (await anotar("mensaje del domiciliario", tipo));
    if (!permitido(telefono, usuario, (await cargarNegocio()).listaDePrueba)) return void (await anotar("fuera de la lista de prueba", esTelefono(telefono) ? "termina en " + cola : (usuario ? "usuario @" + sinArroba(usuario) + ", " : "") + "id " + telefono + " (se puede poner en la lista de prueba)"));
    // La respuesta a "¿cómo te fue con el pedido?" se guarda aunque el asistente esté apagado o en pausa.
    if (tipo === "text" && (await esOpinion(telefono, texto))) {
      if (await esNuevo(id)) await atenderOpinion(telefono, texto);
      return;
    }
    // Apagado desde el panel: los mensajes siguen llegando al celular de la tienda y el asistente no contesta.
    if (!(await leerAjustes()).whatsappActivo) return void (await anotar("asistente apagado", quien));
    if (await enPausa(telefono)) return void (await anotar("en pausa: la tienda está atendiendo a mano", quien));
    if (!(await esNuevo(id))) return void (await anotar("mensaje repetido", quien));
    await anotar("mensaje recibido", `${tipo}, ${quien}`);
    if (!hayClave()) return void (await enviarTexto(telefono, "En este momento el asistente no está disponible. Escríbenos de nuevo en un rato."));
    if (tipo === "text" && (QUIERE_PROMOS.test(texto) || NO_QUIERE_PROMOS.test(texto))) {
      const acepta = QUIERE_PROMOS.test(texto);
      await guardarPromos(telefono, acepta);
      await anotar(acepta ? "autorizó promociones" : "retiró la autorización de promociones", quien);
      return void (await enviarTexto(telefono, acepta ? "Listo, veci. Te avisamos de las promociones por acá. Si después no querés más, respondé NO PROMOS." : "Listo, veci. No te enviamos promociones."));
    }
    // Si del otro lado contesta otro bot, no se arma una cadena de mensajes automáticos (WhatsApp lo
    // trata como spam): un último aviso y el asistente se aparta 30 minutos de ese chat.
    if (await pareceOtroBot(telefono, texto)) {
      await pausar(telefono, 1800);
      await anotar("parece otro bot: el asistente se aparta 30 minutos de ese chat", quien);
      return void (await enviarTexto(telefono, "Veci, en un momento te atiende alguien de la tienda por aquí."));
    }
    const conAviso = async (respuesta) => {
      if (!(await faltaAvisoDeDatos(telefono))) return respuesta;
      await anotar("aviso de datos enviado", quien);
      return { ...respuesta, texto: `${respuesta.texto}\n\n${AVISO_DE_DATOS}` };
    };
    if (tipo === "text") {
      const enviado = await contestar(telefono, await conAviso(await atenderWhatsApp(telefono, texto)));
      return void (await anotar(enviado ? "respondido" : "respuesta lista pero no se envió", quien));
    }
    if (tipo === "image") {
      const imagen = await bajar?.();
      if (!imagen) {
        await anotar("no se pudo bajar la foto", quien);
        return void (await enviarTexto(telefono, "No pude abrir esa foto, veci. ¿Me la mandás otra vez?"));
      }
      const enviado = await contestar(telefono, await conAviso(await atenderWhatsApp(telefono, texto, imagen)));
      return void (await anotar(enviado ? "foto leída y respondida" : "respuesta lista pero no se envió", quien));
    }
    if (ES_AUDIO.includes(tipo) && hayVoz()) {
      const audio = await bajarAudio?.();
      if (!audio) {
        await anotar("no se pudo bajar el audio", quien);
        return void (await enviarTexto(telefono, "No pude abrir ese audio, veci. ¿Me lo mandás otra vez o me escribís?"));
      }
      const dicho = await transcribir(audio);
      // La transcripción también se ve debajo de la nota de voz en las Conversaciones del panel.
      if (dicho) await anotarEnMensaje(telefono, id, { transcripcion: dicho.slice(0, 2000) }).catch(() => {});
      if (!dicho) {
        await anotar("audio sin palabras reconocibles", quien);
        return void (await enviarTexto(telefono, "No te alcancé a entender el audio, veci. ¿Me lo repetís o me lo escribís?"));
      }
      // El asistente sabe que es una transcripción y que puede traer errores de oído.
      const enviado = await contestar(telefono, await conAviso(await atenderWhatsApp(telefono, `[Nota de voz transcrita automáticamente; puede tener errores] ${dicho}`)));
      return void (await anotar(enviado ? "audio transcrito y respondido" : "respuesta lista pero no se envió", `${dicho.length} caracteres, ${quien}`));
    }
    await anotar("tipo de mensaje no atendido", `${tipo}, ${quien}`);
    await enviarTexto(telefono, ES_AUDIO.includes(tipo) ? "Veci, por acá todavía no puedo escuchar audios. Escribime qué necesitás y te lo armo." : "Por acá solo leo texto, fotos y audios, veci. Escribime qué necesitás y te lo armo.");
  } catch (error) {
    console.error("whatsapp:", error);
    await anotar("error al atender", error?.message ?? error);
    // Sin saldo o sin clave el asistente no puede atender: el chat queda en manos de la tienda, que lo ve en su celular.
    const disculpa = error?.sinServicio ? "Veci, en este momento el asistente no está disponible. Ya te atiende alguien de la tienda por este mismo chat." : "Se nos enredó algo por acá. Escribime de nuevo en un momento, porfa.";
    await enviarTexto(telefono, disculpa).catch(() => {});
  }
}
