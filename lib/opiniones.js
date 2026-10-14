// Cómo le fue al cliente con su pedido: la pregunta sale pegada al aviso de "entregado" y se
// responde con un toque. No pasa por el asistente: es más barato y no depende de que haya saldo.
import { marcarEncuesta, leerEncuesta, guardarOpinion, leerOpinion, esperarComentario, tomarComentarioPendiente, anotar } from "./store.js";
import { enviarBotones, enviarTexto } from "./whatsapp.js";

// Cada opción cabe en un botón de WhatsApp (20 caracteres). "mal" abre la pregunta de qué pasó.
export const OPCIONES = [
  { titulo: "Rápido y completo", nota: "bien", gracias: "¡Qué bueno, veci! Gracias por contarnos. Acá estamos para la próxima." },
  { titulo: "Bien, pero demoró", nota: "regular", gracias: "Gracias por contarnos, veci. Vamos a ponerle cuidado a los tiempos." },
  { titulo: "Algo falló", nota: "mal", gracias: "Qué pena, veci. ¿Qué pasó? Contanos por acá y la tienda lo revisa." },
];
const UN_DIA = 86400_000;
const igual = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Envía el aviso de entregado; si a este cliente no se le ha preguntado hace poco, con la pregunta y sus botones. */
export async function avisarEntrega(pedido, aviso) {
  if (!pedido.cliente) return false;
  if (await marcarEncuesta(pedido.cliente, pedido.no)) {
    const texto = `Pedido entregado, veci. Gracias por comprar en Sauko Store.\n\nSi querés, contanos: ¿cómo te fue con el pedido?`;
    if (await enviarBotones(pedido.cliente, texto, OPCIONES.map((o) => ({ titulo: o.titulo, detalle: "" })))) return true;
  }
  return enviarTexto(pedido.cliente, aviso);
}

/** ¿Este mensaje es la respuesta a la pregunta o el comentario que se está esperando? No cambia nada. */
export async function esOpinion(telefono, texto) {
  const encuesta = await leerEncuesta(telefono);
  if (!encuesta || Date.now() - encuesta.hora > UN_DIA) return false;
  if (OPCIONES.some((o) => igual(o.titulo, texto))) return true;
  // Si dijo que algo falló y aún no ha contado qué, lo siguiente que escriba es el comentario.
  const opinion = await leerOpinion(`${encuesta.hora}-${encuesta.no}`);
  return Boolean(opinion && opinion.nota === "mal" && !opinion.comentario && Date.now() - opinion.hora < 3600_000);
}

/**
 * Si el mensaje es la respuesta a la pregunta (o el comentario que sigue a "Algo falló"), la guarda,
 * le contesta al cliente y devuelve true: ese mensaje no va al asistente.
 */
export async function atenderOpinion(telefono, texto) {
  const pendiente = await tomarComentarioPendiente(telefono);
  if (pendiente) {
    const opinion = await leerOpinion(pendiente);
    if (opinion) {
      await guardarOpinion({ ...opinion, comentario: String(texto).slice(0, 600) });
      await anotar("comentario de un cliente guardado", "pedido #" + opinion.no);
      await enviarTexto(telefono, "Gracias por contarnos, veci. La tienda ya lo tiene y lo revisa; si hace falta, te escribimos por acá.");
      return true;
    }
  }
  const opcion = OPCIONES.find((o) => igual(o.titulo, texto));
  if (!opcion) return false;
  const encuesta = await leerEncuesta(telefono);
  if (!encuesta || Date.now() - encuesta.hora > UN_DIA) return false;
  const id = `${encuesta.hora}-${encuesta.no}`;
  await guardarOpinion({ id, no: encuesta.no, cliente: telefono, respuesta: opcion.titulo, nota: opcion.nota, comentario: "", atendida: opcion.nota !== "mal", hora: Date.now() });
  if (opcion.nota === "mal") await esperarComentario(telefono, id);
  await anotar("opinión de un cliente", `${opcion.titulo}, pedido #${encuesta.no}`);
  await enviarTexto(telefono, opcion.gracias);
  return true;
}
