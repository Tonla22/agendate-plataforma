const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { authAdmin } = require('../middleware/auth');
const {
  actualizarSuscripcion,
  conectarMercadoPagoPlataforma
} = require('../services/platformSubscriptions');
const { esCodigoPlanValido, obtenerPlan } = require('../config/planes');

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// GET /api/admin/comercios — listar todos
router.get('/comercios', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*,
        uc.email AS dueno_email,
        uc.nombre AS dueno_nombre,
        COALESCE(m.pagos_registrados, 0)::integer AS pagos_registrados
      FROM comercios c
      LEFT JOIN LATERAL (
        SELECT email, nombre
        FROM usuarios_comercio
        WHERE comercio_id=c.id AND activo=true
        ORDER BY (rol='dueno') DESC, id
        LIMIT 1
      ) uc ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS pagos_registrados
        FROM mensualidades_plataforma
        WHERE comercio_id=c.id AND estado='approved'
      ) m ON true
      ORDER BY c.creado_en DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/stats — métricas globales
router.get('/stats', authAdmin, async (req, res) => {
  try {
    const [comercios, cobros, alertas, recientes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE activo=true)::integer AS activos,
          COUNT(*) FILTER (WHERE suscripcion_estado='prueba')::integer AS en_prueba,
          COUNT(*) FILTER (WHERE suscripcion_estado='activa')::integer AS al_dia,
          COUNT(*) FILTER (
            WHERE suscripcion_estado IN ('pago_pendiente','pausada')
               OR (fecha_pago_hasta IS NOT NULL AND fecha_pago_hasta < CURRENT_DATE)
          )::integer AS con_deuda
        FROM comercios
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(monto) FILTER (
            WHERE estado='approved'
              AND pagado_en >= date_trunc('month', NOW())
          ), 0)::numeric AS ingresos_mes,
          COUNT(*) FILTER (
            WHERE estado IN ('rejected','cancelled','charged_back')
              AND creado_en >= date_trunc('month', NOW())
          )::integer AS cobros_fallidos
        FROM mensualidades_plataforma
      `),
      pool.query(`
        SELECT COUNT(*)::integer AS total
        FROM eventos_sistema
        WHERE nivel IN ('error','critical')
          AND creado_en >= NOW() - INTERVAL '24 hours'
      `),
      pool.query(`
        SELECT id, nombre, slug, suscripcion_estado, creado_en
        FROM comercios
        ORDER BY creado_en DESC
        LIMIT 6
      `)
    ]);
    res.json({
      ...comercios.rows[0],
      ...cobros.rows[0],
      alertas_sistema: alertas.rows[0].total,
      comercios_recientes: recientes.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/sistema - estado operativo global
router.get('/sistema', authAdmin, async (req, res) => {
  const inicio = Date.now();

  try {
    const [
      relojDb,
      eventosResumen,
      eventosRecientes,
      pagos,
      calendar,
      actividad
    ] = await Promise.all([
      pool.query('SELECT NOW() AS ahora'),
      pool.query(`
        SELECT nivel, categoria, COUNT(*)::integer AS total
        FROM eventos_sistema
        WHERE creado_en >= NOW() - INTERVAL '24 hours'
        GROUP BY nivel, categoria
        ORDER BY nivel, categoria
      `),
      pool.query(`
        SELECT e.id,e.nivel,e.categoria,e.codigo,e.mensaje,e.contexto,e.creado_en,
               c.nombre AS comercio_nombre
        FROM eventos_sistema e
        LEFT JOIN comercios c ON c.id=e.comercio_id
        ORDER BY e.creado_en DESC
        LIMIT 40
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE estado_pago='pagado' AND pagada_en >= NOW() - INTERVAL '24 hours')::integer AS aprobados_24h,
          COUNT(*) FILTER (WHERE mercadopago_status IN ('rejected','cancelled','cancelled_by_user','charged_back') AND creado_en >= NOW() - INTERVAL '24 hours')::integer AS fallidos_24h,
          COUNT(*) FILTER (WHERE estado='pendiente' AND estado_pago='pendiente' AND pago_retencion_vence_en > NOW())::integer AS pendientes_activos,
          COUNT(*) FILTER (WHERE estado_pago='expirado' AND pago_retencion_expirada_en >= NOW() - INTERVAL '24 hours')::integer AS vencidos_24h,
          MAX(pagada_en) AS ultimo_pago_aprobado
        FROM reservas
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE google_calendar_access_token IS NOT NULL)::integer AS comercios_conectados,
          (SELECT COUNT(*)::integer FROM reservas WHERE google_calendar_sync_error IS NOT NULL) AS errores_pendientes
        FROM comercios
        WHERE activo=true
      `),
      pool.query(`
        SELECT
          MAX(creado_en) AS ultima_reserva,
          COUNT(*) FILTER (WHERE creado_en >= NOW() - INTERVAL '24 hours')::integer AS reservas_24h
        FROM reservas
      `)
    ]);

    const resumen = eventosResumen.rows.reduce((acc, fila) => {
      acc.total += fila.total;
      acc.por_nivel[fila.nivel] = (acc.por_nivel[fila.nivel] || 0) + fila.total;
      acc.por_categoria[fila.categoria] = (acc.por_categoria[fila.categoria] || 0) + fila.total;
      return acc;
    }, { total: 0, por_nivel: {}, por_categoria: {} });

    res.json({
      status: resumen.por_nivel.critical || resumen.por_nivel.error ? 'attention' : 'healthy',
      checked_at: new Date().toISOString(),
      release: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
      server: { status: 'ok', uptime_seconds: Math.floor(process.uptime()) },
      database: {
        status: 'ok',
        latency_ms: Date.now() - inicio,
        timestamp: relojDb.rows[0].ahora
      },
      integrations: {
        mercadopago: pagos.rows[0],
        google_calendar: calendar.rows[0],
        whatsapp: {
          configured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
          errors_24h: resumen.por_categoria.whatsapp || 0
        }
      },
      activity: actividad.rows[0],
      events_24h: resumen,
      recent_events: eventosRecientes.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'No se pudo consultar el estado del sistema' });
  }
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
      plan: planSolicitado = 'comercial',
      // Dueño
      dueno_nombre, dueno_email, dueno_password,
      // Servicios iniciales
      servicios = [],
      // Horarios iniciales
      horarios = []
    } = req.body;
    const configResult = await client.query(`
      SELECT mensualidad_monto, mensualidad_moneda, dias_prueba
      FROM configuracion_plataforma
      WHERE id=1
    `);
    const config = configResult.rows[0] || {
      mensualidad_monto: 1800,
      mensualidad_moneda: 'UYU',
      dias_prueba: 0
    };
    if (!esCodigoPlanValido(planSolicitado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El plan seleccionado no es valido' });
    }
    const plan = obtenerPlan(planSolicitado);

    const slugNormalizado = String(slug || '').trim().toLowerCase();
    const duenoEmailNormalizado = normalizarEmail(dueno_email);
    const duenoPassword = String(dueno_password || '');
    const duenoNombre = String(dueno_nombre || nombre || '').trim();

    // Validar slug único y formato
    if (!/^[a-z0-9-]+$/.test(slugNormalizado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El slug solo puede tener letras minúsculas, números y guiones' });
    }

    const slugExiste = await client.query('SELECT id FROM comercios WHERE slug=$1', [slugNormalizado]);
    if (slugExiste.rows[0]) await client.query('ROLLBACK');
    if (slugExiste.rows[0]) return res.status(400).json({ error: 'Ese slug ya está en uso' });

    if (!duenoEmailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(duenoEmailNormalizado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El email del dueno no es valido' });
    }

    if (duenoPassword.length < 6 || duenoPassword.length > 100) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La contrasena del dueno debe tener entre 6 y 100 caracteres' });
    }

    const emailExiste = await client.query(
      'SELECT id FROM usuarios_comercio WHERE LOWER(TRIM(email))=$1 LIMIT 1',
      [duenoEmailNormalizado]
    );
    if (emailExiste.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ese email ya esta registrado para otro comercio' });
    }

    // Crear comercio
    const c = await client.query(`
      INSERT INTO comercios (slug,nombre,slogan,telefono,whatsapp,email_contacto,email_notificaciones,
        direccion,instagram_url,color_acento,color_fondo,moneda,duracion_turno_min,webhook_url,
        plan,suscripcion_estado,suscripcion_monto,suscripcion_moneda,suscripcion_tolerancia_hasta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18, CASE WHEN $19::integer > 0 THEN CURRENT_DATE + $19::integer ELSE NULL END)
      RETURNING *`,
      [slugNormalizado,nombre,slogan,telefono,whatsapp,email_contacto,email_notificaciones,
       direccion,instagram_url,color_acento||'#C9A84C',color_fondo||'#0D0D0D',
       moneda||'$',duracion_turno_min||30,webhook_url,
       plan.codigo,
       Number(config.dias_prueba || 0) > 0 ? 'prueba' : 'sin_suscripcion',
       plan.monto,
       config.mensualidad_moneda || 'UYU',
       Number(config.dias_prueba || 0)]
    );
    const comercioId = c.rows[0].id;

    // Crear usuario dueño
    const hash = await bcrypt.hash(duenoPassword, 10);
    await client.query(
      'INSERT INTO usuarios_comercio (comercio_id,email,password_hash,nombre,rol) VALUES ($1,$2,$3,$4,$5)',
      [comercioId, duenoEmailNormalizado, hash, duenoNombre || nombre, 'dueno']
    );

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
    const comercioActual = await pool.query(`
      SELECT id, plan, suscripcion_monto, suscripcion_moneda, suscripcion_mp_id
      FROM comercios
      WHERE id=$1
    `, [id]);
    if (!comercioActual.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    if (req.body.plan !== undefined) {
      if (!esCodigoPlanValido(req.body.plan)) {
        return res.status(400).json({ error: 'El plan seleccionado no es valido' });
      }
      const plan = obtenerPlan(req.body.plan);
      req.body.plan = plan.codigo;
      if (plan.codigo === 'inicial') {
        const profesionales = await pool.query(
          'SELECT COUNT(*)::integer AS total FROM trabajadores WHERE comercio_id=$1 AND activo=true',
          [id]
        );
        if (profesionales.rows[0].total > plan.limiteProfesionales) {
          return res.status(409).json({
            error: `No se puede asignar Agendate ${plan.nombre}: el comercio tiene ${profesionales.rows[0].total} profesionales activos y el plan admite hasta ${plan.limiteProfesionales}.`
          });
        }
      }
      req.body.suscripcion_monto = plan.monto;
    }

    if (req.body.suscripcion_monto !== undefined) {
      const nuevoMonto = Number(req.body.suscripcion_monto);
      if (!Number.isFinite(nuevoMonto) || nuevoMonto <= 0 || nuevoMonto > 1000000) {
        return res.status(400).json({ error: 'El monto de la suscripcion no es valido' });
      }
      if (comercioActual.rows[0].suscripcion_mp_id) {
        await actualizarSuscripcion(comercioActual.rows[0].suscripcion_mp_id, {
          auto_recurring: {
            transaction_amount: nuevoMonto,
            currency_id: req.body.suscripcion_moneda || comercioActual.rows[0].suscripcion_moneda || 'UYU'
          }
        });
      }
    }
    const campos = ['nombre','slogan','telefono','whatsapp','email_contacto','email_notificaciones',
      'direccion','instagram_url','color_acento','color_fondo','moneda','duracion_turno_min',
      'webhook_url','activo','plan','fecha_pago_hasta','suscripcion_estado',
      'suscripcion_monto','suscripcion_moneda','suscripcion_tolerancia_hasta'];
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

// GET /api/admin/mensualidades - historial global de cobros de Agendate
router.get('/mensualidades', authAdmin, async (req, res) => {
  try {
    const { estado, comercio_id: comercioId } = req.query;
    const filtros = [];
    const valores = [];

    if (estado) {
      valores.push(estado);
      filtros.push(`m.estado=$${valores.length}`);
    }
    if (comercioId) {
      valores.push(comercioId);
      filtros.push(`m.comercio_id=$${valores.length}`);
    }

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    const resultado = await pool.query(`
      SELECT m.*, c.nombre AS comercio_nombre, c.slug AS comercio_slug
      FROM mensualidades_plataforma m
      JOIN comercios c ON c.id=m.comercio_id
      ${where}
      ORDER BY m.creado_en DESC
      LIMIT 500
    `, valores);

    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/comercios/:id/mensualidades/manual
router.post('/comercios/:id/mensualidades/manual', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const meses = Number(req.body.meses || 1);
    const monto = Number(req.body.monto);
    if (!Number.isInteger(meses) || meses < 1 || meses > 24) {
      return res.status(400).json({ error: 'Los meses deben ser un numero entero entre 1 y 24' });
    }
    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ error: 'El monto debe ser mayor que cero' });
    }

    const comercio = await client.query(
      'SELECT id, suscripcion_moneda FROM comercios WHERE id=$1',
      [req.params.id]
    );
    if (!comercio.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    await client.query('BEGIN');
    const pago = await client.query(`
      INSERT INTO mensualidades_plataforma (
        comercio_id, proveedor, estado, monto, moneda,
        periodo_desde, periodo_hasta, pagado_en, detalle
      )
      VALUES (
        $1, 'manual', 'approved', $2, $3, CURRENT_DATE,
        (CURRENT_DATE + ($4::integer * INTERVAL '1 month'))::date,
        NOW(), $5
      )
      RETURNING *
    `, [
      req.params.id,
      monto,
      comercio.rows[0].suscripcion_moneda || 'UYU',
      meses,
      String(req.body.detalle || 'Pago registrado manualmente').slice(0, 500)
    ]);

    await client.query(`
      UPDATE comercios
      SET suscripcion_estado='activa',
          suscripcion_ultimo_pago_en=NOW(),
          fecha_pago_hasta=(CURRENT_DATE + ($1::integer * INTERVAL '1 month'))::date,
          suscripcion_tolerancia_hasta=NULL,
          actualizado_en=NOW()
      WHERE id=$2
    `, [meses, req.params.id]);

    await client.query('COMMIT');
    res.status(201).json(pago.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Estado de la cuenta Mercado Pago que cobra las mensualidades de Agendate.
router.get('/mercadopago', authAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(`
      SELECT mercadopago_platform_user_id AS user_id,
             mercadopago_platform_access_token IS NOT NULL AS conectado,
             mercadopago_platform_expires_at AS expira_en,
             mercadopago_platform_conectado_en AS conectado_en
      FROM configuracion_plataforma
      WHERE id=1
    `);
    const estado = resultado.rows[0] || {};

    res.json({
      conectado: Boolean(estado.conectado),
      user_id: estado.user_id || null,
      expira_en: estado.expira_en || null,
      conectado_en: estado.conectado_en || null,
      credenciales_disponibles: Boolean(
        process.env.MERCADOPAGO_CLIENT_ID && process.env.MERCADOPAGO_CLIENT_SECRET
      ),
      token_entorno_configurado: Boolean(process.env.MERCADOPAGO_PLATFORM_ACCESS_TOKEN)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/mercadopago/conectar', authAdmin, async (req, res) => {
  try {
    const token = await conectarMercadoPagoPlataforma();
    res.json({
      conectado: true,
      user_id: token.user_id ? String(token.user_id) : null,
      expira_en: token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
        : null
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /api/admin/configuracion - configuración general de Agendate
router.get('/configuracion', authAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT logo_url, mensualidad_monto, mensualidad_moneda, dias_prueba,
              dias_tolerancia, mercadopago_plan_comercial_id, mercadopago_plan_inicial_id, actualizado_en
       FROM configuracion_plataforma
       WHERE id=1`
    );

    res.json(
      resultado.rows[0] || {
        logo_url: null,
        mensualidad_monto: 1800,
        mensualidad_moneda: 'UYU',
        dias_prueba: 0,
        dias_tolerancia: 5,
        mercadopago_plan_comercial_id: null,
        mercadopago_plan_inicial_id: null,
        actualizado_en: null
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/configuracion - guardar logo general
router.put('/configuracion', authAdmin, async (req, res) => {
  try {
    const actualResult = await pool.query(`
      SELECT logo_url, mensualidad_monto, mensualidad_moneda, dias_prueba,
             dias_tolerancia, mercadopago_plan_comercial_id, mercadopago_plan_inicial_id
      FROM configuracion_plataforma
      WHERE id=1
    `);
    const actual = actualResult.rows[0] || {};
    const logoUrl = String(
      req.body.logo_url === undefined ? (actual.logo_url || '') : (req.body.logo_url || '')
    ).trim();
    const monto = 1800;
    const moneda = String(req.body.mensualidad_moneda || actual.mensualidad_moneda || 'UYU').trim().toUpperCase();
    const diasPrueba = Number(req.body.dias_prueba ?? actual.dias_prueba ?? 0);
    const diasTolerancia = Number(req.body.dias_tolerancia ?? actual.dias_tolerancia ?? 5);
    const planComercialId = String(
      req.body.mercadopago_plan_comercial_id ?? actual.mercadopago_plan_comercial_id ?? ''
    ).trim();
    const planInicialId = String(
      req.body.mercadopago_plan_inicial_id ?? actual.mercadopago_plan_inicial_id ?? ''
    ).trim();

    if (
      logoUrl &&
      (
        logoUrl.length > 500 ||
        !logoUrl.startsWith('https://res.cloudinary.com/')
      )
    ) {
      return res.status(400).json({
        error: 'La URL del logo no es válida'
      });
    }

    if (!Number.isFinite(monto) || monto <= 0 || monto > 1000000) {
      return res.status(400).json({ error: 'El monto de la mensualidad no es valido' });
    }
    if (!/^[A-Z]{3}$/.test(moneda)) {
      return res.status(400).json({ error: 'La moneda debe tener tres letras, por ejemplo UYU' });
    }
    if (!Number.isInteger(diasPrueba) || diasPrueba < 0 || diasPrueba > 365) {
      return res.status(400).json({ error: 'Los dias de prueba no son validos' });
    }
    if (!Number.isInteger(diasTolerancia) || diasTolerancia < 0 || diasTolerancia > 60) {
      return res.status(400).json({ error: 'Los dias de tolerancia no son validos' });
    }

    const resultado = await pool.query(
      `INSERT INTO configuracion_plataforma
        (id, logo_url, mensualidad_monto, mensualidad_moneda, dias_prueba,
         dias_tolerancia, mercadopago_plan_comercial_id, mercadopago_plan_inicial_id, actualizado_en)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())

       ON CONFLICT (id)
       DO UPDATE SET
         logo_url=EXCLUDED.logo_url,
         mensualidad_monto=EXCLUDED.mensualidad_monto,
         mensualidad_moneda=EXCLUDED.mensualidad_moneda,
         dias_prueba=EXCLUDED.dias_prueba,
         dias_tolerancia=EXCLUDED.dias_tolerancia,
         mercadopago_plan_comercial_id=EXCLUDED.mercadopago_plan_comercial_id,
         mercadopago_plan_inicial_id=EXCLUDED.mercadopago_plan_inicial_id,
         actualizado_en=NOW()

       RETURNING logo_url, mensualidad_monto, mensualidad_moneda, dias_prueba,
                 dias_tolerancia, mercadopago_plan_comercial_id, mercadopago_plan_inicial_id, actualizado_en`,
      [logoUrl || null, monto, moneda, diasPrueba, diasTolerancia, planComercialId || null, planInicialId || null]
    );

    res.json({
      ok: true,
      configuracion: resultado.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
