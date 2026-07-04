const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const { enviarConfirmacionReserva } = require('../services/whatsapp');

const FORMAS_PAGO = new Set(['local', 'online', 'sena']);

// GET /api/p/:slug - datos publicos del comercio
router.get('/:slug', async (req, res) => {
  try {
    const c = await pool.query(
      'SELECT id,slug,nombre,slogan,descripcion,telefono,whatsapp,email_contacto,direccion,instagram_url,logo_url,imagen_fondo_url,color_acento,color_fondo,moneda,duracion_turno_min FROM comercios WHERE slug=$1 AND activo=true',
      [req.params.slug]
    );

    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const cid = c.rows[0].id;
    const [servicios, horarios, bloques, trabajadores, ubicaciones] = await Promise.all([
      pool.query('SELECT id,nombre,descripcion,precio,duracion_min,imagen_url,trabajador_id,requiere_sena,sena_tipo,sena_valor FROM servicios WHERE comercio_id=$1 AND activo=true ORDER BY orden,id', [cid]),
      pool.query('SELECT dia_semana,abre,cierra FROM horarios WHERE comercio_id=$1 AND activo=true ORDER BY dia_semana', [cid]),
      pool.query('SELECT dia_semana,abre,cierra,orden FROM horario_bloques WHERE comercio_id=$1 ORDER BY dia_semana,orden', [cid]),
      pool.query('SELECT id,nombre,descripcion,foto_url FROM trabajadores WHERE comercio_id=$1 AND activo=true ORDER BY orden,id', [cid]),
      pool.query('SELECT id,nombre,direccion,telefono,whatsapp,principal FROM ubicaciones WHERE comercio_id=$1 AND activo=true ORDER BY principal DESC, orden, id', [cid])
    ]);

    res.json({
      ...c.rows[0],
      servicios: servicios.rows,
      horarios: horarios.rows,
      horario_bloques: bloques.rows,
      trabajadores: trabajadores.rows,
      ubicaciones: ubicaciones.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function fechaHoraMsUY(fecha, hora) {
  const [y, mo, d] = String(fecha).split('-').map(Number);
  const [h, mi] = String(hora).slice(0, 5).split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
}

function ahoraMsUY() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date()).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute)
  );
}

function normalizarTelefono(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function generarCodigoCliente() {
  return `CL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

async function upsertCliente(client, comercioId, datos) {
  const whatsapp = normalizarTelefono(datos.whatsapp);

  if (!whatsapp) return null;

  const existente = await client.query(
    'SELECT id,codigo FROM clientes WHERE comercio_id=$1 AND whatsapp=$2 LIMIT 1',
    [comercioId, whatsapp]
  );

  if (existente.rows[0]) {
    const actualizado = await client.query(
      `UPDATE clientes
       SET nombre=$1, apellido=$2, email=$3, actualizado_en=NOW()
       WHERE id=$4 AND comercio_id=$5
       RETURNING *`,
      [datos.nombre, datos.apellido || '', datos.email || null, existente.rows[0].id, comercioId]
    );

    return actualizado.rows[0];
  }

  for (let i = 0; i < 5; i++) {
    try {
      const creado = await client.query(
        `INSERT INTO clientes (comercio_id,codigo,nombre,apellido,whatsapp,email)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [comercioId, generarCodigoCliente(), datos.nombre, datos.apellido || '', whatsapp, datos.email || null]
      );

      return creado.rows[0];
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }

  throw new Error('No se pudo generar un codigo unico para el cliente');
}

function calcularSena(servicio) {
  if (servicio.requiere_sena !== true && servicio.requiere_sena !== 'true') return 0;

  const valor = Number(servicio.sena_valor || 0);
  const precio = Number(servicio.precio || 0);

  if (valor <= 0) return 0;

  if (servicio.sena_tipo === 'porcentaje') {
    return Math.round((precio * valor / 100) * 100) / 100;
  }

  return Math.round(valor * 100) / 100;
}

