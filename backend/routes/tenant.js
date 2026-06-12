const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authTenant } = require('../middleware/auth');

// POST /api/tenant/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await db.query(
      'SELECT id, slug, nombre, panel_email, panel_password FROM comercios WHERE panel_email = $1 AND activo = TRUE',
      [email]
    );
    if (!rows[0] || !rows[0].panel_password) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const ok = await bcrypt.compare(password, rows[0].panel_password);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign(
      { comercio_id: rows[0].id, slug: rows[0].slug, rol: 'tenant' },
      process.env.JWT_TENANT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, comercio: { id: rows[0].id, slug: rows[0].slug, nombre: rows[0].nombre } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tenant/mi-comercio — datos propios
router.get('/mi-comercio', authTenant, async (req, res) => {
  try {
    const [comercio, horarios, servicios] = await Promise.all([
      db.query(`SELECT id, slug, nombre, slogan, tipo, telefono, whatsapp, email,
                       direccion, instagram_url, logo_url, moneda,
                       color_acento, color_fondo, color_tarjeta, color_texto, panel_email
                FROM comercios WHERE id = $1`, [req.tenant.comercio_id]),
      db.query('SELECT * FROM horarios WHERE comercio_id = $1', [req.tenant.comercio_id]),
      db.query('SELECT * FROM servicios WHERE comercio_id = $1 AND activo = TRUE ORDER BY orden, nombre', [req.tenant.comercio_id]),
    ]);
    res.json({ comercio: comercio.rows[0], horarios: horarios.rows, servicios: servicios.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tenant/mi-comercio — actualizar info básica
router.put('/mi-comercio', authTenant, async (req, res) => {
  try {
    const campos = ['nombre','slogan','telefono','whatsapp','email','direccion',
                    'instagram_url','moneda','color_acento'];
    const updates = [];
    const values = [];
    let idx = 1;
    for (const c of campos) {
      if (req.body[c] !== undefined) {
        updates.push(`${c} = $${idx++}`);
        values.push(req.body[c]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });
    values.push(req.tenant.comercio_id);
    await db.query(`UPDATE comercios SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tenant/mi-comercio/horarios
router.put('/mi-comercio/horarios', authTenant, async (req, res) => {
  try {
    const { horarios } = req.body;
    const diasOrden = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
    await db.transaction(async (client) => {
      await client.query('DELETE FROM horarios WHERE comercio_id = $1', [req.tenant.comercio_id]);
      for (const dia of diasOrden) {
        const h = horarios[dia];
        await client.query(`
          INSERT INTO horarios (comercio_id, dia, abre, cierra, cerrado)
          VALUES ($1,$2,$3,$4,$5)
        `, [req.tenant.comercio_id, dia, h?.abre||null, h?.cierra||null, !h || h.cerrado]);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tenant/reservas?fecha=2025-03-15
router.get('/reservas', authTenant, async (req, res) => {
  try {
    const { fecha, estado, limite } = req.query;
    let query = `SELECT r.*, s.nombre as servicio_nombre, s.duracion_min
                 FROM reservas r JOIN servicios s ON s.id = r.servicio_id
                 WHERE r.comercio_id = $1`;
    const values = [req.tenant.comercio_id];
    let idx = 2;
    if (fecha) { query += ` AND r.fecha = $${idx++}`; values.push(fecha); }
    if (estado) { query += ` AND r.estado = $${idx++}`; values.push(estado); }
    query += ` ORDER BY r.fecha DESC, r.hora_inicio ASC LIMIT $${idx}`;
    values.push(parseInt(limite) || 100);
    const { rows } = await db.query(query, values);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tenant/reservas/:id/estado
router.put('/reservas/:id/estado', authTenant, async (req, res) => {
  try {
    const { estado } = req.body;
    const validos = ['confirmada','cancelada','completada','no_show'];
    if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    const { rows } = await db.query(`
      UPDATE reservas SET estado = $1
      WHERE id = $2 AND comercio_id = $3 RETURNING *
    `, [estado, req.params.id, req.tenant.comercio_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Reserva no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
