-- ============================================================
-- AGENDATE — Esquema PostgreSQL
-- Ejecutar: psql -d agendate -f schema.sql
-- ============================================================

-- Extensiones
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ============================================================
-- TABLA: admins (superadmin de la plataforma)
-- ============================================================
CREATE TABLE IF NOT EXISTS admins (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  nombre      VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLA: comercios (cada tenant / cliente tuyo)
-- ============================================================
CREATE TABLE IF NOT EXISTS comercios (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            VARCHAR(100) UNIQUE NOT NULL,        -- mc-barber-studio
  nombre          VARCHAR(255) NOT NULL,
  slogan          VARCHAR(500),
  tipo            VARCHAR(100) DEFAULT 'barbería',     -- barbería, peluquería, etc.
  telefono        VARCHAR(50),
  whatsapp        VARCHAR(50),                         -- solo números
  email           VARCHAR(255),
  direccion       TEXT,
  instagram_url   VARCHAR(500),
  logo_url        VARCHAR(500),
  moneda          VARCHAR(10) DEFAULT '$',
  color_acento    VARCHAR(20) DEFAULT '#C9A84C',
  color_fondo     VARCHAR(20) DEFAULT '#0D0D0D',
  color_tarjeta   VARCHAR(20) DEFAULT '#1A1A1A',
  color_texto     VARCHAR(20) DEFAULT '#F5F0E8',
  activo          BOOLEAN DEFAULT TRUE,
  -- Acceso del comercio a su panel
  panel_email     VARCHAR(255),
  panel_password  VARCHAR(255),
  -- Facturación
  fecha_setup     DATE DEFAULT CURRENT_DATE,
  mensualidad_usd DECIMAL(10,2) DEFAULT 0,
  proximo_pago    DATE,
  estado_pago     VARCHAR(50) DEFAULT 'activo',        -- activo, atrasado, suspendido
  notas_admin     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comercios_slug ON comercios(slug);
CREATE INDEX idx_comercios_activo ON comercios(activo);

-- ============================================================
-- TABLA: horarios (por comercio, por día)
-- ============================================================
CREATE TABLE IF NOT EXISTS horarios (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comercio_id   UUID NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
  dia           VARCHAR(20) NOT NULL,   -- Lunes, Martes, ...
  abre          TIME,                   -- NULL = cerrado ese día
  cierra        TIME,
  cerrado       BOOLEAN DEFAULT FALSE,
  UNIQUE(comercio_id, dia)
);

CREATE INDEX idx_horarios_comercio ON horarios(comercio_id);

-- ============================================================
-- TABLA: servicios (por comercio)
-- ============================================================
CREATE TABLE IF NOT EXISTS servicios (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comercio_id   UUID NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
  nombre        VARCHAR(255) NOT NULL,
  descripcion   TEXT,
  precio        DECIMAL(10,2) NOT NULL,
  duracion_min  INTEGER NOT NULL DEFAULT 30,
  activo        BOOLEAN DEFAULT TRUE,
  orden         INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_servicios_comercio ON servicios(comercio_id);

-- ============================================================
-- TABLA: reservas
-- ============================================================
CREATE TABLE IF NOT EXISTS reservas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comercio_id     UUID NOT NULL REFERENCES comercios(id) ON DELETE CASCADE,
  servicio_id     UUID NOT NULL REFERENCES servicios(id),
  -- Datos del cliente
  cliente_nombre  VARCHAR(255) NOT NULL,
  cliente_wa      VARCHAR(50) NOT NULL,
  cliente_email   VARCHAR(255),
  comentarios     TEXT,
  -- Fecha y hora
  fecha           DATE NOT NULL,
  hora_inicio     TIME NOT NULL,
  hora_fin        TIME NOT NULL,
  -- Estado
  estado          VARCHAR(50) DEFAULT 'confirmada',  -- confirmada, cancelada, completada, no_show
  -- Precio al momento de reservar (snapshot)
  precio          DECIMAL(10,2) NOT NULL,
  -- Metadatos
  ip_origen       VARCHAR(50),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reservas_comercio ON reservas(comercio_id);
CREATE INDEX idx_reservas_fecha ON reservas(comercio_id, fecha);
CREATE INDEX idx_reservas_estado ON reservas(estado);

-- ============================================================
-- FUNCIÓN: actualizar updated_at automáticamente
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_comercios_updated
  BEFORE UPDATE ON comercios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_reservas_updated
  BEFORE UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- VISTA: ocupación por comercio (útil para el admin)
-- ============================================================
CREATE OR REPLACE VIEW vista_resumen_comercios AS
SELECT
  c.id,
  c.slug,
  c.nombre,
  c.activo,
  c.estado_pago,
  c.mensualidad_usd,
  c.proximo_pago,
  COUNT(DISTINCT s.id) AS total_servicios,
  COUNT(DISTINCT r.id) AS total_reservas,
  COUNT(DISTINCT CASE WHEN r.fecha >= CURRENT_DATE THEN r.id END) AS reservas_futuras
FROM comercios c
LEFT JOIN servicios s ON s.comercio_id = c.id AND s.activo = TRUE
LEFT JOIN reservas r ON r.comercio_id = c.id AND r.estado != 'cancelada'
GROUP BY c.id;
