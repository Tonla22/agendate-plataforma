const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { authAdmin } = require('../middleware/auth');

// GET /api/admin/comercios — listar todos
router.get('/comercios', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, 
        COUNT(DISTINCT s.id) as total_servicios,
        COUNT(DISTINCT res.id) as total_reservas,
        COUNT(DISTINCT uc.id) as total_usuarios
      FROM comercios c
      LEFT JOIN servicios s ON s.comercio_id=c.id
      LEFT JOIN reservas res ON res.comercio_id=c.id
      LEFT JOIN usuarios_comercio uc ON uc.comercio_id=c.id
      GROUP BY c.id ORDER BY c.creado_en DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/stats — métricas globales
router.get('/stats', authAdmin, async (req, res) => {
  try {
    const [comercios, reservas, hoy] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM comercios WHERE activo=true'),
      pool.query('SELECT COUNT(*) FROM reservas WHERE estado=\'confirmada\''),
      pool.query('SELECT COUNT(*) FROM reservas WHERE fecha=CURRENT_DATE AND estado=\'confirmada\'')
    ]);
    res.json({
      comercios_activos: parseInt(comercios.rows[0].count),
      total_reservas: parseInt(reservas.rows[0].count),
      reservas_hoy: parseInt(hoy.rows[0].count)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/comercios — crear nuevo comercio
router.post('/comercios', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      slug, nombre, slogan, telefono, whatsapp, email_contacto,
      email_notificaciones, direccion, instagram_url, color_acento,
      color_fondo, moneda, duracion_turno_min, webhook_url,
      // Dueño
      dueno_nombre, dueno_email, dueno_password,
      // Servicios iniciales
      servicios = [],
      // Horarios iniciales
      horarios = []
    } = req.body;

    // Validar slug único y formato
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'El slug solo puede tener letras minúsculas, números y guiones' });
    }

    const slugExiste = await client.query('SELECT id FROM comercios WHERE slug=$1', [slug]);
    if (slugExiste.rows[0]) return res.status(400).json({ error: 'Ese slug ya está en uso' });

    // Crear comercio
    const c = await client.query(`
      INSERT INTO comercios (slug,nombre,slogan,telefono,whatsapp,email_contacto,email_notificaciones,
        direccion,instagram_url,color_acento,color_fondo,moneda,duracion_turno_min,webhook_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [slug,nombre,slogan,telefono,whatsapp,email_contacto,email_notificaciones,
       direccion,instagram_url,color_acento||'#C9A84C',color_fondo||'#0D0D0D',
       moneda||'$',duracion_turno_min||30,webhook_url]
    );
    const comercioId = c.rows[0].id;

    // Crear usuario dueño
    if (dueno_email && dueno_password) {
      const hash = await bcrypt.hash(dueno_password, 10);
      await client.query(
        'INSERT INTO usuarios_comercio (comercio_id,email,password_hash,nombre,rol) VALUES ($1,$2,$3,$4,$5)',
        [comercioId, dueno_email, hash, dueno_nombre || nombre, 'dueno']
      );
    }

    // Insertar servicios
    for (const s of servicios) {
      await client.query(
        'INSERT INTO servicios (comercio_id,nombre,precio,duracion_min,orden) VALUES ($1,$2,$3,$4,$5)',
        [comercioId, s.nombre, s.precio, s.duracion_min, s.orden||0]
      );
    }

    // Insertar horarios
    for (const h of horarios) {
      if (h.activo && h.abre && h.cierra) {
        await client.query(
          'INSERT INTO horarios (comercio_id,dia_semana,abre,cierra,activo) VALUES ($1,$2,$3,$4,true)',
          [comercioId, h.dia_semana, h.abre, h.cierra]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...c.rows[0], mensaje: 'Comercio creado correctamente' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PUT /api/admin/comercios/:id — editar comercio
router.put('/comercios/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const campos = ['nombre','slogan','telefono','whatsapp','email_contacto','email_notificaciones',
      'direccion','instagram_url','color_acento','color_fondo','moneda','duracion_turno_min',
      'webhook_url','activo','plan','fecha_pago_hasta'];
    const sets = []; const vals = [];
    campos.forEach(c => {
      if (req.body[c] !== undefined) { sets.push(`${c}=$${sets.length+1}`); vals.push(req.body[c]); }
    });
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    vals.push(id);
    sets.push(`actualizado_en=NOW()`);
    const r = await pool.query(`UPDATE comercios SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/comercios/:id
router.delete('/comercios/:id', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM comercios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/comercios/:id/reservas
router.get('/comercios/:id/reservas', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, s.nombre as servicio_nombre, s.precio
      FROM reservas r JOIN servicios s ON s.id=r.servicio_id
      WHERE r.comercio_id=$1 ORDER BY r.fecha DESC, r.hora DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/reservas — todas las reservas de todos los comercios
router.get('/reservas', authAdmin, async (req, res) => {
  try {
    const { desde, hasta } = req.query;

    const where = [];
    const vals = [];

    if (desde) {
      vals.push(desde);
      where.push(`r.fecha >= $${vals.length}`);
    }

    if (hasta) {
      vals.push(hasta);
      where.push(`r.fecha <= $${vals.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT 
        r.*,
        c.nombre AS comercio_nombre,
        c.slug AS comercio_slug,
        s.nombre AS servicio_nombre,
        s.precio
      FROM reservas r
      JOIN comercios c ON c.id = r.comercio_id
      JOIN servicios s ON s.id = r.servicio_id
      ${whereSql}
      ORDER BY r.fecha DESC, r.hora DESC
      LIMIT 500
    `, vals);

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
