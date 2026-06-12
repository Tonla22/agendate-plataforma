const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');

// GET /api/p/:slug — datos públicos del comercio (sin autenticación)
router.get('/:slug', async (req, res) => {
  try {
    const c = await pool.query(
      'SELECT id,slug,nombre,slogan,descripcion,telefono,whatsapp,email_contacto,direccion,instagram_url,logo_url,imagen_fondo_url,color_acento,color_fondo,moneda,duracion_turno_min FROM comercios WHERE slug=$1 AND activo=true',
      [req.params.slug]
    );
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    const cid = c.rows[0].id;
    const [servicios, horarios, bloques] = await Promise.all([
      pool.query('SELECT id,nombre,descripcion,precio,duracion_min,imagen_url FROM servicios WHERE comercio_id=$1 AND activo=true ORDER BY orden,id', [cid]),
      pool.query('SELECT dia_semana,abre,cierra FROM horarios WHERE comercio_id=$1 AND activo=true ORDER BY dia_semana', [cid]),
      pool.query('SELECT dia_semana,abre,cierra,orden FROM horario_bloques WHERE comercio_id=$1 ORDER BY dia_semana,orden', [cid])
    ]);
    res.json({ ...c.rows[0], servicios: servicios.rows, horarios: horarios.rows, horario_bloques: bloques.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/p/:slug/disponibilidad?fecha=YYYY-MM-DD&servicio_id=N
router.get('/:slug/disponibilidad', async (req, res) => {
  try {
    const { fecha, servicio_id } = req.query;
    if (!fecha || !servicio_id) return res.status(400).json({ error: 'Faltan parámetros' });

    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const cid = c.rows[0].id;

    const servicio = await pool.query('SELECT duracion_min FROM servicios WHERE id=$1 AND comercio_id=$2', [servicio_id, cid]);
    if (!servicio.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
    const duracion = servicio.rows[0].duracion_min;

    // Obtener día de la semana (0=Dom ... 6=Sáb)
    const fechaObj = new Date(fecha + 'T12:00:00');
    const diaSemana = fechaObj.getDay();

    // Verificar si tiene bloques de horario (con descansos)
    const bloques = await pool.query(
      'SELECT abre,cierra FROM horario_bloques WHERE comercio_id=$1 AND dia_semana=$2 ORDER BY orden',
      [cid, diaSemana]
    );

    const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
    const toStr = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

    let slots = [];

    if (bloques.rows.length > 0) {
      // Usar bloques (horario con descansos)
      for (const bloque of bloques.rows) {
        const abre = toMin(bloque.abre);
        const cierra = toMin(bloque.cierra);
        for (let m = abre; m + duracion <= cierra; m += duracion) slots.push(toStr(m));
      }
    } else {
      // Fallback al horario simple
      const horario = await pool.query(
        'SELECT abre,cierra FROM horarios WHERE comercio_id=$1 AND dia_semana=$2 AND activo=true',
        [cid, diaSemana]
      );
      if (!horario.rows[0]) return res.json({ horas: [], mensaje: 'Día cerrado' });
      const abre = toMin(horario.rows[0].abre);
      const cierra = toMin(horario.rows[0].cierra);
      for (let m = abre; m + duracion <= cierra; m += duracion) slots.push(toStr(m));
    }

    if (!slots.length) return res.json({ horas: [], mensaje: 'Día cerrado' });

    // Quitar slots ya ocupados
    const ocupadas = await pool.query(
      `SELECT hora::text, duracion_min FROM reservas WHERE comercio_id=$1 AND fecha=$2 AND estado!='cancelada'`,
      [cid, fecha]
    );
    const ocupadasSet = new Set();
    for (const r of ocupadas.rows) {
      const inicio = toMin(r.hora.slice(0,5));
      for (let m = inicio; m < inicio + r.duracion_min; m += duracion) ocupadasSet.add(toStr(m));
    }

    const disponibles = slots.filter(s => !ocupadasSet.has(s));
    res.json({ horas: disponibles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const validarReservaPublica = [
  param('slug')
    .trim()
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug de comercio inválido'),

  body('servicio_id')
    .isInt({ min: 1 })
    .withMessage('Servicio inválido')
    .toInt(),

  body('fecha')
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Fecha inválida'),

  body('hora')
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('Hora inválida'),

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
    .withMessage('WhatsApp inválido'),

  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage('Email inválido')
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
      error: 'Revisá los datos de la reserva',
      detalles: errores.array().map(e => e.msg)
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT * FROM comercios WHERE slug=$1 AND activo=true', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    const comercio = c.rows[0];

    const { servicio_id, fecha, hora, nombre, apellido, whatsapp, email, comentarios } = req.body;

    // Verificar que el slot sigue disponible
    const ocupada = await client.query(
      `SELECT id FROM reservas WHERE comercio_id=$1 AND fecha=$2 AND hora=$3 AND estado!='cancelada'`,
      [comercio.id, fecha, hora]
    );
    if (ocupada.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya fue reservado. Por favor elegí otro.' });
    }

    const servicio = await client.query('SELECT * FROM servicios WHERE id=$1 AND comercio_id=$2', [servicio_id, comercio.id]);
    if (!servicio.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Servicio no encontrado' }); }

    const uuid = uuidv4();
    const r = await client.query(`
      INSERT INTO reservas (uuid,comercio_id,servicio_id,fecha,hora,duracion_min,cliente_nombre,cliente_apellido,cliente_whatsapp,cliente_email,comentarios)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [uuid, comercio.id, servicio_id, fecha, hora, servicio.rows[0].duracion_min, nombre, apellido, whatsapp, email||null, comentarios||null]
    );

    await client.query('COMMIT');

    // Disparar webhook si está configurado (async, no bloqueamos)
    if (comercio.webhook_url) {
      const payload = {
        evento: 'nueva_reserva', uuid,
        comercio: { nombre: comercio.nombre, slug: comercio.slug },
        servicio: servicio.rows[0].nombre, precio: servicio.rows[0].precio,
        fecha, hora, duracion_min: servicio.rows[0].duracion_min,
        cliente: { nombre: `${nombre} ${apellido}`, whatsapp, email: email||null },
        comentarios: comentarios||null
      };
      fetch(comercio.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    }

    res.status(201).json({
      ok: true, uuid,
      reserva: { fecha, hora, servicio: servicio.rows[0].nombre, precio: servicio.rows[0].precio }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
