const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authAdminOrComercio } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v2: cloudinary } = require('cloudinary');
const { v4: uuidv4 } = require('uuid');
const { enviarConfirmacionReserva } = require('../services/whatsapp');

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

    cb(new Error('Solo se permiten imágenes JPG, PNG, WEBP o GIF'));
  }
});

function subirBufferACloudinary(buffer, slug, tipo = 'general') {
  return new Promise((resolve, reject) => {
    const safeSlug = String(slug || 'comercio')
      .replace(/[^a-z0-9_-]/gi, '')
      .toLowerCase();

    const opciones = {
      folder: `agendate/${safeSlug}`,
      resource_type: 'image'
    };

    if (tipo === 'logo') {
      opciones.format = 'png';
      opciones.transformation = [
        { width: 900, crop: 'limit', quality: 'auto:best' }
      ];
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      opciones,
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
        { width: 900, crop: 'limit', quality: 'auto:best', fetch_format: 'png', background: 'transparent' }
      ]
    });
  }

  return result.secure_url;
}

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

const ESTADOS_RESERVA = new Set(['pendiente', 'confirmada', 'completada', 'cancelada', 'no_asistio']);
const FORMAS_PAGO = new Set(['local', 'online', 'sena']);
const ESTADOS_PAGO = new Set(['pendiente', 'pagado', 'parcial']);

function validarFechaISO(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''));
}

function validarHora(valor) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(valor || ''));
}

function fechaHoyUY() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizarTelefono(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function generarCodigoCliente() {
  return `CL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function generarTokenCalendario() {
  return crypto.randomBytes(24).toString('hex');
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
      [
        datos.nombre,
        datos.apellido || '',
        datos.email || null,
        existente.rows[0].id,
        comercioId
      ]
    );

    return actualizado.rows[0];
  }

  for (let i = 0; i < 5; i++) {
    try {
      const creado = await client.query(
        `INSERT INTO clientes (comercio_id,codigo,nombre,apellido,whatsapp,email)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          comercioId,
          generarCodigoCliente(),
          datos.nombre,
          datos.apellido || '',
          whatsapp,
          datos.email || null
        ]
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

const validarSlug = [
  param('slug')
    .trim()
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug inválido')
];

const validarPerfilComercio = [
  ...validarSlug,

  body('anticipacion_reserva_min')
    .optional({ checkFalsy: true })
    .isInt({ min: 0, max: 10080 })
    .withMessage('La anticipación para reservar debe estar entre 0 y 10080 minutos')
    .toInt(),

  body('anticipacion_cancelacion_min')
    .optional({ checkFalsy: true })
    .isInt({ min: 0, max: 10080 })
    .withMessage('La anticipación para cancelar debe estar entre 0 y 10080 minutos')
    .toInt(),

      body('auto_confirmacion_activa')
    .optional()
    .isBoolean()
    .withMessage('Configuración de confirmación inválida')
    .toBoolean(),

  body('auto_recordatorio_activo')
    .optional()
    .isBoolean()
    .withMessage('Configuración de recordatorio inválida')
    .toBoolean(),

  body('auto_recordatorio_horas_antes')
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 168 })
    .withMessage('El recordatorio debe estar entre 1 y 168 horas antes')
    .toInt(),

  body('auto_cancelacion_activa')
    .optional()
    .isBoolean()
    .withMessage('Configuración de cancelación inválida')
    .toBoolean(),

  body('auto_agradecimiento_activo')
    .optional()
    .isBoolean()
    .withMessage('Configuración de agradecimiento inválida')
    .toBoolean(),

  body('auto_agradecimiento_horas_despues')
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 168 })
    .withMessage('El agradecimiento debe estar entre 1 y 168 horas después')
    .toInt(),

  body('logo_url')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Logo inválido'),

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

  body('trabajador_id')
    .isInt({ min: 1 })
    .withMessage('Elegí un profesional para este servicio')
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

  body('requiere_sena')
    .optional()
    .isBoolean()
    .withMessage('La configuracion de seña es invalida')
    .toBoolean(),

  body('sena_tipo')
    .optional({ checkFalsy: true })
    .isIn(['monto', 'porcentaje'])
    .withMessage('El tipo de seña debe ser monto o porcentaje'),

  body('sena_valor')
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage('El valor de seña debe ser mayor o igual a 0')
    .toFloat(),

  body('imagen_url')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('La imagen del servicio es inválida')
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
        error: 'Cada día activo debe tener al menos un bloque horario'
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
          error: 'Formato de horario inválido. Usá HH:MM'
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
    .withMessage('Horarios inválidos'),

  body('horarios.*.dia_semana')
    .isInt({ min: 0, max: 6 })
    .withMessage('Día inválido')
    .toInt(),

  body('horarios.*.activo')
    .isBoolean()
    .withMessage('El estado del día debe ser verdadero o falso')
    .toBoolean(),

  body('horarios.*.bloques')
    .optional()
    .isArray({ max: 8 })
    .withMessage('Demasiados bloques para un día'),

  body('horarios.*.bloques.*.abre')
    .optional()
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('Hora de apertura inválida'),

  body('horarios.*.bloques.*.cierra')
    .optional()
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage('Hora de cierre inválida')
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
          error: 'No se recibió ninguna imagen'
        });
      }

      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        return res.status(500).json({
          error: 'Cloudinary no está configurado en el servidor'
        });
      }

      const tiposValidos = new Set(['fondo', 'logo', 'avatar']);
      const tipo = tiposValidos.has(req.body?.tipo) ? req.body.tipo : 'general';
      const resultado = await subirBufferACloudinary(req.file.buffer, req.params.slug, tipo);

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

