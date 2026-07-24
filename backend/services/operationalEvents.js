const pool = require('../db/pool');

const NIVELES = new Set(['info', 'warning', 'error', 'critical']);
let limpiezaIniciada = false;

function textoSeguro(valor, maximo) {
  return String(valor ?? '').trim().slice(0, maximo);
}

function contextoSeguro(contexto) {
  if (!contexto || typeof contexto !== 'object' || Array.isArray(contexto)) return {};

  return Object.fromEntries(
    Object.entries(contexto)
      .slice(0, 20)
      .map(([clave, valor]) => {
        if (valor === null || ['boolean', 'number'].includes(typeof valor)) return [clave, valor];
        return [clave, textoSeguro(valor, 300)];
      })
  );
}

async function limpiarEventosAntiguos(db = pool) {
  return db.query("DELETE FROM eventos_sistema WHERE creado_en < NOW() - INTERVAL '90 days'");
}

async function registrarEvento({
  nivel = 'error',
  categoria = 'sistema',
  codigo,
  mensaje,
  comercioId = null,
  reservaId = null,
  contexto = {}
}, db = pool) {
  const nivelFinal = NIVELES.has(nivel) ? nivel : 'error';
  const categoriaFinal = textoSeguro(categoria, 60) || 'sistema';
  const codigoFinal = textoSeguro(codigo, 100) || 'evento_sin_codigo';
  const mensajeFinal = textoSeguro(mensaje, 1000) || 'Evento operativo sin detalle';

  try {
    if (!limpiezaIniciada) {
      limpiezaIniciada = true;
      limpiarEventosAntiguos(db).catch(error => {
        console.error('No se pudieron limpiar eventos antiguos:', error.message);
      });
    }

    await db.query(
      `INSERT INTO eventos_sistema (
         nivel, categoria, codigo, mensaje, comercio_id, reserva_id, contexto
       )
       SELECT
         $1::varchar(20),
         $2::varchar(60),
         $3::varchar(100),
         $4::text,
         $5::integer,
         $6::integer,
         $7::jsonb
       WHERE NOT EXISTS (
         SELECT 1
         FROM eventos_sistema
         WHERE codigo=$3::varchar(100)
           AND comercio_id IS NOT DISTINCT FROM $5::integer
           AND reserva_id IS NOT DISTINCT FROM $6::integer
           AND creado_en > NOW() - INTERVAL '5 minutes'
       )`,
      [
        nivelFinal,
        categoriaFinal,
        codigoFinal,
        mensajeFinal,
        comercioId,
        reservaId,
        JSON.stringify(contextoSeguro(contexto))
      ]
    );
  } catch (error) {
    console.error('No se pudo registrar evento operativo:', error.message);
  }
}

module.exports = {
  contextoSeguro,
  limpiarEventosAntiguos,
  registrarEvento
};
