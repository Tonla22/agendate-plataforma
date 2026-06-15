const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');

// GET /api/p/:slug - datos publicos del comercio
router.get('/:slug', async (req, res) => {
  try {
    const c = await pool.query(
      'SELECT id,slug,nombre,slogan,descripcion,telefono,whatsapp,email_contacto,direccion,instagram_url,logo_url,imagen_fondo_url,color_acento,color_fondo,moneda,duracion_turno_min FROM comercios WHERE slug=$1 AND activo=true',
      [req.params.slug]
    );

    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const cid = c.rows[0].id;
    const [servicios, horarios, bloques, trabajadores] = await Promise.all([
      pool.query('SELECT id,nombre,descripcion,precio,duracion_min,imagen_url,trabajador_id FROM servicios WHERE comercio_id=$1 AND activo=true ORDER BY orden,id', [cid]),
      pool.query('SELECT dia_semana,abre,cierra FROM horarios WHERE comercio_id=$1 AND activo=true ORDER BY dia_semana', [cid]),
      pool.query('SELECT dia_semana,abre,cierra,orden FROM horario_bloques WHERE comercio_id=$1 ORDER BY dia_semana,orden', [cid]),
      pool.query('SELECT id,nombre,descripcion,foto_url FROM trabajadores WHERE comercio_id=$1 AND activo=true ORDER BY orden,id', [cid])
    ]);

    res.json({
      ...c.rows[0],
      servicios: servicios.rows,
      horarios: horarios.rows,
      horario_bloques: bloques.rows,
      trabajadores: trabajadores.rows
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

    const anticipacionMin = Number(c.rows[0].anticipacion_reserva_min || 0);
    const limiteMs = ahoraMsUY() + anticipacionMin * 60000;

    const disponibles = slots.filter(s => {
      if (ocupadasSet.has(s)) return false;
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

    const { servicio_id, trabajador_id, fecha, hora, nombre, apellido, whatsapp, email, comentarios } = req.body;

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
    const r = await client.query(
      `INSERT INTO reservas (uuid,comercio_id,servicio_id,trabajador_id,fecha,hora,duracion_min,cliente_nombre,cliente_apellido,cliente_whatsapp,cliente_email,comentarios)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [uuid, comercio.id, servicio_id, trabajadorId, fecha, hora, servicio.rows[0].duracion_min, nombre, apellido, whatsapp, email || null, comentarios || null]
    );

    await client.query('COMMIT');

    if (comercio.webhook_url) {
      const payload = {
        evento: 'nueva_reserva',
        uuid,
        comercio: { nombre: comercio.nombre, slug: comercio.slug },
        servicio: servicio.rows[0].nombre,
        trabajador: trabajadorNombre,
        precio: servicio.rows[0].precio,
        fecha,
        hora,
        duracion_min: servicio.rows[0].duracion_min,
        cliente: { nombre: `${nombre} ${apellido}`, whatsapp, email: email || null },
        comentarios: comentarios || null
      };

      fetch(comercio.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    }

    res.status(201).json({
      ok: true,
      uuid,
      reserva: {
        fecha,
        hora,
        trabajador: trabajadorNombre,
        servicio: servicio.rows[0].nombre,
        precio: servicio.rows[0].precio
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
