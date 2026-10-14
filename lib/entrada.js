// Lo común a los dos webhooks de WhatsApp (Meta y YCloud): leer el cuerpo tal como llegó
// y atender un mensaje entrante sin repetirlo.
import { atenderWhatsApp } from "./conversacion.js";
import { enviarTexto, enviarImagen, enviarBotones, esTelefono } from "./whatsapp.js";
import { sitio, cargarNegocio } from "./comun.js";
import { esNuevo, leerAjustes, anotar, enPausa, faltaAvisoDeDatos, guardarPromos } from "./store.js";
import { hayClave } from "./agente.js";
import { hayVoz, transcribir } from "./voz.js";

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
  return lista.some((entrada) =>
    esTelefono(entrada.replace(/\s/g, "")) ? esTelefono(telefono) && digitos(entrada) === digitos(telefono) : Boolean(usuario) && sinArroba(entrada) === sinArroba(usuario),
  );
}

// Tratamiento de datos (Ley 1581 de 2012): el aviso se le muestra a cada cliente una sola vez, antes
// de la primera respuesta. Las promociones son aparte y solo con un sí expreso.
const avisoDeDatos = () =>
  `Hola, veci. Para llevarte el pedido usamos tu número, tu dirección y lo que pidas. Acá está nuestra política de datos: ${sitio()}/privacidad.html\n\nSi querés que te avisemos de promociones por este chat, respondé SI PROMOS.`;
const QUIERE_PROMOS = /^\s*s[ií]\s+promos?\W*$/i;
const NO_QUIERE_PROMOS = /^\s*no\s+(m[aá]s\s+)?promos?\W*$/i;

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
    if (!id || !telefono) return void (await anotar("mensaje sin datos", tipo));
    if (!permitido(telefono, usuario, (await cargarNegocio()).listaDePrueba)) return void (await anotar("fuera de la lista de prueba", esTelefono(telefono) ? "termina en " + cola : "usuario @" + sinArroba(usuario)));
    // Apagado desde el panel: los mensajes siguen llegando al celular de la tienda y el asistente no contesta.
    if (!(await leerAjustes()).whatsappActivo) return void (await anotar("asistente apagado", "termina en " + cola));
    if (await enPausa(telefono)) return void (await anotar("en pausa: la tienda está atendiendo a mano", "termina en " + cola));
    if (!(await esNuevo(id))) return void (await anotar("mensaje repetido", "termina en " + cola));
    await anotar("mensaje recibido", `${tipo}, termina en ${cola}`);
    if (!hayClave()) return void (await enviarTexto(telefono, "En este momento el asistente no está disponible. Escríbenos de nuevo en un rato."));
    if (tipo === "text" && (QUIERE_PROMOS.test(texto) || NO_QUIERE_PROMOS.test(texto))) {
      const acepta = QUIERE_PROMOS.test(texto);
      await guardarPromos(telefono, acepta);
      await anotar(acepta ? "autorizó promociones" : "retiró la autorización de promociones", "termina en " + cola);
      return void (await enviarTexto(telefono, acepta ? "Listo, veci. Te avisamos de las promociones por acá. Si después no querés más, respondé NO PROMOS." : "Listo, veci. No te enviamos promociones."));
    }
    if (await faltaAvisoDeDatos(telefono)) {
      await enviarTexto(telefono, avisoDeDatos());
      await anotar("aviso de datos enviado", "termina en " + cola);
    }
    if (tipo === "text") {
      const enviado = await contestar(telefono, await atenderWhatsApp(telefono, texto));
      return void (await anotar(enviado ? "respondido" : "respuesta lista pero no se envió", "termina en " + cola));
    }
    if (tipo === "image") {
      const imagen = await bajar?.();
      if (!imagen) {
        await anotar("no se pudo bajar la foto", "termina en " + cola);
        return void (await enviarTexto(telefono, "No pude abrir esa foto, veci. ¿Me la mandás otra vez?"));
      }
      const enviado = await contestar(telefono, await atenderWhatsApp(telefono, texto, imagen));
      return void (await anotar(enviado ? "foto leída y respondida" : "respuesta lista pero no se envió", "termina en " + cola));
    }
    if (ES_AUDIO.includes(tipo) && hayVoz()) {
      const audio = await bajarAudio?.();
      if (!audio) {
        await anotar("no se pudo bajar el audio", "termina en " + cola);
        return void (await enviarTexto(telefono, "No pude abrir ese audio, veci. ¿Me lo mandás otra vez o me escribís?"));
      }
      const dicho = await transcribir(audio);
      if (!dicho) {
        await anotar("audio sin palabras reconocibles", "termina en " + cola);
        return void (await enviarTexto(telefono, "No te alcancé a entender el audio, veci. ¿Me lo repetís o me lo escribís?"));
      }
      // El asistente sabe que es una transcripción y que puede traer errores de oído.
      const enviado = await contestar(telefono, await atenderWhatsApp(telefono, `[Nota de voz transcrita automáticamente; puede tener errores] ${dicho}`));
      return void (await anotar(enviado ? "audio transcrito y respondido" : "respuesta lista pero no se envió", `${dicho.length} caracteres, termina en ${cola}`));
    }
    await anotar("tipo de mensaje no atendido", `${tipo}, termina en ${cola}`);
    await enviarTexto(telefono, ES_AUDIO.includes(tipo) ? "Veci, por acá todavía no puedo escuchar audios. Escribime qué necesitás y te lo armo." : "Por acá solo leo texto, fotos y audios, veci. Escribime qué necesitás y te lo armo.");
  } catch (error) {
    console.error("whatsapp:", error);
    await anotar("error al atender", error?.message ?? error);
    // Sin saldo o sin clave el asistente no puede atender: el chat queda en manos de la tienda, que lo ve en su celular.
    const disculpa = error?.sinServicio ? "Veci, en este momento el asistente no está disponible. Ya te atiende alguien de la tienda por este mismo chat." : "Se nos enredó algo por acá. Escribime de nuevo en un momento, porfa.";
    await enviarTexto(telefono, disculpa).catch(() => {});
  }
}
