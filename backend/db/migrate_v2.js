require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const SQL = `
-- ============================================================
-- MIGRACIÓN v2: imágenes, bloques horarios, descansos
-- ============================================================

-- 1. Imagen de fondo para la página pública del comercio
ALTER TABLE comercios ADD COLUMN IF NOT EXISTS fondo_url VARCHAR(500);

-- 2. Imagen por servicio
ALTER TABLE servicios ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);

-- 3. Tabla de bloques horarios (reemplaza el único abre/cierra por día)
--    Cada día puede tener 1..N bloques (por ej. 09:00-13:00 y 15:00-19:00)
CREATE TABLE IF NOT EXISTS horarios_bloques (
  id           SERIAL PRIMARY KEY,
  comercio_id  INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  dia_semana   INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  abre         TIME NOT NULL,
  cierra       TIME NOT NULL,
  orden        INTEGER DEFAULT 0,
  activo       BOOLEAN DEFAULT true,
  CONSTRAINT bloques_no_solapados CHECK (abre < cierra)
);

CREATE INDEX IF NOT EXISTS idx_horarios_bloques_comercio ON horarios_bloques(comercio_id, dia_semana);

-- Migrar horarios existentes a la nueva tabla de bloques
INSERT INTO horarios_bloques (comercio_id, dia_semana, abre, cierra, orden, activo)
SELECT comercio_id, dia_semana, abre, cierra, 0, activo
FROM horarios
WHERE abre IS NOT NULL AND cierra IS NOT NULL AND activo = true
ON CONFLICT DO NOTHING;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Aplicando migración v2...');
    await client.query(SQL);
    console.log('✅ Migración v2 aplicada correctamente');
  } catch(err) {
    console.error('Error en migración:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
