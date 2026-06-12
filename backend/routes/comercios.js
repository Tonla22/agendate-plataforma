// backend/routes/comercios.js
const router = require('express').Router();
const pool = require('../db/pool');
const bcrypt = require('bcryptjs');
const { authMiddleware, superadminOnly, comercioAccess } = require('../middleware/auth');

// ── PÚBLICO ──────────────────────────────────────────────────

// GET /api/comercios/:slug/perfil — página pública del comercio
router.get('/:slug/perfil', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, slug, nombre, slogan, descripcion, telefono, whatsapp,
              email_contacto, direccion, instagram_url, logo_url,
              color_acento, color_fondo, color_tarjeta, color_texto, moneda, activo
       FROM comercios WHERE slug=$1 AND activo=true`,
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const comercioId = rows[0].id;

    const servicios = (await pool.query(
      `SELECT id, nombre, descripcion, precio, duracion_min
       FROM servicios WHERE comercio_id=$1 AND activo=true ORDER BY orden, nombre`,
      [comercioId]
    )).rows;

    const horarios = (await pool.query(
      `SELECT dia_semana, abre, cierra, cerrado
       FROM horarios WHERE comercio_id=$1 ORDER BY dia_semana`,
      [comercioId]
    )).rows;

    const empleados = (await pool.query(
      `SELECT id, nombre, foto_url FROM empleados WHERE comercio_id=$1 AND activo=true`,
      [comercioId]
    )).rows;

    res.json({ ...rows[0], servicios, horarios, empleados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/comercios/:slug/disponibilidad?fecha=YYYY-MM-DD&servicio_id=UUID
router.get('/:slug/disponibilidad', async (req, res) => {
  const { fecha, servicio_id } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  try {
    const { rows: [comercio] } = await pool.query(
      'SELECT id FROM comercios WHERE slug=$1 AND activo=true', [req.params.slug]
    );
    if (!comercio) return res.status(404).json({ error: 'Comercio no encontrado' });

    // Obtener duración del servicio
    let duracion = 30;
    if (servicio_id) {
      const { rows } = await pool.query('SELECT duracion_min FROM servicios WHERE id=$1', [servicio_id]);
      if (rows[0]) duracion = rows[0].duracion_min;
    }

    // Día de la semana (0=Dom)
    const d = new Date(fecha + 'T12:00:00');
    const diaSemana = d.getDay();

    const { rows: [horario] } = await pool.query(
      'SELECT abre, cierra, cerrado FROM horarios WHERE comercio_id=$1 AND dia_semana=$2',
      [comercio.id, diaSemana]
    );

    if (!horario || horario.cerrado || !horario.abre) {
      return res.json({ disponibles: [], motivo: 'Cerrado' });
    }

    // Verificar días bloqueados
    const { rows: bloqueados } = await pool.query(
      'SELECT id FROM dias_bloqueados WHERE comercio_id=$1 AND fecha=$2',
      [comercio.id, fecha]
    );
    if (bloqueados.length > 0) {
      return res.json({ disponibles: [], motivo: 'Día no disponible' });
    }

    // Generar slots
    const slots = [];
    let [hh, mm] = horario.abre.split(':').map(Number);
    const [hc, mc] = horario.cierra.split(':').map(Number);
    while (hh * 60 + mm + duracion <= hc * 60 + mc) {
      slots.push(`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`);
      mm += duracion;
      if (mm >= 60) { hh += Math.floor(mm/60); mm = mm % 60; }
    }

    // Obtener reservas existentes en esa fecha
    const { rows: reservasDelDia } = await pool.query(
      `SELECT hora_inicio::text FROM reservas
       WHERE comercio_id=$1 AND fecha=$2 AND estado != 'cancelada'`,
      [comercio.id, fecha]
    );
    const ocupadas = new Set(reservasDelDia.map(r => r.hora_inicio.slice(0,5)));

    const disponibles = slots.map(hora => ({
      hora,
      disponible: !ocupadas.has(hora),
    }));

    res.json({ disponibles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SUPERADMIN: gestión de comercios ─────────────────────────

// GET /api/comercios — lista todos (superadmin)
router.get('/', authMiddleware, superadminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(r.id) as total_reservas
       FROM comercios c
       LEFT JOIN reservas r ON r.comercio_id = c.id
       GROUP BY c.id ORDER BY c.creado_en DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comercios — crear nuevo comercio + usuario dueño
router.post('/', authMiddleware, superadminOnly, async (req, res) => {
  const { nombre, slug, slogan, telefono, whatsapp, email_contacto, email_notif,
          direccion, instagram_url, moneda, duracion_turno_min, webhook_url,
          color_acento, color_fondo, color_tarjeta, color_texto,
          dueno_email, dueno_password, dueno_nombre } = req.body;

  if (!nombre || !slug) return res.status(400).json({ error: 'nombre y slug son requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [comercio] } = await client.query(
      `INSERT INTO comercios (slug, nombre, slogan, telefono, whatsapp, email_contacto, email_notif,
        direccion, instagram_url, moneda, duracion_turno_min, webhook_url,
        color_acento, color_fondo, color_tarjeta, color_texto)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [slug.toLowerCase(), nombre, slogan, telefono, whatsapp, email_contacto, email_notif,
       direccion, instagram_url, moneda || '$', duracion_turno_min || 30, webhook_url,
       color_acento || '#C9A84C', color_fondo || '#0D0D0D', color_tarjeta || '#1A1A1A', color_texto || '#F5F0E8']
    );

    // Horarios por defecto (lun-vie 9-19, sab 9-17, dom cerrado)
    const horarioDefecto = [
      { dia: 0, cerrado: true }, { dia: 1, abre: '09:00', cierra: '19:00' },
      { dia: 2, abre: '09:00', cierra: '19:00' }, { dia: 3, abre: '09:00', cierra: '19:00' },
      { dia: 4, abre: '09:00', cierra: '19:00' }, { dia: 5, abre: '09:00', cierra: '19:00' },
      { dia: 6, abre: '09:00', cierra: '17:00' },
    ];
    for (const h of horarioDefecto) {
      await client.query(
        'INSERT INTO horarios (comercio_id, dia_semana, abre, cierra, cerrado) VALUES ($1,$2,$3,$4,$5)',
        [comercio.id, h.dia, h.abre || null, h.cierra || null, h.cerrado || false]
      );
    }

    // Crear usuario dueño si se proporcionaron credenciales
    if (dueno_email && dueno_password) {
      const hash = await bcrypt.hash(dueno_password, 12);
      await client.query(
        `INSERT INTO usuarios (email, password_hash, nombre, rol, comercio_id)
         VALUES ($1,$2,$3,'comercio',$4)`,
        [dueno_email.toLowerCase(), hash, dueno_nombre || nombre, comercio.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(comercio);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'El slug ya existe' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/comercios/:id — editar comercio
router.put('/:id', authMiddleware, async (req, res) => {
  // superadmin puede editar cualquiera; dueño solo el suyo
  if (req.user.rol !== 'superadmin' && req.user.comercio_id !== req.params.id) {
    return res.status(403).json({ error: 'Sin permiso' });
  }

  const campos = ['nombre','slogan','descripcion','telefono','whatsapp','email_contacto','email_notif',
                  'direccion','instagram_url','logo_url','moneda','duracion_turno_min','webhook_url',
                  'color_acento','color_fondo','color_tarjeta','color_texto'];
  if (req.user.rol === 'superadmin') campos.push('activo','slug');

  const sets = [], vals = [];
  let i = 1;
  for (const c of campos) {
    if (req.body[c] !== undefined) { sets.push(`${c}=$${i++}`); vals.push(req.body[c]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
  sets.push(`actualizado_en=NOW()`);
  vals.push(req.params.id);

  try {
    const { rows } = await pool.query(
      `UPDATE comercios SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/comercios/:id — desactivar (soft delete)
router.delete('/:id', authMiddleware, superadminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE comercios SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HORARIOS ────────────────────────────────────────────────

// PUT /api/comercios/:id/horarios
router.put('/:id/horarios', authMiddleware, async (req, res) => {
  if (req.user.rol !== 'superadmin' && req.user.comercio_id !== req.params.id) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { horarios } = req.body; // array de {dia_semana, abre, cierra, cerrado}
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const h of horarios) {
      await client.query(
        `INSERT INTO horarios (comercio_id, dia_semana, abre, cierra, cerrado)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (comercio_id, dia_semana)
         DO UPDATE SET abre=$3, cierra=$4, cerrado=$5`,
        [req.params.id, h.dia_semana, h.abre || null, h.cierra || null, h.cerrado || false]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── SERVICIOS ───────────────────────────────────────────────

router.get('/:id/servicios', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM servicios WHERE comercio_id=$1 ORDER BY orden, nombre', [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/servicios', authMiddleware, async (req, res) => {
  if (req.user.rol !== 'superadmin' && req.user.comercio_id !== req.params.id)
    return res.status(403).json({ error: 'Sin permiso' });
  const { nombre, descripcion, precio, duracion_min, orden } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO servicios (comercio_id, nombre, descripcion, precio, duracion_min, orden)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, nombre, descripcion, precio, duracion_min || 30, orden || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id/servicios/:sid', authMiddleware, async (req, res) => {
  if (req.user.rol !== 'superadmin' && req.user.comercio_id !== req.params.id)
    return res.status(403).json({ error: 'Sin permiso' });
  const { nombre, descripcion, precio, duracion_min, activo, orden } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE servicios SET nombre=$1,descripcion=$2,precio=$3,duracion_min=$4,activo=$5,orden=$6
       WHERE id=$7 AND comercio_id=$8 RETURNING *`,
      [nombre, descripcion, precio, duracion_min, activo, orden, req.params.sid, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/servicios/:sid', authMiddleware, async (req, res) => {
  if (req.user.rol !== 'superadmin' && req.user.comercio_id !== req.params.id)
    return res.status(403).json({ error: 'Sin permiso' });
  try {
    await pool.query('DELETE FROM servicios WHERE id=$1 AND comercio_id=$2', [req.params.sid, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
