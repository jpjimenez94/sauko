import { METODOS_PAGO, datosTransferencia, horario } from "../lib/comun.js";

// Lo que la página necesita saber del negocio en este momento. Es público: son los datos que se
// le dan a cualquier cliente. El costo del domicilio y la nota de horario cambian con la hora.
export default function handler(req, res) {
  const ahora = horario();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    costoDomicilio: ahora.costoDomicilio,
    franja: ahora.franja,
    notaHorario: ahora.nota,
    encargo: ahora.encargo,
    metodosPago: METODOS_PAGO,
    datosTransferencia: datosTransferencia(),
  });
}
