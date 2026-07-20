const { registrarEvento } = require('./operationalEvents');

function limpiarTexto(valor, fallback = '-') {
  const texto = String(valor ?? '').trim();
  return texto || fallback;
}

function normalizarTelefono(valor) {
  let n = String(valor || '').replace(/\D/g, '');

  if (n.startsWith('00')) n = n.slice(2);

  const codigoPais = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '598';

  if (n.startsWith(codigoPais)) return n;
  if (n.startsWith('0')) return `${codigoPais}${n.slice(1)}`;

  return n;
}

function formatearFecha(fecha) {
  const partes = String(fecha || '').slice(0, 10).split('-');
  if (partes.length !== 3) return limpiarTexto(fecha);
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

function templateText(text) {
  return { type: 'text', text: limpiarTexto(text) };
}

async function enviarTemplateWhatsApp({ to, templateName, language, components }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_API_VERSION || 'v25.0';

  if (!token || !phoneNumberId) {
    console.warn('WhatsApp no configurado: faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
    return null;
  }

  const telefono = normalizarTelefono(to);

  if (!telefono) {
    console.warn('WhatsApp no enviado: telefono vacio');
    return null;
  }

  const resp = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es' },
        components
      }
    })
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const detalle = data?.error?.message || JSON.stringify(data);
    registrarEvento({
      nivel: 'error',
      categoria: 'whatsapp',
      codigo: 'whatsapp_api_error',
      mensaje: `No se pudo enviar la plantilla ${templateName}`,
      contexto: {
        estado_http: resp.status,
        codigo_proveedor: data?.error?.code || null,
        plantilla: templateName
      }
    });
    throw new Error(`WhatsApp API error: ${detalle}`);
  }

  return data;
}

async function enviarConfirmacionReserva({ reserva, comercio, servicio, profesional }) {
  const templateName = process.env.WHATSAPP_CONFIRMACION_TEMPLATE || 'confirmacion_reserva';

  return enviarTemplateWhatsApp({
    to: reserva.cliente_whatsapp,
    templateName,
    components: [
      {
        type: 'body',
        parameters: [
          templateText(reserva.cliente_nombre),
          templateText(comercio.nombre),
          templateText(servicio.nombre),
          templateText(formatearFecha(reserva.fecha)),
          templateText(String(reserva.hora || '').slice(0, 5)),
          templateText(profesional?.nombre || 'el equipo'),
          templateText(comercio.whatsapp || comercio.telefono || '-')
        ]
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          templateText(reserva.uuid)
        ]
      }
    ]
  });
}

async function enviarRecordatorioReserva({ reserva, comercio, servicio, profesional }) {
  const templateName =
    process.env.WHATSAPP_RECORDATORIO_TEMPLATE || 'recordatorio_reserva';

  return enviarTemplateWhatsApp({
    to: reserva.cliente_whatsapp,
    templateName,
    components: [
      {
        type: 'body',
        parameters: [
          templateText(reserva.cliente_nombre),
          templateText(comercio.nombre),
          templateText(servicio.nombre),
          templateText(formatearFecha(reserva.fecha)),
          templateText(String(reserva.hora || '').slice(0, 5)),
          templateText(profesional?.nombre || 'el equipo')
        ]
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [templateText(reserva.uuid)]
      }
    ]
  });
}

async function enviarCancelacionReserva({ reserva, comercio, servicio }) {
  const templateName =
    process.env.WHATSAPP_CANCELACION_TEMPLATE || 'cancelacion_reserva';

  return enviarTemplateWhatsApp({
    to: reserva.cliente_whatsapp,
    templateName,
    components: [
      {
        type: 'body',
        parameters: [
          templateText(reserva.cliente_nombre),
          templateText(comercio.nombre),
          templateText(servicio.nombre),
          templateText(formatearFecha(reserva.fecha)),
          templateText(String(reserva.hora || '').slice(0, 5))
        ]
      }
    ]
  });
}

async function enviarAgradecimientoReserva({ reserva, comercio, servicio, profesional }) {
  const templateName =
    process.env.WHATSAPP_AGRADECIMIENTO_TEMPLATE || 'agradecimiento_reserva';

  return enviarTemplateWhatsApp({
    to: reserva.cliente_whatsapp,
    templateName,
    components: [
      {
        type: 'body',
        parameters: [
          templateText(reserva.cliente_nombre),
          templateText(comercio.nombre),
          templateText(servicio.nombre),
          templateText(profesional?.nombre || 'el equipo')
        ]
      }
    ]
  });
}

module.exports = {
  enviarTemplateWhatsApp,
  enviarConfirmacionReserva,
  enviarRecordatorioReserva,
  enviarCancelacionReserva,
  enviarAgradecimientoReserva
};
