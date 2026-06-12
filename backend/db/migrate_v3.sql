-- ============================================================
-- MIGRACIÓN v3 — Nuevas funcionalidades
-- Ejecutar en BD existente: psql -d agendate -f migrate_v3.sql
-- ============================================================

-- 1. Imagen de fondo para el comercio
ALTER TABLE comercios ADD COLUMN IF NOT EXISTS imagen_fondo_url VARCHAR(500);

-- 2. Imagen para cada servicio
ALTER TABLE servicios ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);

-- 3. Tabla de bloques de horario (para descansos / horario partido)
CREATE TABLE IF NOT EXISTS horario_bloques (
  id          SERIAL PRIMARY KEY,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  dia_semana  INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  abre        TIME NOT NULL,
  cierra      TIME NOT NULL,
  orden       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_horario_bloques_comercio ON horario_bloques(comercio_id, dia_semana);

-- Verificar
DO $$
BEGIN
  RAISE NOTICE 'Migración v3 completada:';
  RAISE NOTICE '  ✓ comercios.imagen_fondo_url';
  RAISE NOTICE '  ✓ servicios.imagen_url';
  RAISE NOTICE '  ✓ tabla horario_bloques';
END $$;