function escapeICS(valor) {
  return String(valor || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function formatearFechaICSLocal(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}T${hh}${mm}00`;
}

function fechaHoraICS(fecha, hora) {
  const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  const [hh, mm] = String(hora || '00:00').slice(0, 5).split(':').map(Number);
  return formatearFechaICSLocal(new Date(y, m - 1, d, hh, mm));
}

function sumarMinutosHoraICS(fecha, hora, minutos) {
  const [y, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  const [hh, mm] = String(hora || '00:00').slice(0, 5).split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm);
  dt.setMinutes(dt.getMinutes() + Number(minutos || 30));
  return formatearFechaICSLocal(dt);
}

router.get('/:slug/calendario.ics', async (req, res) => {
  try {
    const comercioRes = await pool.query(
      'SELECT id,nombre,calendar_token FROM comercios WHERE slug=$1 AND activo=true',
      [req.params.slug]
    );

    const comercio = comercioRes.rows[0];

    if (!comercio || !comercio.calendar_token || req.query.token !== comercio.calendar_token) {
      return res.status(404).send('Calendario no disponible');
    }

    const reservas = await pool.query(
      `SELECT r.*, s.nombre AS servicio_nombre, t.nombre AS trabajador_nombre, u.nombre AS ubicacion_nombre, u.direccion AS ubicacion_direccion
       FROM reservas r
       JOIN servicios s ON s.id=r.servicio_id
       LEFT JOIN trabajadores t ON t.id=r.trabajador_id
       LEFT JOIN ubicaciones u ON u.id=r.ubicacion_id
       WHERE r.comercio_id=$1
         AND r.estado IN ('pendiente','confirmada')
         AND r.fecha >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY r.fecha ASC, r.hora ASC`,
      [comercio.id]
    );

    const ahora = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const eventos = reservas.rows.map(r => {
      const titulo = `${r.servicio_nombre} - ${r.cliente_nombre} ${r.cliente_apellido || ''}`.trim();
      const descripcion = [
        `Cliente: ${r.cliente_nombre} ${r.cliente_apellido || ''}`.trim(),
        `WhatsApp: ${r.cliente_whatsapp || ''}`,
        r.trabajador_nombre ? `Profesional: ${r.trabajador_nombre}` : '',
        `Estado: ${r.estado}`
      ].filter(Boolean).join('\\n');

      return [
        'BEGIN:VEVENT',
        `UID:${r.uuid}@agendate`,
        `DTSTAMP:${ahora}`,
        `DTSTART:${fechaHoraICS(r.fecha, r.hora)}`,
        `DTEND:${sumarMinutosHoraICS(r.fecha, r.hora, r.duracion_min)}`,
        `SUMMARY:${escapeICS(titulo)}`,
        `DESCRIPTION:${escapeICS(descripcion)}`,
        r.ubicacion_direccion ? `LOCATION:${escapeICS(r.ubicacion_direccion)}` : '',
        'END:VEVENT'
      ].filter(Boolean).join('\r\n');
    }).join('\r\n');

    const ics = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'PRODID:-//Agendate//Reservas//ES',
  'X-WR-TIMEZONE:America/Montevideo',
  'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
  'X-PUBLISHED-TTL:PT30M',
  `X-WR-CALNAME:${escapeICS(comercio.nombre)} - Reservas`,
  eventos,
  'END:VCALENDAR'
].filter(Boolean).join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.slug}-reservas.ics"`);
    res.send(ics);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

async function existeBloqueoDisponibilidad(client, comercioId, trabajadorId, fecha, hora) {
  const params = [comercioId, fecha];
  let query = `
    SELECT id, motivo
    FROM disponibilidad_bloqueos
    WHERE comercio_id=$1
      AND activo=true
      AND fecha_desde <= $2
      AND fecha_hasta >= $2
  `;

  if (trabajadorId) {
    params.push(trabajadorId);
    query += ` AND (trabajador_id IS NULL OR trabajador_id=$${params.length})`;
  } else {
    query += ` AND trabajador_id IS NULL`;
  }

  if (hora) {
    params.push(hora);
    query += `
      AND (
        tipo IN ('dia','rango')
        OR hora_desde IS NULL
        OR hora_hasta IS NULL
        OR ($${params.length}::time >= hora_desde AND $${params.length}::time < hora_hasta)
      )
    `;
  }

  query += ' LIMIT 1';

  const r = await client.query(query, params);
  return r.rows[0] || null;
}

// GET /api/p/:slug/disponibilidad?fecha=YYYY-MM-DD&servicio_id=N&trabajador_id=N
router.get('/:slug/disponibilidad', async (req, res) => {
  try {
    const { fecha, servicio_id, trabajador_id } = req.query;
    if (!fecha || !servicio_id) return res.status(400).json({ error: 'Faltan parametros' });

    const c = await pool.query('SELECT id, anticipacion_reserva_min FROM comercios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const cid = c.rows[0].id;

    const servicio = await pool.query('SELECT duracion_min,trabajador_id FROM servicios WHERE id=$1 AND comercio_id=$2 AND activo=true', [servicio_id, cid]);
    if (!servicio.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    const duracion = servicio.rows[0].duracion_min;

    let trabajadorId = servicio.rows[0].trabajador_id || null;

    if (trabajador_id) {
      if (trabajadorId && Number(trabajador_id) !== Number(trabajadorId)) {
        return res.status(400).json({ error: 'Ese servicio no pertenece al profesional elegido' });
      }

      const trabajador = await pool.query(
        'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajador_id, cid]
      );

      if (!trabajador.rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });

      trabajadorId = trabajador.rows[0].id;
    }

    const fechaObj = new Date(fecha + 'T12:00:00');
    const diaSemana = fechaObj.getDay();

    let bloques;

    if (trabajadorId) {
      bloques = await pool.query(
        `SELECT abre,cierra
         FROM trabajador_horario_bloques
         WHERE trabajador_id=$1 AND comercio_id=$2 AND dia_semana=$3
         ORDER BY orden`,
        [trabajadorId, cid, diaSemana]
      );
    }

    if (!bloques || !bloques.rows.length) {
      bloques = await pool.query(
        'SELECT abre,cierra FROM horario_bloques WHERE comercio_id=$1 AND dia_semana=$2 ORDER BY orden',
        [cid, diaSemana]
      );
    }

    const toMin = t => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };

    const toStr = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    let slots = [];

    if (bloques.rows.length > 0) {
      for (const bloque of bloques.rows) {
        const abre = toMin(bloque.abre);
        const cierra = toMin(bloque.cierra);
        for (let m = abre; m + duracion <= cierra; m += duracion) slots.push(toStr(m));
      }
    } else {
      const horario = await pool.query(
        'SELECT abre,cierra FROM horarios WHERE comercio_id=$1 AND dia_semana=$2 AND activo=true',
        [cid, diaSemana]
      );

      if (!horario.rows[0]) return res.json({ horas: [], mensaje: 'Dia cerrado' });

      const abre = toMin(horario.rows[0].abre);
      const cierra = toMin(horario.rows[0].cierra);
      for (let m = abre; m + duracion <= cierra; m += duracion) slots.push(toStr(m));
    }

    if (!slots.length) return res.json({ horas: [], mensaje: 'Dia cerrado' });

    let ocupadasQuery = `
      SELECT hora::text, duracion_min
      FROM reservas
      WHERE comercio_id=$1 AND fecha=$2 AND estado!='cancelada'
    `;

    const ocupadasParams = [cid, fecha];

    if (trabajadorId) {
      ocupadasParams.push(trabajadorId);
      ocupadasQuery += ` AND trabajador_id=$${ocupadasParams.length}`;
    }

    const ocupadas = await pool.query(ocupadasQuery, ocupadasParams);
    const ocupadasSet = new Set();

    for (const r of ocupadas.rows) {
      const inicio = toMin(r.hora.slice(0, 5));
      for (let m = inicio; m < inicio + r.duracion_min; m += duracion) ocupadasSet.add(toStr(m));
    }

    const bloqueosParams = [cid, fecha];
    let bloqueosQuery = `
      SELECT tipo, hora_desde::text AS hora_desde, hora_hasta::text AS hora_hasta
      FROM disponibilidad_bloqueos
      WHERE comercio_id=$1
        AND activo=true
        AND fecha_desde <= $2
        AND fecha_hasta >= $2
    `;

    if (trabajadorId) {
      bloqueosParams.push(trabajadorId);
      bloqueosQuery += ` AND (trabajador_id IS NULL OR trabajador_id=$${bloqueosParams.length})`;
    } else {
      bloqueosQuery += ' AND trabajador_id IS NULL';
    }

    const bloqueos = await pool.query(bloqueosQuery, bloqueosParams);

    const slotBloqueado = horaSlot => bloqueos.rows.some(b => {
      if (b.tipo !== 'horario' || !b.hora_desde || !b.hora_hasta) return true;

      const inicio = toMin(horaSlot);
      const desde = toMin(b.hora_desde.slice(0, 5));
      const hasta = toMin(b.hora_hasta.slice(0, 5));

      return inicio >= desde && inicio < hasta;
    });

    const anticipacionMin = Number(c.rows[0].anticipacion_reserva_min || 0);
    const limiteMs = ahoraMsUY() + anticipacionMin * 60000;

    const disponibles = slots.filter(s => {
      if (ocupadasSet.has(s)) return false;
      if (slotBloqueado(s)) return false;
      return fechaHoraMsUY(fecha, s) >= limiteMs;
    });
    res.json({ horas: disponibles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const validarReservaPublica = [
  param('slug')
    .trim()
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug de comercio invalido'),

  body('servicio_id')
    .isInt({ min: 1 })
    .withMessage('Servicio invalido')
    .toInt(),

  body('trabajador_id')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('Trabajador invalido')
    .toInt(),

  body('fecha')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Fecha invalida'),

  body('hora')
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('Hora invalida'),

  body('nombre')
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('El nombre debe tener entre 2 y 80 caracteres')
    .escape(),

  body('apellido')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 80 })
    .withMessage('El apellido no puede superar 80 caracteres')
    .escape(),

  body('whatsapp')
    .trim()
    .matches(/^[0-9+\s()-]{6,25}$/)
    .withMessage('WhatsApp invalido'),

  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage('Email invalido')
    .normalizeEmail(),

  body('comentarios')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Los comentarios no pueden superar 500 caracteres')
    .escape()
];

// POST /api/p/:slug/reservar
router.post('/:slug/reservar', validarReservaPublica, async (req, res) => {
  const errores = validationResult(req);

  if (!errores.isEmpty()) {
    return res.status(400).json({
      error: 'Revisa los datos de la reserva',
      detalles: errores.array().map(e => e.msg)
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const c = await client.query('SELECT * FROM comercios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!c.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }
    const comercio = c.rows[0];

    const { servicio_id, trabajador_id, ubicacion_id, fecha, hora, nombre, apellido, whatsapp, email, comentarios, forma_pago } = req.body;

    const anticipacionMin = Number(comercio.anticipacion_reserva_min || 0);
    const limiteMs = ahoraMsUY() + anticipacionMin * 60000;

    if (fechaHoraMsUY(fecha, hora) < limiteMs) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: anticipacionMin > 0
          ? `Las reservas deben hacerse con al menos ${anticipacionMin} minutos de anticipacion.`
          : 'No se puede reservar un horario pasado.'
      });
    }

    const servicio = await client.query('SELECT * FROM servicios WHERE id=$1 AND comercio_id=$2 AND activo=true', [servicio_id, comercio.id]);
    if (!servicio.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    let trabajadorId = servicio.rows[0].trabajador_id || null;
    let trabajadorNombre = null;
    let ubicacionId = null;

    if (ubicacion_id) {
      const ubicacion = await client.query(
        'SELECT id FROM ubicaciones WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [ubicacion_id, comercio.id]
      );

      if (!ubicacion.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Ubicacion no encontrada' });
      }

      ubicacionId = ubicacion.rows[0].id;
    }

    if (trabajador_id) {
      if (trabajadorId && Number(trabajador_id) !== Number(trabajadorId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Ese servicio no pertenece al profesional elegido' });
      }

      const trabajador = await client.query(
        'SELECT id,nombre FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajador_id, comercio.id]
      );

      if (!trabajador.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Trabajador no encontrado' });
      }

      trabajadorId = trabajador.rows[0].id;
      trabajadorNombre = trabajador.rows[0].nombre;
    }

    if (trabajadorId && !trabajadorNombre) {
      const trabajador = await client.query(
        'SELECT nombre FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajadorId, comercio.id]
      );
      trabajadorNombre = trabajador.rows[0]?.nombre || null;
    }

    const bloqueo = await existeBloqueoDisponibilidad(client, comercio.id, trabajadorId, fecha, hora);

    if (bloqueo) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: bloqueo.motivo
          ? `Ese horario está bloqueado: ${bloqueo.motivo}`
          : 'Ese horario no está disponible.'
      });
    }

    let ocupadaQuery = `
      SELECT id
      FROM reservas
      WHERE comercio_id=$1 AND fecha=$2 AND hora=$3 AND estado!='cancelada'
    `;

    const ocupadaParams = [comercio.id, fecha, hora];

    if (trabajadorId) {
      ocupadaParams.push(trabajadorId);
      ocupadaQuery += ` AND trabajador_id=$${ocupadaParams.length}`;
    }

    const ocupada = await client.query(ocupadaQuery, ocupadaParams);

    if (ocupada.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya fue reservado. Por favor elegi otro.' });
    }

    const uuid = uuidv4();
    const cliente = await upsertCliente(client, comercio.id, {
      nombre,
      apellido,
      whatsapp,
      email
    });

    const formaPagoFinal = FORMAS_PAGO.has(forma_pago) ? forma_pago : 'local';
    const senaMonto = calcularSena(servicio.rows[0]);
    const estadoPagoFinal = formaPagoFinal === 'online'
      ? 'pagado'
      : (formaPagoFinal === 'sena' && senaMonto > 0 ? 'parcial' : 'pendiente');

    const r = await client.query(
      `INSERT INTO reservas (
         uuid,comercio_id,cliente_id,ubicacion_id,servicio_id,trabajador_id,fecha,hora,duracion_min,
         cliente_nombre,cliente_apellido,cliente_whatsapp,cliente_email,comentarios,
         forma_pago,estado_pago,sena_monto
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        uuid,
        comercio.id,
        cliente?.id || null,
        ubicacionId,
        servicio_id,
        trabajadorId,
        fecha,
        hora,
        servicio.rows[0].duracion_min,
        nombre,
        apellido,
        normalizarTelefono(whatsapp),
        email || null,
        comentarios || null,
        formaPagoFinal,
        estadoPagoFinal,
        senaMonto
      ]
    );

    await client.query('COMMIT');

           if (comercio.auto_confirmacion_activa !== false) {
      enviarConfirmacionReserva({
        reserva: r.rows[0],
        comercio,
        servicio: servicio.rows[0],
        profesional: trabajadorNombre ? { id: trabajadorId, nombre: trabajadorNombre } : null
      })
        .then(() => {
          return pool.query(
            `UPDATE reservas
             SET confirmacion_enviada=true,
                 confirmacion_enviada_en=NOW()
             WHERE id=$1`,
            [r.rows[0].id]
          );
        })
              .catch(err => {
          console.error('No se pudo enviar confirmación WhatsApp:', err.message);
        });
    }

    res.status(201).json({
      ok: true,
      uuid,
      reserva: {

        fecha,
        hora,
        trabajador: trabajadorNombre,
        servicio: servicio.rows[0].nombre,
        precio: servicio.rows[0].precio,
        forma_pago: formaPagoFinal,
        estado_pago: estadoPagoFinal,
        sena_monto: senaMonto
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/p/reservas/:uuid - ver reserva publica para cancelar
router.get('/reservas/:uuid', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT
        r.uuid,
        r.fecha,
        r.hora::text AS hora,
        r.estado,
        r.cliente_nombre,
        r.cliente_apellido,
        c.nombre AS comercio_nombre,
        c.slug AS comercio_slug,
        c.whatsapp AS comercio_whatsapp,
        c.anticipacion_cancelacion_min,
        s.nombre AS servicio_nombre,
        s.precio,
        s.duracion_min,
        t.nombre AS profesional_nombre
       FROM reservas r
       JOIN comercios c ON c.id = r.comercio_id
       JOIN servicios s ON s.id = r.servicio_id
       LEFT JOIN trabajadores t ON t.id = r.trabajador_id
       WHERE r.uuid=$1
       LIMIT 1`,
      [req.params.uuid]
    );

    if (!r.rows[0]) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/p/reservas/:uuid/cancelar - cancelar reserva publica
router.post('/reservas/:uuid/cancelar', async (req, res) => {
  try {
    const actual = await pool.query(
      `SELECT
        r.id,
        r.estado,
        r.fecha,
        r.hora::text AS hora,
        c.anticipacion_cancelacion_min
       FROM reservas r
       JOIN comercios c ON c.id = r.comercio_id
       WHERE r.uuid=$1
       LIMIT 1`,
      [req.params.uuid]
    );

    if (!actual.rows[0]) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    if (actual.rows[0].estado === 'cancelada') {
      return res.json({ ok: true, mensaje: 'La reserva ya estaba cancelada' });
    }

    if (actual.rows[0].estado === 'completada') {
      return res.status(400).json({ error: 'No se puede cancelar una reserva completada' });
    }

    const anticipacionMin = Number(actual.rows[0].anticipacion_cancelacion_min || 0);
    const limiteMs = ahoraMsUY() + anticipacionMin * 60000;

    if (fechaHoraMsUY(actual.rows[0].fecha, actual.rows[0].hora) < limiteMs) {
      return res.status(400).json({
        error: anticipacionMin > 0
          ? `Las cancelaciones deben hacerse con al menos ${anticipacionMin} minutos de anticipacion.`
          : 'No se puede cancelar una reserva pasada.'
      });
    }

    const r = await pool.query(
      `UPDATE reservas
       SET estado='cancelada',
           cancelada_por_cliente_en=NOW()
       WHERE id=$1
       RETURNING uuid, estado`,
      [actual.rows[0].id]
    );

    res.json({ ok: true, reserva: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
