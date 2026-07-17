const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const pool = require('../db/pool');
const { obtenerPagoMercadoPago, getBaseUrl } = require('../services/mercadopago');
const { enviarConfirmacionReserva } = require('../services/whatsapp');
const { sincronizarReservaConfirmada } = require('../services/googleCalendar');

function obtenerPaymentId(req) {
  return (
    req.query['data.id'] ||
    req.query.id ||
    req.body?.data?.id ||
    req.body?.id ||
    null
  );
}

function mercadopagoRedirectUri() {
  return `${getBaseUrl()}/api/pagos/mercadopago/oauth/callback`;
}

async function expirarReservasPendientesPago() {
  return pool.query(
    `UPDATE reservas
     SET estado='cancelada',
         estado_pago='expirado',
         mercadopago_status=COALESCE(mercadopago_status, 'retencion_expirada'),
         pago_retencion_expirada_en=COALESCE(pago_retencion_expirada_en, NOW())
     WHERE estado='pendiente'
       AND estado_pago='pendiente'
       AND pago_retencion_vence_en IS NOT NULL
       AND pago_retencion_vence_en <= NOW()
     RETURNING id`
  );
}

router.get('/mercadopago/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.redirect(`${getBaseUrl()}/panel?mp=error`);
    }

    const dataState = jwt.verify(state, process.env.JWT_SECRET);

    if (dataState.tipo !== 'mp_oauth' || !dataState.slug) {
      return res.redirect(`${getBaseUrl()}/panel?mp=error`);
    }

    const tokenRes = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.MERCADOPAGO_CLIENT_ID,
        client_secret: process.env.MERCADOPAGO_CLIENT_SECRET,
        code,
        redirect_uri: mercadopagoRedirectUri()
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error('Error OAuth MercadoPago:', tokenData);
      return res.redirect(`${getBaseUrl()}/panel?mp=error`);
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
      : null;

    await pool.query(
      `UPDATE comercios
       SET mercadopago_user_id=$1,
           mercadopago_access_token=$2,
           mercadopago_refresh_token=$3,
           mercadopago_expires_at=$4,
           pago_mercadopago_activo=true,
           actualizado_en=NOW()
       WHERE slug=$5`,
      [
        tokenData.user_id ? String(tokenData.user_id) : null,
        tokenData.access_token,
        tokenData.refresh_token || null,
        expiresAt,
        dataState.slug
      ]
    );

    res.redirect(`${getBaseUrl()}/panel?mp=conectado`);
  } catch (e) {
    console.error('Error callback MercadoPago:', e.message);
    res.redirect(`${getBaseUrl()}/panel?mp=error`);
  }
});

router.post('/mercadopago/webhook', async (req, res) => {
  try {
    await expirarReservasPendientesPago();

    const paymentId = obtenerPaymentId(req);
    const reservaUuidDesdeUrl = req.query.reserva || null;
    const tipo = req.query.type || req.query.topic || req.body?.type || '';

    if (!paymentId || (tipo && !String(tipo).includes('payment'))) {
      return res.sendStatus(200);
    }

    if (!reservaUuidDesdeUrl) {
      return res.sendStatus(200);
    }

    const reservaToken = await pool.query(
      `SELECT r.uuid, c.mercadopago_access_token
       FROM reservas r
       JOIN comercios c ON c.id=r.comercio_id
       WHERE r.uuid=$1`,
      [reservaUuidDesdeUrl]
    );

    if (!reservaToken.rows[0]?.mercadopago_access_token) {
      return res.sendStatus(200);
    }

    const pago = await obtenerPagoMercadoPago(
      paymentId,
      reservaToken.rows[0].mercadopago_access_token
    );

    const reservaUuid = pago.external_reference || reservaUuidDesdeUrl;

    if (pago.status !== 'approved') {
      const estadosPagoCancelanRetencion = new Set([
        'rejected',
        'cancelled',
        'cancelled_by_user',
        'refunded',
        'charged_back'
      ]);
      const cancelarRetencion = estadosPagoCancelanRetencion.has(String(pago.status || '').toLowerCase());

      await pool.query(
        `UPDATE reservas
         SET mercadopago_payment_id=$1,
             mercadopago_status=$2,
             estado=CASE WHEN $4::boolean AND estado='pendiente' THEN 'cancelada' ELSE estado END,
             estado_pago=CASE WHEN $4::boolean AND estado_pago='pendiente' THEN 'cancelado' ELSE estado_pago END,
             pago_retencion_expirada_en=CASE WHEN $4::boolean AND pago_retencion_expirada_en IS NULL THEN NOW() ELSE pago_retencion_expirada_en END
         WHERE uuid=$3`,
        [String(pago.id), pago.status || null, reservaUuid, cancelarRetencion]
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
         AND estado_pago='pendiente'
         AND (pago_retencion_vence_en IS NULL OR pago_retencion_vence_en > NOW())
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

    sincronizarReservaConfirmada(pool, reserva.id).catch(err => {
      console.error('No se pudo sincronizar Google Calendar tras pago:', err.message);
    });

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
