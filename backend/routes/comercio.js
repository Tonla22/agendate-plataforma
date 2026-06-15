const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authAdminOrComercio } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadImagen = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
      return cb(null, true);
    }

    cb(new Error('Solo se permiten imÃ¡genes JPG, PNG, WEBP o GIF'));
  }
});

function subirBufferACloudinary(buffer, slug) {
  return new Promise((resolve, reject) => {
    const safeSlug = String(slug || 'comercio')
      .replace(/[^a-z0-9_-]/gi, '')
      .toLowerCase();

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `agendate/${safeSlug}`,
        resource_type: 'image'
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    uploadStream.end(buffer);
  });
}

function urlCloudinaryOptimizada(result, tipo) {
  if (tipo === 'fondo') {
    return cloudinary.url(result.public_id, {
      secure: true,
      transformation: [
        { width: 1920, crop: 'limit', quality: 'auto:best', fetch_format: 'auto' }
      ]
    });
  }

  if (tipo === 'logo') {
    return cloudinary.url(result.public_id, {
      secure: true,
      transformation: [
        { width: 900, crop: 'limit', quality: 'auto:best', fetch_format: 'png' }
      ]
    });
  }

  return result.secure_url;
}

function revisarValidacion(req, res, next) {
  const errores = validationResult(req);

  if (!errores.isEmpty()) {
    return res.status(400).json({
      error: 'RevisÃ¡ los datos enviados',
      detalles: errores.array().map(e => e.msg)
    });
  }

  next();
}

const validarSlug = [
  param('slug')
    .trim()
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug invÃ¡lido')
];

const validarPerfilComercio = [
  ...validarSlug,

  body('anticipacion_reserva_min')
    .optional({ checkFalsy: true })
    .isInt({ min: 0, max: 10080 })
    .withMessage('La anticipacion para reservar debe estar entre 0 y 10080 minutos')
    .toInt(),

  body('anticipacion_cancelacion_min')
    .optional({ checkFalsy: true })
    .isInt({ min: 0, max: 10080 })
    .withMessage('La anticipacion para cancelar debe estar entre 0 y 10080 minutos')
    .toInt(),

  body('logo_url')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Logo invalido'),

  body('nombre')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('El nombre debe tener entre 2 y 120 caracteres')
    .escape(),

  body('slogan')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('El slogan no puede superar 500 caracteres')
    .escape(),

  body('telefono')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[0-9+\s()-]{6,30}$/)
    .withMessage('TelÃ©fono invÃ¡lido'),

  body('whatsapp')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[0-9+\s()-]{6,30}$/)
    .withMessage('WhatsApp invÃ¡lido'),

  body('direccion')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('La direcciÃ³n no puede superar 200 caracteres')
    .escape(),

  body('instagram_url')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Instagram no puede superar 200 caracteres'),

  body('color_acento')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^#[0-9A-Fa-f]{6}$/)
    .withMessage('Color invÃ¡lido'),

  body('moneda')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 1, max: 6 })
    .withMessage('Moneda invÃ¡lida')
    .escape(),

  body('imagen_fondo_url')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Imagen de fondo invÃ¡lida')
];
const validarServicioComercio = [
  ...validarSlug,

  body('nombre')
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('El nombre del servicio debe tener entre 2 y 120 caracteres')
    .escape(),

  body('precio')
    .isFloat({ min: 0 })
    .withMessage('El precio debe ser un nÃºmero vÃ¡lido mayor o igual a 0')
    .toFloat(),

  body('duracion_min')
    .isInt({ min: 5, max: 720 })
    .withMessage('La duraciÃ³n debe estar entre 5 y 720 minutos')
    .toInt(),

  body('descripcion')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('La descripciÃ³n no puede superar 500 caracteres')
    .escape(),

  body('activo')
    .optional()
    .isBoolean()
    .withMessage('El estado activo debe ser verdadero o falso')
    .toBoolean(),

  body('imagen_url')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('La imagen del servicio es invÃ¡lida')
];
function horaAMinBackend(hora) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hora || ''))) {
    return null;
  }

  const [h, m] = String(hora).split(':').map(Number);
  return h * 60 + m;
}

