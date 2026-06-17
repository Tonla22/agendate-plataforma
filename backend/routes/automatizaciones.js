const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

function authAutomatizacion(req, res, next) {
  const secret = process.env.AUTOMATION_SECRET;

  if (!secret) {
    return res.status(500).json({ error: 'AUTOMATION_SECRET no configurado' });
  }

  if (req.headers['x-automation-secret'] !== secret) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  next();
}

function fechaHoraLocalSQL() {
  return `
    (
      (r.fecha::text || ' ' || r.hora::text)::timestamp
    )
  `;
}

// GET /api/automatizaciones/recordatorios-pendientes
router.get('/recordatorios-pendientes', authAutomatizacion, async (req, res) => {
  try {
    const q = `
      SELECT
        r.id AS reserva_id,
        r.uuid,
        r.fecha,
        r.hora::text AS hora,
        r.cliente_nombre,
        r.cliente_apellido,
        r.cliente_whatsapp,
        r.cliente_email,
        c.id AS comercio_id,
        c.nombre AS comercio_nombre,
        c.slug AS comercio_slug,
        c.whatsapp AS comercio_whatsapp,
        c.auto_recordatorio_horas_antes,
        s.id AS servicio_id,
        s.nombre AS servicio_nombre,
        s.precio,
        s.duracion_min,
        t.id AS profesional_id,
        t.nombre AS profesional_nombre
      FROM reservas r
      JOIN comercios c ON c.id = r.comercio_id
      JOIN servicios s ON s.id = r.servicio_id
      LEFT JOIN trabajadores t ON t.id = r.trabajador_id
      WHERE
        r.estado = 'confirmada'
        AND r.recordatorio_enviado = false
        AND c.activo = true
        AND c.auto_recordatorio_activo = true
        AND ${fechaHoraLocalSQL()} > NOW()
        AND ${fechaHoraLocalSQL()} <= NOW() + (c.auto_recordatorio_horas_antes || ' hours')::interval
      ORDER BY r.fecha ASC, r.hora ASC
      LIMIT 50
    `;

    const r = await pool.query(q);
    res.json({ recordatorios: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/automatizaciones/reservas/:id/recordatorio-enviado
router.post('/reservas/:id/recordatorio-enviado', authAutomatizacion, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE reservas
       SET recordatorio_enviado=true,
           recordatorio_enviado_en=NOW()
       WHERE id=$1
       RETURNING id, uuid, recordatorio_enviado, recordatorio_enviado_en`,
      [req.params.id]
    );

    if (!r.rows[0]) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    res.json({ ok: true, reserva: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;