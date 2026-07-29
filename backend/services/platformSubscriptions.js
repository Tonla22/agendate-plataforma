const { getBaseUrl } = require('./mercadopago');
const pool = require('../db/pool');

async function oauthTokenRequest(body) {
  const response = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || data.error || 'Mercado Pago rechazo la vinculacion');
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function guardarCredencialesOAuth(tokenData) {
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
    : null;

  await pool.query(`
    INSERT INTO configuracion_plataforma (
      id, mercadopago_platform_user_id, mercadopago_platform_access_token,
      mercadopago_platform_refresh_token, mercadopago_platform_expires_at,
      mercadopago_platform_conectado_en, actualizado_en
    )
    VALUES (1, $1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      mercadopago_platform_user_id=EXCLUDED.mercadopago_platform_user_id,
      mercadopago_platform_access_token=EXCLUDED.mercadopago_platform_access_token,
      mercadopago_platform_refresh_token=EXCLUDED.mercadopago_platform_refresh_token,
      mercadopago_platform_expires_at=EXCLUDED.mercadopago_platform_expires_at,
      mercadopago_platform_conectado_en=COALESCE(
        configuracion_plataforma.mercadopago_platform_conectado_en,
        NOW()
      ),
      actualizado_en=NOW()
  `, [
    tokenData.user_id ? String(tokenData.user_id) : null,
    tokenData.access_token,
    tokenData.refresh_token || null,
    expiresAt
  ]);

  return tokenData.access_token;
}

async function conectarMercadoPagoPlataforma() {
  if (!process.env.MERCADOPAGO_CLIENT_ID || !process.env.MERCADOPAGO_CLIENT_SECRET) {
    const error = new Error('Faltan las credenciales de Mercado Pago en Render');
    error.code = 'PLATFORM_MERCADOPAGO_CREDENTIALS_MISSING';
    throw error;
  }

  const tokenData = await oauthTokenRequest({
    grant_type: 'client_credentials',
    client_id: process.env.MERCADOPAGO_CLIENT_ID,
    client_secret: process.env.MERCADOPAGO_CLIENT_SECRET
  });
  await guardarCredencialesOAuth(tokenData);
  return tokenData;
}

async function getPlatformAccessToken() {
  const resultado = await pool.query(`
    SELECT mercadopago_platform_access_token AS access_token,
           mercadopago_platform_refresh_token AS refresh_token,
           mercadopago_platform_expires_at AS expires_at
    FROM configuracion_plataforma
    WHERE id=1
  `);
  const credenciales = resultado.rows[0];
  const expiraPronto = credenciales?.expires_at &&
    new Date(credenciales.expires_at).getTime() <= Date.now() + 5 * 60 * 1000;

  if (credenciales?.access_token && !expiraPronto) {
    return credenciales.access_token;
  }

  if (credenciales?.refresh_token && process.env.MERCADOPAGO_CLIENT_ID && process.env.MERCADOPAGO_CLIENT_SECRET) {
    const tokenData = await oauthTokenRequest({
      grant_type: 'refresh_token',
      client_id: process.env.MERCADOPAGO_CLIENT_ID,
      client_secret: process.env.MERCADOPAGO_CLIENT_SECRET,
      refresh_token: credenciales.refresh_token
    });
    return guardarCredencialesOAuth(tokenData);
  }

  if (process.env.MERCADOPAGO_CLIENT_ID && process.env.MERCADOPAGO_CLIENT_SECRET) {
    const tokenData = await conectarMercadoPagoPlataforma();
    return tokenData.access_token;
  }

  const token = process.env.MERCADOPAGO_PLATFORM_ACCESS_TOKEN;

  if (!token) {
    const error = new Error('Falta configurar Mercado Pago para cobrar las mensualidades de Agendate');
    error.code = 'PLATFORM_MERCADOPAGO_NOT_CONFIGURED';
    throw error;
  }

  return token;
}

async function mercadoPagoRequest(path, options = {}) {
  const accessToken = await getPlatformAccessToken();
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.message ||
      data.error ||
      'Mercado Pago no pudo procesar la suscripcion'
    );
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function externalReferenceComercio(comercioId) {
  return `agendate-comercio-${comercioId}`;
}

function comercioIdDesdeExternalReference(reference) {
  const match = String(reference || '').match(/^agendate-comercio-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function normalizarEstadoSuscripcion(status) {
  const estado = String(status || '').toLowerCase();

  if (estado === 'authorized') return 'activa';
  if (estado === 'pending') return 'pendiente';
  if (estado === 'paused') return 'pausada';
  if (estado === 'cancelled' || estado === 'canceled') return 'cancelada';
  return estado || 'sin_suscripcion';
}

async function crearSuscripcionComercio({
  comercio,
  payerEmail,
  amount,
  currency,
  planId
}) {
  const baseUrl = getBaseUrl();
  const body = {
    reason: `Agendate ${comercio.plan || 'Inicial'}`,
    payer_email: payerEmail,
    external_reference: externalReferenceComercio(comercio.id),
    back_url: `${baseUrl}/panel#cuenta`,
    notification_url: `${baseUrl}/api/suscripciones/webhook/mercadopago`,
    status: 'pending'
  };

  if (planId) {
    body.preapproval_plan_id = planId;
  } else {
    body.auto_recurring = {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: Number(amount),
      currency_id: currency || 'UYU'
    };
  }

  return mercadoPagoRequest('/preapproval', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

function obtenerSuscripcion(subscriptionId) {
  return mercadoPagoRequest(`/preapproval/${encodeURIComponent(subscriptionId)}`);
}

function actualizarSuscripcion(subscriptionId, changes) {
  return mercadoPagoRequest(`/preapproval/${encodeURIComponent(subscriptionId)}`, {
    method: 'PUT',
    body: JSON.stringify(changes)
  });
}

function obtenerPagoPlataforma(paymentId) {
  return mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

function obtenerPagoAutorizado(authorizedPaymentId) {
  return mercadoPagoRequest(`/authorized_payments/${encodeURIComponent(authorizedPaymentId)}`);
}

module.exports = {
  actualizarSuscripcion,
  comercioIdDesdeExternalReference,
  conectarMercadoPagoPlataforma,
  crearSuscripcionComercio,
  externalReferenceComercio,
  normalizarEstadoSuscripcion,
  obtenerPagoAutorizado,
  obtenerPagoPlataforma,
  obtenerSuscripcion
};
