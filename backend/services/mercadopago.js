const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

function getBaseUrl() {
  return (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function getClient(accessToken) {
  const token = accessToken || process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!token) {
    throw new Error('Falta configurar MercadoPago para este comercio');
  }

  return new MercadoPagoConfig({ accessToken: token });
}

async function crearPreferenciaReserva({ reserva, comercio, servicio, monto }) {
  const client = getClient(comercio.mercadopago_access_token);
  const preference = new Preference(client);
  const baseUrl = getBaseUrl();
  const moneda = process.env.MERCADOPAGO_CURRENCY || 'UYU';

  const result = await preference.create({
    body: {
      items: [
        {
          id: String(reserva.uuid),
          title: `Seña - ${servicio.nombre}`,
          description: `${comercio.nombre} - Reserva ${reserva.fecha} ${reserva.hora}`,
          quantity: 1,
          currency_id: moneda,
          unit_price: Number(monto)
        }
      ],
      payer: {
        name: reserva.cliente_nombre,
        surname: reserva.cliente_apellido || '',
        email: reserva.cliente_email || undefined
      },
      external_reference: reserva.uuid,
      metadata: {
        reserva_uuid: reserva.uuid,
        reserva_id: reserva.id,
        comercio_id: comercio.id
      },
      back_urls: {
        success: `${baseUrl}/${comercio.slug}?pago=ok&reserva=${reserva.uuid}`,
        failure: `${baseUrl}/${comercio.slug}?pago=error&reserva=${reserva.uuid}`,
        pending: `${baseUrl}/${comercio.slug}?pago=pendiente&reserva=${reserva.uuid}`
      },
      notification_url: `${baseUrl}/api/pagos/mercadopago/webhook?reserva=${encodeURIComponent(reserva.uuid)}`,
      auto_return: 'approved'
    }
  });

  return {
    preference_id: result.id,
    payment_url: result.init_point || result.sandbox_init_point
  };
}

async function obtenerPagoMercadoPago(paymentId, accessToken) {
  const client = getClient(accessToken);
  const payment = new Payment(client);
  return payment.get({ id: paymentId });
}

module.exports = {
  crearPreferenciaReserva,
  obtenerPagoMercadoPago,
  getBaseUrl
};