function validarLogicaHorarios(req, res, next) {
  const horarios = req.body.horarios || [];

  for (const h of horarios) {
    if (!h.activo) continue;

    if (!Array.isArray(h.bloques) || h.bloques.length === 0) {
      return res.status(400).json({
        error: 'Cada dÃ­a activo debe tener al menos un bloque horario'
      });
    }

    const bloques = h.bloques
      .map(b => ({
        abre: b.abre,
        cierra: b.cierra,
        abreMin: horaAMinBackend(b.abre),
        cierraMin: horaAMinBackend(b.cierra)
      }))
      .sort((a, b) => a.abreMin - b.abreMin);

    for (let i = 0; i < bloques.length; i++) {
      const b = bloques[i];

      if (b.abreMin === null || b.cierraMin === null) {
        return res.status(400).json({
          error: 'Formato de horario invÃ¡lido. UsÃ¡ HH:MM'
        });
      }

      if (b.cierraMin <= b.abreMin) {
        return res.status(400).json({
          error: 'La hora de cierre debe ser mayor que la de apertura'
        });
      }

      if (i > 0 && b.abreMin < bloques[i - 1].cierraMin) {
        return res.status(400).json({
          error: 'Los bloques horarios no pueden superponerse'
        });
      }
    }
  }

  next();
}

const validarHorariosComercio = [
  ...validarSlug,

  body('horarios')
    .isArray({ min: 0, max: 7 })
    .withMessage('Horarios invÃ¡lidos'),

  body('horarios.*.dia_semana')
    .isInt({ min: 0, max: 6 })
    .withMessage('DÃ­a invÃ¡lido')
    .toInt(),

  body('horarios.*.activo')
    .isBoolean()
    .withMessage('El estado del dÃ­a debe ser verdadero o falso')
    .toBoolean(),

  body('horarios.*.bloques')
    .optional()
    .isArray({ max: 8 })
    .withMessage('Demasiados bloques para un dÃ­a'),

  body('horarios.*.bloques.*.abre')
    .optional()
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('Hora de apertura invÃ¡lida'),

  body('horarios.*.bloques.*.cierra')
    .optional()
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('Hora de cierre invÃ¡lida')
];
router.post('/:slug/upload-imagen', authAdminOrComercio, (req, res) => {
  uploadImagen.single('imagen')(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({
          error: err.message || 'No se pudo subir la imagen'
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'No se recibiÃ³ ninguna imagen'
        });
      }

      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        return res.status(500).json({
          error: 'Cloudinary no estÃ¡ configurado en el servidor'
        });
      }

      const tiposValidos = new Set(['fondo', 'logo']);
      const tipo = tiposValidos.has(req.body?.tipo) ? req.body.tipo : 'general';
      const resultado = await subirBufferACloudinary(req.file.buffer, req.params.slug);

      res.status(201).json({
        url: urlCloudinaryOptimizada(resultado, tipo)
      });
    } catch (e) {
      res.status(500).json({
        error: 'No se pudo subir la imagen a Cloudinary'
      });
    }
  });
});

