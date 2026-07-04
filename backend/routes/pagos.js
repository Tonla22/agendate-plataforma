const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { obtenerPagoMercadoPago } = require('../services/mercadopago');
const { enviarConfirmacionReserva } = require('../services/whatsapp');

function obtenerPaymentId(req) {
  return (
    req.query['data.id'] ||
    req.query.id ||
    req.body?.data?.id ||
    req.body?.id ||
    null
  );
}

router.post('/mercadopago/webhook', async (req, res) => {
  try {
    const paymentId = obtenerPaymentId(req);
    const tipo = req.query.type || req.query.topic || req.body?.type || '';

    if (!paymentId || (tipo && !String(tipo).includes('payment'))) {
      return res.sendStatus(200);
    }

    const pago = await obtenerPagoMercadoPago(paymentId);
    const reservaUuid = pago.external_reference || pago.metadata?.reserva_uuid;

    if (!reservaUuid) {
      return res.sendStatus(200);
    }

    if (pago.status !== 'approved') {
      await pool.query(
        `UPDATE reservas
         SET mercadopago_payment_id=$1,
             mercadopago_status=$2
         WHERE uuid=$3`,
        [String(pago.id), pago.status || null, reservaUuid]
      );

      return res.sendStatus(200);
    }

    const reservaActualizada = await pool.query(
      `UPDATE reservas
       SET estado='confirmada',
           estado_pago='pagado',
           mercadopago_payment_id=$1,
           mercadopago_status=$2,
           pagada_en=NOW()
       WHERE uuid=$3
         AND estado='pendiente'
       RETURNING *`,
      [String(pago.id), pago.status, reservaUuid]
    );

    const reserva = reservaActualizada.rows[0];

    if (!reserva) {
      return res.sendStatus(200);
    }

    const comercioRes = await pool.query(
      'SELECT * FROM comercios WHERE id=$1',
      [reserva.comercio_id]
    );

    const servicioRes = await pool.query(
      'SELECT * FROM servicios WHERE id=$1',
      [reserva.servicio_id]
    );

    const trabajadorRes = reserva.trabajador_id
      ? await pool.query('SELECT id,nombre FROM trabajadores WHERE id=$1', [reserva.trabajador_id])
      : { rows: [] };

    const comercio = comercioRes.rows[0];
    const servicio = servicioRes.rows[0];
    const trabajador = trabajadorRes.rows[0] || null;

    if (comercio?.auto_confirmacion_activa !== false) {
      enviarConfirmacionReserva({
        reserva,
        comercio,
        servicio,
        profesional: trabajador
      })
        .then(() => {
          return pool.query(
            `UPDATE reservas
             SET confirmacion_enviada=true,
                 confirmacion_enviada_en=NOW()
             WHERE id=$1`,
            [reserva.id]
          );
        })
        .catch(err => {
          console.error('No se pudo enviar confirmación WhatsApp:', err.message);
        });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Error webhook MercadoPago:', e.message);
    res.sendStatus(200);
  }
});

module.exports = router;