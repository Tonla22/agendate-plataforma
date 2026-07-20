const { google } = require('googleapis');
const { registrarEvento } = require('./operationalEvents');

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/userinfo.email'
];

function getBaseUrl() {
  return (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function getGoogleRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `${getBaseUrl()}/api/comercio/google-calendar/callback`;
}

function crearOAuthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET');
  }

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getGoogleRedirectUri()
  );
}

function generarUrlAutorizacionGoogle(state) {
  const auth = crearOAuthClient();

  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state
  });
}

async function intercambiarCodigoGoogle(code) {
  const auth = crearOAuthClient();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);

  let email = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const info = await oauth2.userinfo.get();
    email = info.data?.email || null;
  } catch (e) {
    console.warn('No se pudo obtener email de Google Calendar:', e.message);
  }

  return { tokens, email };
}

function tieneGoogleCalendar(comercio) {
  return Boolean(
    comercio &&
    comercio.google_calendar_refresh_token &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
}

function normalizarFecha(fecha) {
  if (fecha instanceof Date) return fecha.toISOString().slice(0, 10);
  return String(fecha || '').slice(0, 10);
}

function normalizarHora(hora) {
  return String(hora || '00:00').slice(0, 5);
}

function nombreCompletoReserva(reserva) {
  return [reserva.cliente_nombre, reserva.cliente_apellido].filter(Boolean).join(' ').trim();
}

function construirEvento({ reserva, comercio, servicio, profesional, ubicacion }) {
  const fecha = normalizarFecha(reserva.fecha);
  const hora = normalizarHora(reserva.hora);
  const duracion = Number(reserva.duracion_min || servicio?.duracion_min || 30);
  const inicio = new Date(`${fecha}T${hora}:00-03:00`);
  const fin = new Date(inicio.getTime() + duracion * 60000);
  const cliente = nombreCompletoReserva(reserva) || 'Cliente';
  const profesionalNombre = profesional?.nombre || null;
  const ubicacionTexto = ubicacion?.direccion || comercio.direccion || '';

  const descripcion = [
    `Cliente: ${cliente}`,
    reserva.cliente_whatsapp ? `WhatsApp: ${reserva.cliente_whatsapp}` : '',
    reserva.cliente_email ? `Email: ${reserva.cliente_email}` : '',
    profesionalNombre ? `Profesional: ${profesionalNombre}` : '',
    `Estado: ${reserva.estado}`,
    reserva.comentarios ? `Comentarios: ${reserva.comentarios}` : '',
    `Reserva Agendate: ${reserva.uuid}`
  ].filter(Boolean).join('\n');

  return {
    summary: `${servicio?.nombre || 'Reserva'} - ${cliente}`,
    description: descripcion,
    location: ubicacionTexto || undefined,
    start: {
      dateTime: inicio.toISOString(),
      timeZone: 'America/Montevideo'
    },
    end: {
      dateTime: fin.toISOString(),
      timeZone: 'America/Montevideo'
    }
  };
}

function crearClienteAutenticado(comercio, pool) {
  const auth = crearOAuthClient();
  auth.setCredentials({
    access_token: comercio.google_calendar_access_token || undefined,
    refresh_token: comercio.google_calendar_refresh_token || undefined,
    expiry_date: comercio.google_calendar_expiry_date ? Number(comercio.google_calendar_expiry_date) : undefined
  });

  auth.on('tokens', tokens => {
    if (!tokens.access_token && !tokens.refresh_token) return;

    pool.query(
      `UPDATE comercios
       SET google_calendar_access_token=COALESCE($1, google_calendar_access_token),
           google_calendar_refresh_token=COALESCE($2, google_calendar_refresh_token),
           google_calendar_expiry_date=COALESCE($3, google_calendar_expiry_date),
           actualizado_en=NOW()
       WHERE id=$4`,
      [
        tokens.access_token || null,
        tokens.refresh_token || null,
        tokens.expiry_date || null,
        comercio.id
      ]
    ).catch(err => {
      console.error('No se pudieron refrescar tokens de Google Calendar:', err.message);
    });
  });

  return auth;
}

async function cargarContextoReserva(pool, reservaId) {
  const { rows } = await pool.query(
    `SELECT
       r.*,
       row_to_json(c) AS comercio,
       row_to_json(s) AS servicio,
       CASE WHEN t.id IS NULL THEN NULL ELSE row_to_json(t) END AS profesional,
       CASE WHEN u.id IS NULL THEN NULL ELSE row_to_json(u) END AS ubicacion
     FROM reservas r
     JOIN comercios c ON c.id=r.comercio_id
     JOIN servicios s ON s.id=r.servicio_id
     LEFT JOIN trabajadores t ON t.id=r.trabajador_id
     LEFT JOIN ubicaciones u ON u.id=r.ubicacion_id
     WHERE r.id=$1
     LIMIT 1`,
    [reservaId]
  );

  return rows[0] || null;
}

async function guardarEvento(calendar, calendarId, reserva, evento) {
  if (reserva.google_calendar_event_id) {
    try {
      const actualizado = await calendar.events.update({
        calendarId,
        eventId: reserva.google_calendar_event_id,
        requestBody: evento
      });

      return actualizado.data;
    } catch (e) {
      if (e.code !== 404 && e.status !== 404) throw e;
    }
  }

  const creado = await calendar.events.insert({
    calendarId,
    requestBody: evento
  });

  return creado.data;
}

async function sincronizarReservaConfirmada(pool, reservaId) {
  const contexto = await cargarContextoReserva(pool, reservaId);
  if (!contexto || contexto.estado !== 'confirmada') return { skipped: true };

  const { comercio, servicio, profesional, ubicacion } = contexto;
  if (!tieneGoogleCalendar(comercio)) return { skipped: true };

  try {
    const auth = crearClienteAutenticado(comercio, pool);
    const calendar = google.calendar({ version: 'v3', auth });
    const calendarId = comercio.google_calendar_id || 'primary';
    const evento = construirEvento({
      reserva: contexto,
      comercio,
      servicio,
      profesional,
      ubicacion
    });

    const guardado = await guardarEvento(calendar, calendarId, contexto, evento);

    await pool.query(
      `UPDATE reservas
       SET google_calendar_event_id=$1,
           google_calendar_event_link=$2,
           google_calendar_sync_error=NULL
       WHERE id=$3`,
      [guardado.id, guardado.htmlLink || null, reservaId]
    );

    return { ok: true, event_id: guardado.id };
  } catch (e) {
    await pool.query(
      `UPDATE reservas
       SET google_calendar_sync_error=$1
       WHERE id=$2`,
      [String(e.message || e).slice(0, 500), reservaId]
    );

    console.error('No se pudo sincronizar Google Calendar:', e.message);
    registrarEvento({
      nivel: 'error',
      categoria: 'google_calendar',
      codigo: 'google_calendar_sync_error',
      mensaje: 'No se pudo sincronizar una reserva con Google Calendar',
      comercioId: contexto.comercio_id,
      reservaId,
      contexto: { motivo: String(e.message || e).slice(0, 300) }
    });
    return { ok: false, error: e.message };
  }
}

async function cancelarEventoReserva(pool, reservaId) {
  const contexto = await cargarContextoReserva(pool, reservaId);
  if (!contexto) return { skipped: true };

  const { comercio } = contexto;
  if (!tieneGoogleCalendar(comercio) || !contexto.google_calendar_event_id) {
    return { skipped: true };
  }

  try {
    const auth = crearClienteAutenticado(comercio, pool);
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.delete({
      calendarId: comercio.google_calendar_id || 'primary',
      eventId: contexto.google_calendar_event_id
    });

    await pool.query(
      `UPDATE reservas
       SET google_calendar_event_id=NULL,
           google_calendar_event_link=NULL,
           google_calendar_sync_error=NULL
       WHERE id=$1`,
      [reservaId]
    );

    return { ok: true };
  } catch (e) {
    if (e.code === 404 || e.status === 404) {
      await pool.query(
        `UPDATE reservas
         SET google_calendar_event_id=NULL,
             google_calendar_event_link=NULL,
             google_calendar_sync_error=NULL
         WHERE id=$1`,
        [reservaId]
      );

      return { ok: true };
    }

    await pool.query(
      `UPDATE reservas
       SET google_calendar_sync_error=$1
       WHERE id=$2`,
      [String(e.message || e).slice(0, 500), reservaId]
    );

    console.error('No se pudo cancelar evento de Google Calendar:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  GOOGLE_SCOPES,
  getGoogleRedirectUri,
  generarUrlAutorizacionGoogle,
  intercambiarCodigoGoogle,
  sincronizarReservaConfirmada,
  cancelarEventoReserva
};