// GET /api/comercio/:slug/perfil - datos del comercio (auth requerida)
router.get('/:slug/perfil', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT * FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    if (!c.rows[0].calendar_token) {
      const token = generarTokenCalendario();
      await pool.query('UPDATE comercios SET calendar_token=$1 WHERE id=$2', [token, c.rows[0].id]);
      c.rows[0].calendar_token = token;
    }
    const servicios = await pool.query('SELECT * FROM servicios WHERE comercio_id=$1 AND activo=true', [c.rows[0].id]);
    const horarios = await pool.query('SELECT * FROM horarios WHERE comercio_id=$1 ORDER BY dia_semana', [c.rows[0].id]);
    const bloques = await pool.query('SELECT * FROM horario_bloques WHERE comercio_id=$1 ORDER BY dia_semana,orden', [c.rows[0].id]);
    const ubicaciones = await pool.query('SELECT * FROM ubicaciones WHERE comercio_id=$1 AND activo=true ORDER BY principal DESC, orden, id', [c.rows[0].id]);
    res.json({ ...c.rows[0], servicios: servicios.rows, horarios: horarios.rows, horario_bloques: bloques.rows, ubicaciones: ubicaciones.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/comercio/:slug/cuenta - datos del usuario del panel
router.get('/:slug/cuenta', authAdminOrComercio, async (req, res) => {
  try {
    if (!req.usuario?.id) {
      return res.status(403).json({ error: 'Solo el usuario del comercio puede editar su cuenta' });
    }

    const r = await pool.query(
      `SELECT uc.id, uc.nombre, uc.email, uc.avatar_url, uc.rol, uc.creado_en, c.nombre AS comercio_nombre, c.slug
       FROM usuarios_comercio uc
       JOIN comercios c ON c.id=uc.comercio_id
       WHERE uc.id=$1 AND c.slug=$2 AND uc.activo=true
       LIMIT 1`,
      [req.usuario.id, req.params.slug]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/comercio/:slug/cuenta - editar nombre y contraseña
router.put('/:slug/cuenta', authAdminOrComercio, async (req, res) => {
  try {
    if (!req.usuario?.id) {
      return res.status(403).json({ error: 'Solo el usuario del comercio puede editar su cuenta' });
    }

    const nombre = String(req.body.nombre || '').trim();
    const avatarUrl = req.body.avatar_url === undefined ? undefined : String(req.body.avatar_url || '').trim();
    const passwordActual = String(req.body.password_actual || '');
    const passwordNuevo = String(req.body.password_nuevo || '');

    if (!nombre || nombre.length < 2) {
      return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
    }

    const usuario = await pool.query(
      `SELECT uc.*, c.slug
       FROM usuarios_comercio uc
       JOIN comercios c ON c.id=uc.comercio_id
       WHERE uc.id=$1 AND c.slug=$2 AND uc.activo=true
       LIMIT 1`,
      [req.usuario.id, req.params.slug]
    );

    if (!usuario.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (passwordNuevo) {
      if (passwordNuevo.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
      }

      const ok = await bcrypt.compare(passwordActual, usuario.rows[0].password_hash);

      if (!ok) {
        return res.status(400).json({ error: 'La contraseña actual no es correcta' });
      }

      const hash = await bcrypt.hash(passwordNuevo, 10);

      const r = await pool.query(
        `UPDATE usuarios_comercio
         SET nombre=$1, password_hash=$2, avatar_url=COALESCE($3, avatar_url)
         WHERE id=$4
         RETURNING id,nombre,email,avatar_url,rol`,
        [nombre, hash, avatarUrl === undefined ? null : avatarUrl, req.usuario.id]
      );

      return res.json(r.rows[0]);
    }

    const r = await pool.query(
      `UPDATE usuarios_comercio
       SET nombre=$1, avatar_url=COALESCE($2, avatar_url)
       WHERE id=$3
       RETURNING id,nombre,email,avatar_url,rol`,
      [nombre, avatarUrl === undefined ? null : avatarUrl, req.usuario.id]
    );

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/comercio/:slug/perfil - el dueño edita su perfil
router.put('/:slug/perfil', authAdminOrComercio, validarPerfilComercio, revisarValidacion, async (req, res) => {
  try {
   const campos = ['nombre','slogan','telefono','whatsapp','email_contacto',
      'direccion','anticipacion_reserva_min','anticipacion_cancelacion_min',
      'auto_confirmacion_activa','auto_recordatorio_activo','auto_recordatorio_horas_antes',
      'auto_cancelacion_activa','auto_agradecimiento_activo','auto_agradecimiento_horas_despues',
      'pago_local_activo','pago_transferencia_activa','pago_mercadopago_activo',
      'pago_alias','pago_cuenta','pago_instrucciones','pago_mercadopago_link',
      'instagram_url','color_acento','color_fondo','moneda','logo_url','imagen_fondo_url'];
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

// GET /api/comercio/:slug/dashboard - resumen inicial del comercio
router.get('/:slug/dashboard', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id, slug, nombre, moneda FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const comercio = c.rows[0];
    const hoy = fechaHoyUY();

    const [stats, turnosHoy, proximos, servicios, trabajadores] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE r.fecha=$2) AS turnos_hoy,
          COUNT(*) FILTER (WHERE r.estado IN ('pendiente','confirmada') AND r.fecha >= $2) AS reservas_pendientes,
          COUNT(DISTINCT CASE WHEN r.creado_en::date = $2 THEN r.cliente_whatsapp END) AS clientes_nuevos,
          COALESCE(SUM(CASE WHEN r.fecha=$2 AND r.estado='completada' THEN s.precio ELSE 0 END), 0) AS ingresos_hoy
        FROM reservas r
        JOIN servicios s ON s.id = r.servicio_id
        WHERE r.comercio_id=$1
      `, [comercio.id, hoy]),
      pool.query(`
        SELECT r.*, s.nombre AS servicio_nombre, s.precio, t.nombre AS trabajador_nombre
        FROM reservas r
        JOIN servicios s ON s.id = r.servicio_id
        LEFT JOIN trabajadores t ON t.id = r.trabajador_id
        WHERE r.comercio_id=$1
          AND r.fecha=$2
        ORDER BY r.hora ASC
        LIMIT 8
      `, [comercio.id, hoy]),
      pool.query(`
        SELECT r.*, s.nombre AS servicio_nombre, s.precio, t.nombre AS trabajador_nombre
        FROM reservas r
        JOIN servicios s ON s.id = r.servicio_id
        LEFT JOIN trabajadores t ON t.id = r.trabajador_id
        WHERE r.comercio_id=$1
          AND r.estado IN ('pendiente','confirmada')
          AND (r.fecha > $2 OR (r.fecha=$2 AND r.hora >= CURRENT_TIME))
        ORDER BY r.fecha ASC, r.hora ASC
        LIMIT 8
      `, [comercio.id, hoy]),
      pool.query('SELECT COUNT(*)::int AS activos FROM servicios WHERE comercio_id=$1 AND activo=true', [comercio.id]),
      pool.query('SELECT COUNT(*)::int AS activos FROM trabajadores WHERE comercio_id=$1 AND activo=true', [comercio.id])
    ]);

    res.json({
      moneda: comercio.moneda || '$',
      stats: {
        ...stats.rows[0],
        servicios_activos: servicios.rows[0]?.activos || 0,
        profesionales_activos: trabajadores.rows[0]?.activos || 0
      },
      turnos_hoy: turnosHoy.rows,
      proximos_turnos: proximos.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/comercio/:slug/horarios - guardar horarios con soporte de bloques
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
    const r = await pool.query(
      `SELECT s.*, t.nombre AS trabajador_nombre
       FROM servicios s
       LEFT JOIN trabajadores t ON t.id=s.trabajador_id
       WHERE s.comercio_id=$1 AND s.activo=true
       ORDER BY s.orden,s.id`,
      [c.rows[0].id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:slug/servicios', authAdminOrComercio, validarServicioComercio, revisarValidacion, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'No encontrado' });
    const {
      nombre,
      descripcion,
      precio,
      duracion_min,
      trabajador_id,
      orden,
      imagen_url,
      requiere_sena,
      sena_tipo,
      sena_valor
    } = req.body;
    const trabajador = await pool.query(
      'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
      [trabajador_id, c.rows[0].id]
    );
    if (!trabajador.rows[0]) return res.status(400).json({ error: 'El profesional seleccionado no existe' });

    const r = await pool.query(
      `INSERT INTO servicios (comercio_id,trabajador_id,nombre,descripcion,precio,duracion_min,orden,imagen_url,requiere_sena,sena_tipo,sena_valor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        c.rows[0].id,
        trabajador_id,
        nombre,
        descripcion,
        precio,
        duracion_min,
        orden || 0,
        imagen_url || null,
        requiere_sena === true,
        sena_tipo || 'monto',
        Number(sena_valor || 0)
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:slug/servicios/:id', authAdminOrComercio, validarServicioComercio, revisarValidacion, async (req, res) => {
  try {
    const comercio = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!comercio.rows[0]) return res.status(404).json({ error: 'No encontrado' });

    const {
      nombre,
      descripcion,
      precio,
      duracion_min,
      trabajador_id,
      orden,
      activo,
      imagen_url,
      requiere_sena,
      sena_tipo,
      sena_valor
    } = req.body;
    const trabajador = await pool.query(
      'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
      [trabajador_id, comercio.rows[0].id]
    );
    if (!trabajador.rows[0]) return res.status(400).json({ error: 'El profesional seleccionado no existe' });

    const r = await pool.query(
      `UPDATE servicios
       SET trabajador_id=$1,nombre=$2,descripcion=$3,precio=$4,duracion_min=$5,orden=$6,activo=$7,imagen_url=$8,
           requiere_sena=$9,sena_tipo=$10,sena_valor=$11
       WHERE id=$12 AND comercio_id=$13
       RETURNING *`,
      [
        trabajador_id,
        nombre,
        descripcion,
        precio,
        duracion_min,
        orden || 0,
        activo !== false,
        imagen_url || null,
        requiere_sena === true,
        sena_tipo || 'monto',
        Number(sena_valor || 0),
        req.params.id,
        comercio.rows[0].id
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
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
          MAX(cl.id) AS cliente_id,
          MAX(cl.codigo) AS codigo,
          r.cliente_whatsapp,
          COALESCE(MAX(TRIM(CONCAT(cl.nombre, ' ', cl.apellido))), MAX(TRIM(CONCAT(r.cliente_nombre, ' ', r.cliente_apellido)))) AS nombre,
          COALESCE(MAX(cl.email), MAX(r.cliente_email)) AS email,
          COUNT(*) AS reservas_totales,
          COUNT(*) FILTER (WHERE r.estado='completada') AS reservas_completadas,
          MAX(r.fecha) AS ultima_visita,
          COALESCE(SUM(CASE WHEN r.estado='completada' THEN s.precio ELSE 0 END), 0) AS total_gastado
        FROM reservas r
        JOIN servicios s ON s.id = r.servicio_id
        LEFT JOIN clientes cl
          ON cl.comercio_id = r.comercio_id
          AND (
            cl.id = r.cliente_id
            OR cl.whatsapp = regexp_replace(r.cliente_whatsapp, '\\D', '', 'g')
          )
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

// GET /api/comercio/:slug/clientes/buscar?q=texto
router.get('/:slug/clientes/buscar', authAdminOrComercio, async (req, res) => {
  try {
    const comercio = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);

    if (!comercio.rows[0]) {
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const q = String(req.query.q || '').trim();

    if (q.length < 2) {
      return res.json([]);
    }

    const term = `%${q.toLowerCase()}%`;

    const clientes = await pool.query(
      `SELECT id,codigo,nombre,apellido,whatsapp,email
       FROM clientes
       WHERE comercio_id=$1
         AND (
           lower(codigo) LIKE $2
           OR lower(nombre) LIKE $2
           OR lower(COALESCE(apellido,'')) LIKE $2
           OR whatsapp LIKE $3
         )
       ORDER BY actualizado_en DESC
       LIMIT 8`,
      [comercio.rows[0].id, term, `%${normalizarTelefono(q)}%`]
    );

    res.json(clientes.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET/POST/PUT/DELETE ubicaciones
router.get('/:slug/ubicaciones', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const r = await pool.query(
      'SELECT * FROM ubicaciones WHERE comercio_id=$1 AND activo=true ORDER BY principal DESC, orden, id',
      [c.rows[0].id]
    );

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:slug/ubicaciones', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const { nombre, direccion, telefono, whatsapp, notas, principal, orden } = req.body;

    if (!nombre || String(nombre).trim().length < 2) {
      return res.status(400).json({ error: 'El nombre de la ubicacion es obligatorio' });
    }

    if (!direccion || String(direccion).trim().length < 3) {
      return res.status(400).json({ error: 'La direccion es obligatoria' });
    }

    if (principal === true) {
      await pool.query('UPDATE ubicaciones SET principal=false WHERE comercio_id=$1', [c.rows[0].id]);
    }

    const r = await pool.query(
      `INSERT INTO ubicaciones (comercio_id,nombre,direccion,telefono,whatsapp,notas,principal,orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        c.rows[0].id,
        String(nombre).trim(),
        String(direccion).trim(),
        telefono || null,
        whatsapp || null,
        notas || null,
        principal === true,
        orden || 0
      ]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:slug/ubicaciones/:id', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const { nombre, direccion, telefono, whatsapp, notas, principal, orden } = req.body;

    if (!nombre || String(nombre).trim().length < 2) {
      return res.status(400).json({ error: 'El nombre de la ubicacion es obligatorio' });
    }

    if (!direccion || String(direccion).trim().length < 3) {
      return res.status(400).json({ error: 'La direccion es obligatoria' });
    }

    if (principal === true) {
      await pool.query('UPDATE ubicaciones SET principal=false WHERE comercio_id=$1', [c.rows[0].id]);
    }

    const r = await pool.query(
      `UPDATE ubicaciones
       SET nombre=$1,direccion=$2,telefono=$3,whatsapp=$4,notas=$5,principal=$6,orden=$7
       WHERE id=$8 AND comercio_id=$9
       RETURNING *`,
      [
        String(nombre).trim(),
        String(direccion).trim(),
        telefono || null,
        whatsapp || null,
        notas || null,
        principal === true,
        orden || 0,
        req.params.id,
        c.rows[0].id
      ]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Ubicacion no encontrada' });

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:slug/ubicaciones/:id', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const r = await pool.query(
      'UPDATE ubicaciones SET activo=false, principal=false WHERE id=$1 AND comercio_id=$2 RETURNING id',
      [req.params.id, c.rows[0].id]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Ubicacion no encontrada' });

    res.json({ ok: true });
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

// GET /api/comercio/:slug/bloqueos - bloqueos de disponibilidad
router.get('/:slug/bloqueos', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const r = await pool.query(`
      SELECT b.*, t.nombre AS trabajador_nombre
      FROM disponibilidad_bloqueos b
      LEFT JOIN trabajadores t ON t.id = b.trabajador_id
      WHERE b.comercio_id=$1
      ORDER BY b.fecha_desde DESC, b.hora_desde NULLS FIRST, b.id DESC
    `, [c.rows[0].id]);

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/comercio/:slug/bloqueos - crear bloqueo
router.post('/:slug/bloqueos', authAdminOrComercio, async (req, res) => {
  try {
    const { tipo, fecha_desde, fecha_hasta, hora_desde, hora_hasta, trabajador_id, motivo } = req.body;
    const tipoFinal = ['dia', 'rango', 'horario'].includes(tipo) ? tipo : 'dia';

    if (!validarFechaISO(fecha_desde)) {
      return res.status(400).json({ error: 'La fecha de inicio es inválida' });
    }

    const fechaHastaFinal = validarFechaISO(fecha_hasta) ? fecha_hasta : fecha_desde;

    if (fechaHastaFinal < fecha_desde) {
      return res.status(400).json({ error: 'La fecha final no puede ser anterior a la inicial' });
    }

    if (tipoFinal === 'horario' && (!validarHora(hora_desde) || !validarHora(hora_hasta) || hora_hasta <= hora_desde)) {
      return res.status(400).json({ error: 'Para bloquear un horario, indicá una hora desde y hasta válida' });
    }

    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const comercioId = c.rows[0].id;
    let trabajadorId = trabajador_id || null;

    if (trabajadorId) {
      const t = await pool.query(
        'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajadorId, comercioId]
      );

      if (!t.rows[0]) return res.status(400).json({ error: 'El profesional seleccionado no existe' });
      trabajadorId = t.rows[0].id;
    }

    const r = await pool.query(`
      INSERT INTO disponibilidad_bloqueos
        (comercio_id, trabajador_id, tipo, fecha_desde, fecha_hasta, hora_desde, hora_hasta, motivo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      comercioId,
      trabajadorId,
      tipoFinal,
      fecha_desde,
      fechaHastaFinal,
      tipoFinal === 'horario' ? hora_desde : null,
      tipoFinal === 'horario' ? hora_hasta : null,
      motivo || null
    ]);

    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/comercio/:slug/bloqueos/:id - actualizar bloqueo
router.put('/:slug/bloqueos/:id', authAdminOrComercio, async (req, res) => {
  try {
    const { tipo, fecha_desde, fecha_hasta, hora_desde, hora_hasta, trabajador_id, motivo, activo } = req.body;
    const tipoFinal = ['dia', 'rango', 'horario'].includes(tipo) ? tipo : 'dia';

    if (!validarFechaISO(fecha_desde)) {
      return res.status(400).json({ error: 'La fecha de inicio es inválida' });
    }

    const fechaHastaFinal = validarFechaISO(fecha_hasta) ? fecha_hasta : fecha_desde;

    if (fechaHastaFinal < fecha_desde) {
      return res.status(400).json({ error: 'La fecha final no puede ser anterior a la inicial' });
    }

    if (tipoFinal === 'horario' && (!validarHora(hora_desde) || !validarHora(hora_hasta) || hora_hasta <= hora_desde)) {
      return res.status(400).json({ error: 'Para bloquear un horario, indicá una hora desde y hasta válida' });
    }

    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const comercioId = c.rows[0].id;
    let trabajadorId = trabajador_id || null;

    if (trabajadorId) {
      const t = await pool.query(
        'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajadorId, comercioId]
      );

      if (!t.rows[0]) return res.status(400).json({ error: 'El profesional seleccionado no existe' });
      trabajadorId = t.rows[0].id;
    }

    const r = await pool.query(`
      UPDATE disponibilidad_bloqueos
      SET trabajador_id=$1,
          tipo=$2,
          fecha_desde=$3,
          fecha_hasta=$4,
          hora_desde=$5,
          hora_hasta=$6,
          motivo=$7,
          activo=$8
      WHERE id=$9 AND comercio_id=$10
      RETURNING *
    `, [
      trabajadorId,
      tipoFinal,
      fecha_desde,
      fechaHastaFinal,
      tipoFinal === 'horario' ? hora_desde : null,
      tipoFinal === 'horario' ? hora_hasta : null,
      motivo || null,
      activo !== false,
      req.params.id,
      comercioId
    ]);

    if (!r.rows[0]) return res.status(404).json({ error: 'Bloqueo no encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/comercio/:slug/bloqueos/:id - desactivar bloqueo
router.delete('/:slug/bloqueos/:id', authAdminOrComercio, async (req, res) => {
  try {
    const c = await pool.query('SELECT id FROM comercios WHERE slug=$1', [req.params.slug]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const r = await pool.query(
      'UPDATE disponibilidad_bloqueos SET activo=false WHERE id=$1 AND comercio_id=$2 RETURNING id',
      [req.params.id, c.rows[0].id]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Bloqueo no encontrado' });
    res.json({ ok: true });
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
    let q = `SELECT r.*, s.nombre as servicio_nombre, s.precio, t.nombre as trabajador_nombre,
                    u.nombre as ubicacion_nombre, u.direccion as ubicacion_direccion
             FROM reservas r
             JOIN servicios s ON s.id=r.servicio_id
             LEFT JOIN trabajadores t ON t.id=r.trabajador_id
             LEFT JOIN ubicaciones u ON u.id=r.ubicacion_id
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

// POST /api/comercio/:slug/reservas/manual - crear reserva desde el panel del comercio
router.post('/:slug/reservas/manual', authAdminOrComercio, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      servicio_id,
      trabajador_id,
      ubicacion_id,
      fecha,
      hora,
      cliente_nombre,
      cliente_apellido,
      cliente_whatsapp,
      cliente_email,
      comentarios,
      estado,
      forma_pago,
      estado_pago,
      enviar_confirmacion
    } = req.body;

    if (!servicio_id || !fecha || !hora || !cliente_nombre || !cliente_whatsapp) {
      return res.status(400).json({ error: 'Faltan datos obligatorios para crear la reserva' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hora))) {
      return res.status(400).json({ error: 'Hora inválida' });
    }

    const estadoFinal = ESTADOS_RESERVA.has(estado) ? estado : 'confirmada';

    await client.query('BEGIN');

    const comercioRes = await client.query(
      'SELECT * FROM comercios WHERE slug=$1',
      [req.params.slug]
    );

    const comercio = comercioRes.rows[0];

    if (!comercio) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const servicioRes = await client.query(
      'SELECT * FROM servicios WHERE id=$1 AND comercio_id=$2 AND activo=true',
      [servicio_id, comercio.id]
    );

    const servicio = servicioRes.rows[0];

    if (!servicio) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Servicio no encontrado para este comercio' });
    }

    let trabajadorId = servicio.trabajador_id || null;
    let trabajadorNombre = null;
    let ubicacionId = null;

    if (ubicacion_id) {
      const ubicacion = await client.query(
        'SELECT id FROM ubicaciones WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [ubicacion_id, comercio.id]
      );

      if (!ubicacion.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Ubicacion no encontrada para este comercio' });
      }

      ubicacionId = ubicacion.rows[0].id;
    }

    if (trabajador_id) {
      if (trabajadorId && Number(trabajador_id) !== Number(trabajadorId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Ese servicio no pertenece al profesional elegido' });
      }

      trabajadorId = Number(trabajador_id);
    }

    if (trabajadorId) {
      const trabajadorRes = await client.query(
        'SELECT id,nombre FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajadorId, comercio.id]
      );

      if (!trabajadorRes.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Profesional no encontrado para este comercio' });
      }

      trabajadorNombre = trabajadorRes.rows[0].nombre;
    }

    const bloqueo = await existeBloqueoDisponibilidad(client, comercio.id, trabajadorId, fecha, hora);

    if (bloqueo) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: bloqueo.motivo
          ? `Ese horario está bloqueado: ${bloqueo.motivo}`
          : 'Ese horario está bloqueado por el comercio'
      });
    }

    let ocupadaQuery = `
      SELECT id
      FROM reservas
      WHERE comercio_id=$1
        AND fecha=$2
        AND hora=$3
        AND estado!='cancelada'
    `;

    const ocupadaParams = [comercio.id, fecha, hora];

    if (trabajadorId) {
      ocupadaParams.push(trabajadorId);
      ocupadaQuery += ` AND trabajador_id=$${ocupadaParams.length}`;
    }

    const ocupada = await client.query(ocupadaQuery, ocupadaParams);

    if (ocupada.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya tiene una reserva cargada' });
    }

    const uuid = uuidv4();
    const cliente = await upsertCliente(client, comercio.id, {
      nombre: String(cliente_nombre).trim(),
      apellido: cliente_apellido ? String(cliente_apellido).trim() : '',
      whatsapp: cliente_whatsapp,
      email: cliente_email
    });

    const formaPagoFinal = FORMAS_PAGO.has(forma_pago) ? forma_pago : 'local';
    const senaMonto = calcularSena(servicio);
    const estadoPagoFinal = ESTADOS_PAGO.has(estado_pago)
      ? estado_pago
      : (formaPagoFinal === 'online' ? 'pagado' : (senaMonto > 0 && formaPagoFinal === 'sena' ? 'parcial' : 'pendiente'));

    const reservaRes = await client.query(
      `INSERT INTO reservas (
        uuid, comercio_id, cliente_id, ubicacion_id, servicio_id, trabajador_id, fecha, hora, duracion_min,
        cliente_nombre, cliente_apellido, cliente_whatsapp, cliente_email, comentarios,
        forma_pago, estado_pago, sena_monto, estado
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        uuid,
        comercio.id,
        cliente?.id || null,
        ubicacionId,
        servicio.id,
        trabajadorId,
        fecha,
        hora,
        servicio.duracion_min,
        String(cliente_nombre).trim(),
        cliente_apellido ? String(cliente_apellido).trim() : '',
        normalizarTelefono(cliente_whatsapp),
        cliente_email || null,
        comentarios || null,
        formaPagoFinal,
        estadoPagoFinal,
        senaMonto,
        estadoFinal
      ]
    );

    await client.query('COMMIT');

    const reserva = reservaRes.rows[0];

    if (enviar_confirmacion === true && comercio.auto_confirmacion_activa !== false) {
      enviarConfirmacionReserva({
        reserva,
        comercio,
        servicio,
        profesional: trabajadorNombre ? { id: trabajadorId, nombre: trabajadorNombre } : null
      })
        .then(() => {
          return pool.query(
            `UPDATE reservas
             SET confirmacion_enviada=true,
                 confirmacion_enviada_en=NOW()
             WHERE id=$1`,
            [reserva.id]
          );
        })
        .catch(err => {
          console.error('No se pudo enviar confirmación WhatsApp manual:', err.message);
        });
    }

    res.status(201).json({
      ok: true,
      uuid,
      reserva
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/comercio/:slug/reservas/:id - detalle de reserva
router.get('/:slug/reservas/:id', authAdminOrComercio, async (req, res) => {
  try {
    const comercio = await pool.query(
      'SELECT id FROM comercios WHERE slug=$1',
      [req.params.slug]
    );

    if (!comercio.rows[0]) {
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const r = await pool.query(
      `SELECT r.*, s.nombre AS servicio_nombre, s.precio, s.duracion_min AS servicio_duracion_min,
              t.nombre AS trabajador_nombre,
              u.nombre AS ubicacion_nombre,
              u.direccion AS ubicacion_direccion
       FROM reservas r
       JOIN servicios s ON s.id=r.servicio_id
       LEFT JOIN trabajadores t ON t.id=r.trabajador_id
       LEFT JOIN ubicaciones u ON u.id=r.ubicacion_id
       WHERE r.id=$1 AND r.comercio_id=$2
       LIMIT 1`,
      [req.params.id, comercio.rows[0].id]
    );

    if (!r.rows[0]) {
      return res.status(404).json({ error: 'Reserva no encontrada para este comercio' });
    }

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/comercio/:slug/reservas/:id/reprogramar
router.put('/:slug/reservas/:id/reprogramar', authAdminOrComercio, async (req, res) => {
  const client = await pool.connect();

  try {
    const { fecha, hora, trabajador_id } = req.body;

    if (!validarFechaISO(fecha)) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }

    if (!validarHora(hora)) {
      return res.status(400).json({ error: 'Hora inválida' });
    }

    await client.query('BEGIN');

    const comercioRes = await client.query(
      'SELECT id FROM comercios WHERE slug=$1',
      [req.params.slug]
    );

    if (!comercioRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const comercioId = comercioRes.rows[0].id;

    const actualRes = await client.query(
      `SELECT r.*, s.trabajador_id AS servicio_trabajador_id
       FROM reservas r
       JOIN servicios s ON s.id=r.servicio_id
       WHERE r.id=$1 AND r.comercio_id=$2
       LIMIT 1`,
      [req.params.id, comercioId]
    );

    const actual = actualRes.rows[0];

    if (!actual) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Reserva no encontrada para este comercio' });
    }

    if (actual.estado === 'cancelada' || actual.estado === 'completada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No se puede reprogramar una reserva cancelada o completada' });
    }

    let trabajadorId = actual.servicio_trabajador_id || actual.trabajador_id || null;

    if (trabajador_id) {
      if (actual.servicio_trabajador_id && Number(trabajador_id) !== Number(actual.servicio_trabajador_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Ese servicio no pertenece al profesional elegido' });
      }

      const trabajador = await client.query(
        'SELECT id FROM trabajadores WHERE id=$1 AND comercio_id=$2 AND activo=true',
        [trabajador_id, comercioId]
      );

      if (!trabajador.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Profesional no encontrado para este comercio' });
      }

      trabajadorId = trabajador.rows[0].id;
    }

    const bloqueo = await existeBloqueoDisponibilidad(client, comercioId, trabajadorId, fecha, hora);

    if (bloqueo) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: bloqueo.motivo
          ? `Ese horario está bloqueado: ${bloqueo.motivo}`
          : 'Ese horario está bloqueado por el comercio'
      });
    }

    let ocupadaQuery = `
      SELECT id
      FROM reservas
      WHERE comercio_id=$1
        AND fecha=$2
        AND hora=$3
        AND estado!='cancelada'
        AND id<>$4
    `;

    const ocupadaParams = [comercioId, fecha, hora, actual.id];

    if (trabajadorId) {
      ocupadaParams.push(trabajadorId);
      ocupadaQuery += ` AND trabajador_id=$${ocupadaParams.length}`;
    }

    const ocupada = await client.query(ocupadaQuery, ocupadaParams);

    if (ocupada.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya tiene una reserva cargada' });
    }

    const r = await client.query(
      `UPDATE reservas
       SET fecha_original=COALESCE(fecha_original, fecha),
           hora_original=COALESCE(hora_original, hora),
           fecha=$1,
           hora=$2,
           trabajador_id=$3,
           reprogramada_en=NOW()
       WHERE id=$4 AND comercio_id=$5
       RETURNING *`,
      [fecha, hora, trabajadorId, actual.id, comercioId]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// PUT /api/comercio/:slug/reservas/:id/estado
router.put('/:slug/reservas/:id/estado', authAdminOrComercio, async (req, res) => {
  try {
    const estado = req.body.estado;

    if (!ESTADOS_RESERVA.has(estado)) {
      return res.status(400).json({ error: 'Estado de reserva inválido' });
    }

    const comercio = await pool.query(
      'SELECT id FROM comercios WHERE slug=$1',
      [req.params.slug]
    );

    if (!comercio.rows[0]) {
      return res.status(404).json({ error: 'Comercio no encontrado' });
    }

    const r = await pool.query(
      `UPDATE reservas
       SET estado=$1
       WHERE id=$2 AND comercio_id=$3
       RETURNING *`,
      [estado, req.params.id, comercio.rows[0].id]
    );

    if (!r.rows[0]) {
      return res.status(404).json({ error: 'Reserva no encontrada para este comercio' });
    }

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
module.exports = router;
