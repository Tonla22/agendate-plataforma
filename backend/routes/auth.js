const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Login super-admin
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign({ id: r.rows[0].id, email, tipo: 'admin', nombre: r.rows[0].nombre }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, nombre: r.rows[0].nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login dueño de comercio
router.post('/comercio/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query(
      `SELECT uc.*, c.slug, c.nombre as comercio_nombre, c.activo as comercio_activo
       FROM usuarios_comercio uc JOIN comercios c ON c.id=uc.comercio_id
       WHERE uc.email=$1 AND uc.activo=true`, [email]
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (!r.rows[0].comercio_activo) return res.status(403).json({ error: 'Este comercio está desactivado' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign({
      id: r.rows[0].id, email, tipo: 'comercio',
      comercio_id: r.rows[0].comercio_id, slug: r.rows[0].slug,
      nombre: r.rows[0].nombre
    }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, nombre: r.rows[0].nombre, slug: r.rows[0].slug, comercio_nombre: r.rows[0].comercio_nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
