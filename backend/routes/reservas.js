// backend/routes/reservas.js
const router = require('express').Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

// POST /api/reservas — crear reserva (público)
router.post('/', async (req, res) => {
  const { slug, servicio_id, empleado_id, fecha, hora, cliente_nombre, cliente_telefono, cliente_email, comentarios } = req.body;

  if (!slug || !servicio_id || !fecha || !hora || !cliente_nombre || !cliente_telefono) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    const { rows: [comercio] } = await pool.query(
      'SELECT * FROM comercios WHERE slug=$1 AND activo=true', [slug]
    );
    if (!comercio) return res.status(404).json({ error: 'Comercio no encontrado' });

    const { rows: [servicio] } = await pool.query(
      'SELECT * FROM servicios WHERE id=$1 AND comercio_id=$2 AND activo=true',
      [servicio_id, comercio.id]
    );
    if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado' });

    // Calcular hora_fin
    const [hh, mm] = hora.split(':').map(Number);
    const totalMin = hh * 60 + mm + servicio.duracion_min;
    const horaFin = `${String(Math.floor(totalMin/60)).padStart(2,'0')}:${String(totalMin%60).padStart(2,'0')}`;

    // Verificar que el slot esté libre
    const { rows: conflicto } = await pool.query(
      `SELECT id FROM reservas
       WHERE comercio_id=$1 AND fecha=$2 AND hora_inicio=$3 AND estado != 'cancelada'`,
      [comercio.id, fecha, hora]
    );
    if (conflicto.length > 0) {
      return res.status(409).json({ error: 'Ese horario ya fue reservado. Elegí otro.' });
    }

    const { rows: [reserva] } = await pool.query(
      `INSERT INTO reservas
        (comercio_id, servicio_id, empleado_id, cliente_nombre, cliente_telefono,
         cliente_email, fecha, hora_inicio, hora_fin, comentarios, precio_cobrado, servicio_nombre)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [comercio.id, servicio_id, empleado_id || null, cliente_nombre, cliente_telefono,
       cliente_email || null, fecha, hora, horaFin, comentarios || null,
       servicio.precio, servicio.nombre]
    );

    // Disparar webhook si está configurado
    if (comercio.webhook_url) {
      fetch(comercio.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento: 'nueva_reserva',
          comercio: { nombre: comercio.nombre, slug: comercio.slug },
          reserva: {
            id: reserva.id,
            servicio: servicio.nombre,
            precio: servicio.precio,
            fecha, hora,
            cliente: { nombre: cliente_nombre, telefono: cliente_telefono, email: cliente_email },
            comentarios,
          },
          whatsapp_dueno: comercio.whatsapp,
          email_dueno: comercio.email_notif,
        })
      }).catch(e => console.warn('Webhook error:', e.message));
    }

    res.status(201).json({ ok: true, reserva_id: reserva.id, mensaje: 'Reserva confirmada' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Horario no disponible' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reservas?comercio_id=&fecha=&estado= (requiere auth)
router.get('/', authMiddleware, async (req, res) => {
  const { comercio_id, fecha, estado, page = 1, limit = 50 } = req.query;

  // Un usuario comercio solo puede ver sus propias reservas
  const cid = req.user.rol === 'superadmin' ? (comercio_id || null) : req.user.comercio_id;
  if (!cid) return res.status(400).json({ error: 'comercio_id requerido' });

  try {
    const conditions = ['r.comercio_id = $1'];
    const vals = [cid];
    let i = 2;
    if (fecha) { conditions.push(`r.fecha = $${i++}`); vals.push(fecha); }
    if (estado) { conditions.push(`r.estado = $${i++}`); vals.push(estado); }

    const offset = (page - 1) * limit;
    vals.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT r.*, s.nombre as servicio_nombre_actual
       FROM reservas r
       LEFT JOIN servicios s ON s.id = r.servicio_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.fecha DESC, r.hora_inicio DESC
       LIMIT $${i++} OFFSET $${i}`,
      vals
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/reservas/:id — cambiar estado (cancelar, completar)
router.patch('/:id', authMiddleware, async (req, res) => {
  const { estado } = req.body;
  if (!['cancelada','completada','confirmada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  try {
    // Verificar que la reserva pertenece al comercio del usuario
    const { rows: [reserva] } = await pool.query('SELECT * FROM reservas WHERE id=$1', [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (req.user.rol !== 'superadmin' && req.user.comercio_id !== reserva.comercio_id) {
      return res.status(403).json({ error: 'Sin permiso' });
    }
    await pool.query('UPDATE reservas SET estado=$1 WHERE id=$2', [estado, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reservas/stats/:comercio_id — estadísticas (auth)
router.get('/stats/:comercio_id', authMiddleware, async (req, res) => {
  if (req.user.rol !== 'superadmin' && req.user.comercio_id !== req.params.comercio_id) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado='confirmada') as confirmadas,
        COUNT(*) FILTER (WHERE estado='completada') as completadas,
        COUNT(*) FILTER (WHERE estado='cancelada') as canceladas,
        COUNT(*) FILTER (WHERE fecha = CURRENT_DATE AND estado='confirmada') as hoy,
        COUNT(*) FILTER (WHERE fecha >= DATE_TRUNC('month', NOW()) AND estado != 'cancelada') as este_mes,
        COALESCE(SUM(precio_cobrado) FILTER (WHERE estado='completada' AND fecha >= DATE_TRUNC('month', NOW())), 0) as ingresos_mes
      FROM reservas WHERE comercio_id=$1
    `, [req.params.comercio_id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
