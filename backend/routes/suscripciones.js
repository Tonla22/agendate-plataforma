const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const pool = require('../db/pool');
const { authAdminOrComercio } = require('../middleware/auth');
const { registrarEvento } = require('../services/operationalEvents');
const {
  actualizarSuscripcion,
  comercioIdDesdeExternalReference,
  crearSuscripcionComercio,
  getPlatformOAuthRedirectUri,
  intercambiarCodigoOAuthPlataforma,
  normalizarEstadoSuscripcion,
  obtenerPagoAutorizado,
  obtenerPagoPlataforma,
  obtenerSuscripcion
} = require('../services/platformSubscriptions');

function fechaISO(valor) {
  if (!valor) return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

function validarFirmaWebhook(req) {
  const secret = process.env.MERCADOPAGO_PLATFORM_WEBHOOK_SECRET;
  if (!secret) return true;

  const signatureHeader = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  const signatureParts = Object.fromEntries(
    signatureHeader
      .split(',')
      .map(part => part.trim().split('='))
      .filter(part => part.length === 2)
  );
  const timestamp = signatureParts.ts;
  const signature = signatureParts.v1;

  if (!timestamp || !signature) return false;

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${timestamp};`;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function configuracionMensualidad(client = pool) {
  const resultado = await client.query(`
    SELECT mensualidad_monto, mensualidad_moneda, dias_prueba,
           dias_tolerancia, mercadopago_plan_id,
           mercadopago_platform_access_token IS NOT NULL AS mercadopago_conectado
    FROM configuracion_plataforma
    WHERE id=1
  `);

  return resultado.rows[0] || {
    mensualidad_monto: 1600,
    mensualidad_moneda: 'UYU',
    dias_prueba: 0,
    dias_tolerancia: 5,
    mercadopago_plan_id: null
  };
}

async function buscarComercioPorSlug(slug, client = pool) {
  const resultado = await client.query(`
    SELECT c.*, uc.email AS dueno_email
    FROM comercios c
    LEFT JOIN LATERAL (
      SELECT email
      FROM usuarios_comercio
      WHERE comercio_id=c.id AND activo=true
      ORDER BY (rol='dueno') DESC, id
      LIMIT 1
    ) uc ON true
    WHERE c.slug=$1
  `, [slug]);

  return resultado.rows[0];
}

async function sincronizarSuscripcion(comercio, subscription) {
  const estado = normalizarEstadoSuscripcion(subscription.status);
  const proximoCobro = fechaISO(subscription.next_payment_date);

  await pool.query(`
    UPDATE comercios
    SET suscripcion_estado=$1,
        suscripcion_mp_id=COALESCE($2, suscripcion_mp_id),
        suscripcion_mp_plan_id=COALESCE($3, suscripcion_mp_plan_id),
        suscripcion_proximo_cobro=$4,
        suscripcion_cancelada_en=CASE WHEN $1='cancelada' THEN NOW() ELSE suscripcion_cancelada_en END,
        actualizado_en=NOW()
    WHERE id=$5
  `, [
    estado,
    subscription.id || null,
    subscription.preapproval_plan_id || null,
    proximoCobro,
    comercio.id
  ]);

  return estado;
}

router.get('/mercadopago/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect('/admin?mp_plataforma=error');

    const dataState = jwt.verify(state, process.env.JWT_SECRET);
    if (dataState.tipo !== 'mp_platform_oauth' || !dataState.admin_id) {
      return res.redirect('/admin?mp_plataforma=error');
    }

    await intercambiarCodigoOAuthPlataforma({
      code,
      redirectUri: getPlatformOAuthRedirectUri()
    });

    res.redirect('/admin?mp_plataforma=conectado');
  } catch (error) {
    registrarEvento({
      nivel: 'error',
      categoria: 'suscripciones',
      codigo: 'mercadopago_platform_oauth_error',
      mensaje: 'Fallo la vinculacion de Mercado Pago para las mensualidades',
      contexto: { error: error.message }
    });
    res.redirect('/admin?mp_plataforma=error');
  }
});

router.get('/:slug', authAdminOrComercio, async (req, res) => {
  try {
    const comercio = await buscarComercioPorSlug(req.params.slug);
    if (!comercio) return res.status(404).json({ error: 'Comercio no encontrado' });

    const configuracion = await configuracionMensualidad();
    const historial = await pool.query(`
      SELECT id, proveedor, proveedor_pago_id, estado, monto, moneda,
             periodo_desde, periodo_hasta, vencimiento_en, pagado_en,
             detalle, creado_en
      FROM mensualidades_plataforma
      WHERE comercio_id=$1
      ORDER BY creado_en DESC
      LIMIT 24
    `, [comercio.id]);

    const hoy = new Date().toISOString().slice(0, 10);
    const accesoRestringido =
      comercio.suscripcion_estado === 'pausada' ||
      (
        comercio.suscripcion_estado === 'pago_pendiente' &&
        comercio.suscripcion_tolerancia_hasta &&
        String(comercio.suscripcion_tolerancia_hasta).slice(0, 10) < hoy
      ) ||
      (
        comercio.suscripcion_estado === 'cancelada' &&
        comercio.fecha_pago_hasta &&
        String(comercio.fecha_pago_hasta).slice(0, 10) < hoy
      );

    res.json({
      plan: comercio.plan || 'inicial',
      estado: comercio.suscripcion_estado || 'sin_suscripcion',
      monto: Number(comercio.suscripcion_monto || configuracion.mensualidad_monto || 1600),
      moneda: comercio.suscripcion_moneda || configuracion.mensualidad_moneda || 'UYU',
      proximo_cobro: comercio.suscripcion_proximo_cobro,
      ultimo_pago_en: comercio.suscripcion_ultimo_pago_en,
      pagado_hasta: comercio.fecha_pago_hasta,
      tolerancia_hasta: comercio.suscripcion_tolerancia_hasta,
      suscripcion_configurada: Boolean(comercio.suscripcion_mp_id),
      cobro_online_disponible: Boolean(
        configuracion.mercadopago_conectado ||
        process.env.MERCADOPAGO_PLATFORM_ACCESS_TOKEN
      ),
      acceso_restringido: Boolean(accesoRestringido),
      historial: historial.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:slug/iniciar', authAdminOrComercio, async (req, res) => {
  try {
    const comercio = await buscarComercioPorSlug(req.params.slug);
    if (!comercio) return res.status(404).json({ error: 'Comercio no encontrado' });

    if (comercio.suscripcion_mp_id && comercio.suscripcion_estado !== 'cancelada') {
      const existente = await obtenerSuscripcion(comercio.suscripcion_mp_id);
      await sincronizarSuscripcion(comercio, existente);

      if (existente.status === 'authorized') {
        return res.status(409).json({ error: 'La suscripcion ya esta activa' });
      }

      if (existente.init_point) {
        return res.json({ payment_url: existente.init_point, estado: existente.status });
      }
    }

    const configuracion = await configuracionMensualidad();
    const payerEmail = comercio.dueno_email || comercio.email_contacto;
    if (!payerEmail) return res.status(400).json({ error: 'El comercio no tiene un email de pago configurado' });

    const subscription = await crearSuscripcionComercio({
      comercio,
      payerEmail,
      amount: comercio.suscripcion_monto || configuracion.mensualidad_monto,
      currency: comercio.suscripcion_moneda || configuracion.mensualidad_moneda,
      planId: configuracion.mercadopago_plan_id
    });

    await sincronizarSuscripcion(comercio, subscription);

    res.status(201).json({
      payment_url: subscription.init_point,
      estado: subscription.status,
      suscripcion_id: subscription.id
    });
  } catch (error) {
    const status = error.code === 'PLATFORM_MERCADOPAGO_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: error.message });
  }
});

router.post('/:slug/cancelar', authAdminOrComercio, async (req, res) => {
  try {
    const comercio = await buscarComercioPorSlug(req.params.slug);
    if (!comercio) return res.status(404).json({ error: 'Comercio no encontrado' });
    if (!comercio.suscripcion_mp_id) return res.status(400).json({ error: 'No hay una suscripcion para cancelar' });

    const subscription = await actualizarSuscripcion(comercio.suscripcion_mp_id, {
      status: 'canceled'
    });
    await sincronizarSuscripcion(comercio, subscription);

    res.json({ ok: true, estado: normalizarEstadoSuscripcion(subscription.status) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function procesarPagoMercadoPago(paymentId) {
  const payment = await obtenerPagoPlataforma(paymentId);
  const comercioId =
    comercioIdDesdeExternalReference(payment.external_reference) ||
    Number(payment.metadata?.comercio_id || 0);

  if (!comercioId) return { ignored: true };

  const configuracion = await configuracionMensualidad();
  const estado = String(payment.status || 'unknown').toLowerCase();
  const aprobado = estado === 'approved';
  const pagadoEn = fechaISO(payment.date_approved);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO mensualidades_plataforma (
        comercio_id, proveedor, proveedor_pago_id, proveedor_suscripcion_id,
        estado, monto, moneda, periodo_desde, periodo_hasta, pagado_en, detalle
      )
      VALUES (
        $1, 'mercadopago', $2, $3, $4, $5, $6,
        CASE WHEN $7::boolean THEN CURRENT_DATE ELSE NULL END,
        CASE WHEN $7::boolean THEN (CURRENT_DATE + INTERVAL '1 month')::date ELSE NULL END,
        $8, $9
      )
      ON CONFLICT (proveedor, proveedor_pago_id)
      DO UPDATE SET
        estado=EXCLUDED.estado,
        pagado_en=EXCLUDED.pagado_en,
        detalle=EXCLUDED.detalle,
        actualizado_en=NOW()
    `, [
      comercioId,
      String(payment.id),
      payment.metadata?.preapproval_id || null,
      estado,
      Number(payment.transaction_amount || 0),
      payment.currency_id || configuracion.mensualidad_moneda || 'UYU',
      aprobado,
      pagadoEn,
      payment.status_detail || null
    ]);

    if (aprobado) {
      await client.query(`
        UPDATE comercios
        SET suscripcion_estado='activa',
            suscripcion_ultimo_pago_en=COALESCE($1, NOW()),
            fecha_pago_hasta=(CURRENT_DATE + INTERVAL '1 month')::date,
            suscripcion_tolerancia_hasta=NULL,
            actualizado_en=NOW()
        WHERE id=$2
      `, [pagadoEn, comercioId]);
    } else if (['rejected', 'cancelled', 'charged_back', 'refunded'].includes(estado)) {
      await client.query(`
        UPDATE comercios
        SET suscripcion_estado='pago_pendiente',
            suscripcion_tolerancia_hasta=CURRENT_DATE + $1::integer,
            actualizado_en=NOW()
        WHERE id=$2
      `, [Number(configuracion.dias_tolerancia || 5), comercioId]);
    }

    await client.query('COMMIT');
    return { comercioId, estado };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

router.post('/webhook/mercadopago', async (req, res) => {
  const type = String(req.body?.type || req.query.type || '').toLowerCase();
  const resourceId = req.body?.data?.id || req.query['data.id'] || req.query.id;

  if (!validarFirmaWebhook(req)) {
    return res.status(401).json({ error: 'Firma de webhook invalida' });
  }

  res.status(200).json({ received: true });

  if (!resourceId) return;

  try {
    if (type === 'subscription_preapproval' || type === 'preapproval') {
      const subscription = await obtenerSuscripcion(resourceId);
      const comercioId = comercioIdDesdeExternalReference(subscription.external_reference);
      if (!comercioId) return;

      const comercio = { id: comercioId };
      await sincronizarSuscripcion(comercio, subscription);
      return;
    }

    if (type === 'payment') {
      await procesarPagoMercadoPago(resourceId);
      return;
    }

    if (type === 'subscription_authorized_payment') {
      const authorizedPayment = await obtenerPagoAutorizado(resourceId);
      if (authorizedPayment.payment?.id) {
        await procesarPagoMercadoPago(authorizedPayment.payment.id);
      }
    }
  } catch (error) {
    registrarEvento({
      nivel: 'error',
      categoria: 'suscripciones',
      codigo: 'mensualidad_webhook_error',
      mensaje: 'Fallo el procesamiento de una mensualidad de Agendate',
      contexto: { type, resource_id: String(resourceId), error: error.message }
    });
  }
});

module.exports = router;