// GET /api/comercio/:slug/perfil â€” datos del comercio (auth requerida)
router.get('/:slug/perfil', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    const servicios = await pool.query('SELECT * FROM servicios WHERE comercio_id=$1 AND activo=true', [c.rows[0].id]);
    const horarios = await pool.query('SELECT * FROM horarios WHERE comercio_id=$1 ORDER BY dia_semana', [c.rows[0].id]);
    const bloques = await pool.query('SELECT * FROM horario_bloques WHERE comercio_id=$1 ORDER BY dia_semana,orden', [c.rows[0].id]);
    res.json({ ...c.rows[0], servicios: servicios.rows, horarios: horarios.rows, horario_bloques: bloques.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/comercio/:slug/perfil â€” el dueÃ±o edita su perfil
router.put('/:slug/perfil', authAdminOrComercio, validarPerfilComercio, revisarValidacion, async (req, res) => {
  try {
    const campos = ['nombre','slogan','telefono','whatsapp','email_contacto',
      'direccion','anticipacion_reserva_min','anticipacion_cancelacion_min','instagram_url','color_acento','color_fondo','moneda','logo_url','imagen_fondo_url'];
    const sets = []; const vals = [];
    campos.forEach(c => {
      if (req.body[c] !== undefined) { sets.push(`${c}=$${sets.length+1}`); vals.push(req.body[c]); }
    });
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    sets.push(`actualizado_en=NOW()`);
    vals.push(req.params.slug);
    const r = await pool.query(`UPDATE comercios SET ${sets.join(',')} WHERE slug=$${vals.length} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/comercio/:slug/horarios â€” guardar horarios con soporte de bloques
router.put('/:slug/horarios', authAdminOrComercio, validarHorariosComercio, revisarValidacion, validarLogicaHorarios, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const cid = c.rows[0].id;
    await client.query('DELETE FROM horarios WHERE comercio_id=$1', [cid]);
    await client.query('DELETE FROM horario_bloques WHERE comercio_id=$1', [cid]);
    for (const h of req.body.horarios || []) {
      if (h.activo) {
        // Si tiene bloques, guardarlos en horario_bloques
        if (h.bloques && h.bloques.length > 0) {
          let orden = 0;
          for (const bloque of h.bloques) {
            if (bloque.abre && bloque.cierra) {
              await client.query(
                'INSERT INTO horario_bloques (comercio_id,dia_semana,abre,cierra,orden) VALUES ($1,$2,$3,$4,$5)',
                [cid, h.dia_semana, bloque.abre, bloque.cierra, orden++]
              );
            }
          }
          // Guardar tambiÃ©n en horarios el primer bloque (compatibilidad)
          const primerBloque = h.bloques.find(b => b.abre && b.cierra);
          if (primerBloque) {
            await client.query(
              'INSERT INTO horarios (comercio_id,dia_semana,abre,cierra,activo) VALUES ($1,$2,$3,$4,true)',
              [cid, h.dia_semana, primerBloque.abre, primerBloque.cierra]
            );
          }
        } else if (h.abre && h.cierra) {
          // Horario simple (sin descanso)
          await client.query(
            'INSERT INTO horarios (comercio_id,dia_semana,abre,cierra,activo) VALUES ($1,$2,$3,$4,true)',
            [cid, h.dia_semana, h.abre, h.cierra]
          );
        }
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// GET/POST/PUT/DELETE trabajadores
router.get('/:slug/trabajadores', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const r = await pool.query(
      'SELECT * FROM trabajadores WHERE comercio_id=$1 AND activo=true ORDER BY orden,id',
      [c.rows[0].id]
    );

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:slug/trabajadores', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const { nombre, descripcion, foto_url, orden } = req.body;

    if (!nombre || String(nombre).trim().length < 2) {
      return res.status(400).json({ error: 'El nombre del trabajador es obligatorio' });
    }

    const r = await pool.query(
      `INSERT INTO trabajadores (comercio_id,nombre,descripcion,foto_url,orden)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [c.rows[0].id, nombre.trim(), descripcion || null, foto_url || null, orden || 0]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:slug/trabajadores/:id', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const { nombre, descripcion, foto_url, activo, orden } = req.body;

    if (!nombre || String(nombre).trim().length < 2) {
      return res.status(400).json({ error: 'El nombre del trabajador es obligatorio' });
    }

    const r = await pool.query(
      `UPDATE trabajadores
       SET nombre=$1, descripcion=$2, foto_url=$3, activo=$4, orden=$5
       WHERE id=$6 AND comercio_id=$7
       RETURNING *`,
      [nombre.trim(), descripcion || null, foto_url || null, activo !== false, orden || 0, req.params.id, c.rows[0].id]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:slug/trabajadores/:id', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const r = await pool.query(
      'UPDATE trabajadores SET activo=false WHERE id=$1 AND comercio_id=$2 RETURNING id',
      [req.params.id, c.rows[0].id]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET/PUT horarios de un trabajador
router.get('/:slug/trabajadores/:id/horarios', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const trabajador = await pool.query(
      'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
      [req.params.id, c.rows[0].id]
    );

    if (!trabajador.rows[0]) return res.status(404).json({ error: 'Trabajador no encontrado' });

    const bloques = await pool.query(
      `SELECT dia_semana, abre, cierra, orden
       FROM trabajador_horario_bloques
       WHERE trabajador_id=$1 AND comercio_id=$2
       ORDER BY dia_semana, orden`,
      [req.params.id, c.rows[0].id]
    );

    res.json({ horario_bloques: bloques.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:slug/trabajadores/:id/horarios', authAdminOrComercio, validarHorariosComercio, revisarValidacion, validarLogicaHorarios, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const c = await client.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const cid = c.rows[0].id;

    const trabajador = await client.query(
      'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
      [req.params.id, cid]
    );

    if (!trabajador.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Trabajador no encontrado' });
    }

    await client.query(
      'DELETE FROM trabajador_horario_bloques WHERE trabajador_id=$1 AND comercio_id=$2',
      [req.params.id, cid]
    );

    for (const h of req.body.horarios || []) {
      if (!h.activo) continue;

      const bloques = h.bloques?.length
        ? h.bloques
        : [{ abre: h.abre, cierra: h.cierra }];

      for (let i = 0; i < bloques.length; i++) {
        await client.query(
          `INSERT INTO trabajador_horario_bloques (trabajador_id,comercio_id,dia_semana,abre,cierra,orden)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, cid, h.dia_semana, bloques[i].abre, bloques[i].cierra, i]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET/POST/PUT/DELETE servicios
router.get('/:slug/servicios', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const r = await pool.query('SELECT * FROM servicios WHERE comercio_id=$1 AND activo=true', [c.rows[0].id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:slug/servicios', authAdminOrComercio, validarServicioComercio, revisarValidacion, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const { nombre, descripcion, precio, duracion_min, orden, imagen_url } = req.body;
    const r = await pool.query(
      'INSERT INTO servicios (comercio_id,nombre,descripcion,precio,duracion_min,orden,imagen_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [c.rows[0].id, nombre, descripcion, precio, duracion_min, orden||0, imagen_url||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:slug/servicios/:id', authAdminOrComercio, validarServicioComercio, revisarValidacion, async (req, res) => {
  try {
    const { nombre, descripcion, precio, duracion_min, orden, activo, imagen_url } = req.body;
    const r = await pool.query(
      'UPDATE servicios SET nombre=$1,descripcion=$2,precio=$3,duracion_min=$4,orden=$5,activo=$6,imagen_url=$7 WHERE id=$8 RETURNING *',
      [nombre, descripcion, precio, duracion_min, orden||0, activo!==false, imagen_url||null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:slug/servicios/:id', authAdminOrComercio, async (req, res) => {
  try {
    const comercio = await pool.query(
      'SELECT id FROM comercios WHERE slug=$1',
      [req.params.slug]
    );

    if (!comercio.rows[0]) {
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const resultado = await pool.query(
      'UPDATE servicios SET activo=false WHERE id=$1 AND comercio_id=$2 RETURNING id',
      [req.params.id, comercio.rows[0].id]
    );

    if (!resultado.rows[0]) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/comercio/:slug/clientes
router.get('/:slug/clientes', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id, moneda FROM comercios WHERE slug=$1', [req.params.slug]);

    if (!c.rows[0]) {
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const comercio = c.rows[0];

    const clientes = await pool.query(`
      WITH base AS (
        SELECT
          r.cliente_whatsapp,
          MAX(TRIM(CONCAT(r.cliente_nombre, ' ', r.cliente_apellido))) AS nombre,
          MAX(r.cliente_email) AS email,
          COUNT(*) AS reservas_totales,
          COUNT(*) FILTER (WHERE r.estado='completada') AS reservas_completadas,
          MAX(r.fecha) AS ultima_visita,
          COALESCE(SUM(CASE WHEN r.estado='completada' THEN s.precio ELSE 0 END), 0) AS total_gastado
        FROM reservas r
        JOIN servicios s ON s.id = r.servicio_id
        WHERE r.comercio_id=$1
        GROUP BY r.cliente_whatsapp
      ),
      favoritos AS (
        SELECT DISTINCT ON (r.cliente_whatsapp)
          r.cliente_whatsapp,
          s.nombre AS servicio_favorito,
          COUNT(*) AS cantidad
        FROM reservas r
        JOIN servicios s ON s.id = r.servicio_id
        WHERE r.comercio_id=$1
          AND r.estado='completada'
        GROUP BY r.cliente_whatsapp, s.nombre
        ORDER BY r.cliente_whatsapp, COUNT(*) DESC
      )
      SELECT
        base.*,
        favoritos.servicio_favorito
      FROM base
      LEFT JOIN favoritos ON favoritos.cliente_whatsapp = base.cliente_whatsapp
      ORDER BY base.ultima_visita DESC
    `, [comercio.id]);

    res.json({
      moneda: comercio.moneda || '$',
      clientes: clientes.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/comercio/:slug/metricas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/:slug/metricas', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id, moneda FROM comercios WHERE slug=$1', [req.params.slug]);

    if (!c.rows[0]) {
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const comercio = c.rows[0];

    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10);
    const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10);

    const desde = req.query.desde || inicioMes;
    const hasta = req.query.hasta || finMes;

    const params = [comercio.id, desde, hasta];

    const resumen = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN r.estado='completada' THEN s.precio ELSE 0 END), 0) AS ingresos,
        COUNT(*) FILTER (WHERE r.estado='completada') AS completadas,
        COUNT(*) FILTER (WHERE r.estado='confirmada') AS confirmadas,
        COUNT(*) FILTER (WHERE r.estado='cancelada') AS canceladas,
        COUNT(*) AS total_reservas
      FROM reservas r
      JOIN servicios s ON s.id = r.servicio_id
      WHERE r.comercio_id=$1
        AND r.fecha >= $2
        AND r.fecha <= $3
    `, params);

    const hoyStr = new Date().toISOString().slice(0, 10);

    const hoyRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN r.estado='completada' THEN s.precio ELSE 0 END), 0) AS ingresos_hoy,
        COUNT(*) FILTER (WHERE r.estado='completada') AS completadas_hoy,
        COUNT(*) FILTER (WHERE r.estado='confirmada') AS confirmadas_hoy,
        COUNT(*) AS reservas_hoy
      FROM reservas r
      JOIN servicios s ON s.id = r.servicio_id
      WHERE r.comercio_id=$1
        AND r.fecha = $2
    `, [comercio.id, hoyStr]);

    const servicioTop = await pool.query(`
      SELECT s.nombre, COUNT(*) AS cantidad
      FROM reservas r
      JOIN servicios s ON s.id = r.servicio_id
      WHERE r.comercio_id=$1
        AND r.fecha >= $2
        AND r.fecha <= $3
        AND r.estado='completada'
      GROUP BY s.nombre
      ORDER BY cantidad DESC
      LIMIT 1
    `, params);

    const trabajadorTop = await pool.query(`
      SELECT COALESCE(t.nombre, 'Sin asignar') AS nombre, COUNT(*) AS cantidad
      FROM reservas r
      LEFT JOIN trabajadores t ON t.id = r.trabajador_id
      WHERE r.comercio_id=$1
        AND r.fecha >= $2
        AND r.fecha <= $3
        AND r.estado='completada'
      GROUP BY COALESCE(t.nombre, 'Sin asignar')
      ORDER BY cantidad DESC
      LIMIT 1
    `, params);

    const ultimosDias = await pool.query(`
      SELECT
        r.fecha::text AS fecha,
        COUNT(*) AS reservas,
        COALESCE(SUM(CASE WHEN r.estado='completada' THEN s.precio ELSE 0 END), 0) AS ingresos
      FROM reservas r
      JOIN servicios s ON s.id = r.servicio_id
      WHERE r.comercio_id=$1
        AND r.fecha >= (CURRENT_DATE - INTERVAL '6 days')
        AND r.fecha <= CURRENT_DATE
      GROUP BY r.fecha
      ORDER BY r.fecha ASC
    `, [comercio.id]);

    res.json({
      moneda: comercio.moneda || '$',
      desde,
      hasta,
      resumen: resumen.rows[0],
      hoy: hoyRes.rows[0],
      servicio_top: servicioTop.rows[0] || null,
      trabajador_top: trabajadorTop.rows[0] || null,
      ultimos_dias: ultimosDias.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/comercio/:slug/reservas
router.get('/:slug/reservas', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const { desde, hasta, estado, trabajador_id } = req.query;
    let q = `SELECT r.*, s.nombre as servicio_nombre, s.precio, t.nombre as trabajador_nombre
             FROM reservas r
             JOIN servicios s ON s.id=r.servicio_id
             LEFT JOIN trabajadores t ON t.id=r.trabajador_id
             WHERE r.comercio_id=$1`;
    const params = [c.rows[0].id];
    if (desde) { params.push(desde); q += ` AND r.fecha>=$${params.length}`; }
    if (trabajador_id) {
  params.push(trabajador_id);
  q += ` AND r.trabajador_id=$${params.length}`;
}
    if (hasta) { params.push(hasta); q += ` AND r.fecha<=$${params.length}`; }
    if (estado) { params.push(estado); q += ` AND r.estado=$${params.length}`; }
    q += ' ORDER BY r.fecha DESC, r.hora DESC';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/comercio/:slug/reservas/:id/estado
router.put('/:slug/reservas/:id/estado', authAdminOrComercio, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE reservas SET estado=$1 WHERE id=$2 RETURNING *',
      [req.body.estado, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
