import { COSTO_DOMICILIO, METODOS_PAGO, datosTransferencia } from "../lib/comun.js";

// Lo que la página necesita saber del negocio. Es público: son los datos que se le dan a cualquier cliente.
export default function handler(req, res) {
  return res.status(200).json({ costoDomicilio: COSTO_DOMICILIO, metodosPago: METODOS_PAGO, datosTransferencia: datosTransferencia() });
}
