const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authAdminOrComercio } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const uploadDir = path.join(__dirname, '..', 'uploads');

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const safeSlug = String(req.params.slug || 'comercio')
      .replace(/[^a-z0-9_-]/gi, '')
      .toLowerCase();

    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';

    cb(null, `${safeSlug}-${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
  }
});

const uploadImagen = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
      return cb(null, true);
    }

    cb(new Error('Solo se permiten imágenes JPG, PNG, WEBP o GIF'));
  }
});
function revisarValidacion(req, res, next) {
  const errores = validationResult(req);

  if (!errores.isEmpty()) {
    return res.status(400).json({
      error: 'Revisá los datos enviados',
      detalles: errores.array().map(e => e.msg)
    });
  }

  next();
}

const validarSlug = [
  param('slug')
    .trim()
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug inválido')
];

const validarPerfilComercio = [
  ...validarSlug,

  body('nombre')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('El nombre debe tener entre 2 y 120 caracteres')
    .escape(),

  body('slogan')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 180 })
    .withMessage('El slogan no puede superar 180 caracteres')
    .escape(),

  body('telefono')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[0-9+\s()-]{6,30}$/)
    .withMessage('Teléfono inválido'),

  body('whatsapp')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[0-9+\s()-]{6,30}$/)
    .withMessage('WhatsApp inválido'),

  body('direccion')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('La dirección no puede superar 200 caracteres')
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
    .withMessage('Color inválido'),

  body('moneda')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 1, max: 6 })
    .withMessage('Moneda inválida')
    .escape(),

  body('imagen_fondo_url')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Imagen de fondo inválida')
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
    .withMessage('El precio debe ser un número válido mayor o igual a 0')
    .toFloat(),

  body('duracion_min')
    .isInt({ min: 5, max: 720 })
    .withMessage('La duración debe estar entre 5 y 720 minutos')
    .toInt(),

  body('descripcion')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('La descripción no puede superar 500 caracteres')
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
    .withMessage('La imagen del servicio es inválida')
];
router.post('/:slug/upload-imagen', authAdminOrComercio, (req, res) => {
  uploadImagen.single('imagen')(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: err.message || 'No se pudo subir la imagen'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No se recibió ninguna imagen'
      });
    }

    res.status(201).json({
      url: `/uploads/${req.file.filename}`
    });
  });
});

// GET /api/comercio/:slug/perfil — datos del comercio (auth requerida)
router.get('/:slug/perfil', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    const servicios = await pool.query('SELECT * FROM servicios WHERE comercio_id=$1 ORDER BY orden,id', [c.rows[0].id]);
    const horarios = await pool.query('SELECT * FROM horarios WHERE comercio_id=$1 ORDER BY dia_semana', [c.rows[0].id]);
    const bloques = await pool.query('SELECT * FROM horario_bloques WHERE comercio_id=$1 ORDER BY dia_semana,orden', [c.rows[0].id]);
    res.json({ ...c.rows[0], servicios: servicios.rows, horarios: horarios.rows, horario_bloques: bloques.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/comercio/:slug/perfil — el dueño edita su perfil
router.put('/:slug/perfil', authAdminOrComercio, validarPerfilComercio, revisarValidacion, async (req, res) => {
  try {
    const campos = ['nombre','slogan','telefono','whatsapp','email_contacto',
      'direccion','instagram_url','color_acento','color_fondo','moneda','imagen_fondo_url'];
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

// PUT /api/comercio/:slug/horarios — guardar horarios con soporte de bloques
router.put('/:slug/horarios', authAdminOrComercio, async (req, res) => {
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
          // Guardar también en horarios el primer bloque (compatibilidad)
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

// GET/POST/PUT/DELETE servicios
router.get('/:slug/servicios', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const r = await pool.query('SELECT * FROM servicios WHERE comercio_id=$1 ORDER BY orden,id', [c.rows[0].id]);
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
    await pool.query('DELETE FROM servicios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/comercio/:slug/reservas
router.get('/:slug/reservas', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const { desde, hasta, estado } = req.query;
    let q = `SELECT r.*, s.nombre as servicio_nombre, s.precio
             FROM reservas r JOIN servicios s ON s.id=r.servicio_id
             WHERE r.comercio_id=$1`;
    const params = [c.rows[0].id];
    if (desde) { params.push(desde); q += ` AND r.fecha>=$${params.length}`; }
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
