require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
-- Tabla de super-admins (vos, el dueño de la plataforma)
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  creado_en TIMESTAMP DEFAULT NOW()
);

-- Tabla de comercios (cada cliente tuyo)
CREATE TABLE IF NOT EXISTS comercios (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) UNIQUE NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  slogan TEXT,
  descripcion TEXT,
  telefono VARCHAR(50),
  whatsapp VARCHAR(50),
  email_contacto VARCHAR(255),
  email_notificaciones VARCHAR(255),
  direccion TEXT,
  instagram_url VARCHAR(255),
  logo_url VARCHAR(500),
  color_acento VARCHAR(20) DEFAULT '#C9A84C',
  color_fondo VARCHAR(20) DEFAULT '#0D0D0D',
  moneda VARCHAR(10) DEFAULT '$',
  duracion_turno_min INTEGER DEFAULT 30,
  anticipacion_reserva_min INTEGER DEFAULT 0,
  anticipacion_cancelacion_min INTEGER DEFAULT 0,
    auto_confirmacion_activa BOOLEAN DEFAULT true,
  auto_recordatorio_activo BOOLEAN DEFAULT true,
  auto_recordatorio_horas_antes INTEGER DEFAULT 24,
  auto_cancelacion_activa BOOLEAN DEFAULT true,
  auto_agradecimiento_activo BOOLEAN DEFAULT false,
  auto_agradecimiento_horas_despues INTEGER DEFAULT 2,
  activo BOOLEAN DEFAULT true,
  plan VARCHAR(50) DEFAULT 'activo',
  fecha_pago_hasta DATE,
  webhook_url VARCHAR(500),
  imagen_fondo_url VARCHAR(500),
  creado_en TIMESTAMP DEFAULT NOW(),
  actualizado_en TIMESTAMP DEFAULT NOW()
);

-- Usuarios de cada comercio (dueño del comercio)
CREATE TABLE IF NOT EXISTS usuarios_comercio (
  id SERIAL PRIMARY KEY,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nombre VARCHAR(255) NOT NULL,
  rol VARCHAR(50) DEFAULT 'dueno',
  activo BOOLEAN DEFAULT true,
  creado_en TIMESTAMP DEFAULT NOW()
);

-- Servicios por comercio
CREATE TABLE IF NOT EXISTS servicios (
  id SERIAL PRIMARY KEY,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  nombre VARCHAR(255) NOT NULL,
  descripcion TEXT,
  precio NUMERIC(10,2) NOT NULL,
  duracion_min INTEGER NOT NULL,
  activo BOOLEAN DEFAULT true,
  orden INTEGER DEFAULT 0,
  imagen_url VARCHAR(500),
  creado_en TIMESTAMP DEFAULT NOW()
);

-- Trabajadores / profesionales por comercio
CREATE TABLE IF NOT EXISTS trabajadores (
  id SERIAL PRIMARY KEY,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  nombre VARCHAR(255) NOT NULL,
  descripcion TEXT,
  foto_url VARCHAR(500),
  activo BOOLEAN DEFAULT true,
  orden INTEGER DEFAULT 0,
  creado_en TIMESTAMP DEFAULT NOW()
);
-- Horarios por comercio (un registro por día de semana)
CREATE TABLE IF NOT EXISTS horarios (
  id SERIAL PRIMARY KEY,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6), -- 0=Dom, 1=Lun...6=Sab
  abre TIME,
  cierra TIME,
  activo BOOLEAN DEFAULT true,
  UNIQUE(comercio_id, dia_semana)
);

-- Bloques de horario (para horarios divididos con descansos)
CREATE TABLE IF NOT EXISTS horario_bloques (
  id SERIAL PRIMARY KEY,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  abre TIME NOT NULL,
  cierra TIME NOT NULL,
  orden INTEGER DEFAULT 0
);

-- Bloques de horario por trabajador/profesional
CREATE TABLE IF NOT EXISTS trabajador_horario_bloques (
  id SERIAL PRIMARY KEY,
  trabajador_id INTEGER REFERENCES trabajadores(id) ON DELETE CASCADE,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  abre TIME NOT NULL,
  cierra TIME NOT NULL,
  orden INTEGER DEFAULT 0
);

-- Reservas
CREATE TABLE IF NOT EXISTS reservas (
  id SERIAL PRIMARY KEY,
  uuid VARCHAR(36) UNIQUE NOT NULL,
  comercio_id INTEGER REFERENCES comercios(id) ON DELETE CASCADE,
  servicio_id INTEGER REFERENCES servicios(id),
  trabajador_id INTEGER REFERENCES trabajadores(id) ON DELETE SET NULL,
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  duracion_min INTEGER NOT NULL,
  cliente_nombre VARCHAR(255) NOT NULL,
  cliente_apellido VARCHAR(255) NOT NULL,
  cliente_whatsapp VARCHAR(50) NOT NULL,
  cliente_email VARCHAR(255),
  comentarios TEXT,
    estado VARCHAR(50) DEFAULT 'confirmada', -- confirmada, cancelada, completada
  confirmacion_enviada BOOLEAN DEFAULT false,
  confirmacion_enviada_en TIMESTAMP,
  recordatorio_enviado BOOLEAN DEFAULT false,
  recordatorio_enviado_en TIMESTAMP,
  cancelacion_enviada BOOLEAN DEFAULT false,
  cancelacion_enviada_en TIMESTAMP,
  cancelada_por_cliente_en TIMESTAMP,
  creado_en TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_reservas_comercio_fecha ON reservas(comercio_id, fecha);
CREATE INDEX IF NOT EXISTS idx_servicios_comercio ON servicios(comercio_id);
CREATE INDEX IF NOT EXISTS idx_trabajadores_comercio ON trabajadores(comercio_id);
CREATE INDEX IF NOT EXISTS idx_horarios_comercio ON horarios(comercio_id);
CREATE INDEX IF NOT EXISTS idx_horario_bloques_comercio ON horario_bloques(comercio_id, dia_semana);
CREATE INDEX IF NOT EXISTS idx_reservas_trabajador_fecha ON reservas(trabajador_id, fecha);
CREATE INDEX IF NOT EXISTS idx_trabajador_horario_bloques ON trabajador_horario_bloques(trabajador_id, dia_semana);

-- Columnas nuevas (para migraciones en BD existente - ignorar si ya existen)
DO $$ BEGIN
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS imagen_fondo_url VARCHAR(500);
  ALTER TABLE comercios ALTER COLUMN slogan TYPE TEXT;
  ALTER TABLE servicios ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);
  ALTER TABLE servicios ADD COLUMN IF NOT EXISTS trabajador_id INTEGER REFERENCES trabajadores(id) ON DELETE SET NULL;
    ALTER TABLE comercios ADD COLUMN IF NOT EXISTS auto_confirmacion_activa BOOLEAN DEFAULT true;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS auto_recordatorio_activo BOOLEAN DEFAULT true;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS auto_recordatorio_horas_antes INTEGER DEFAULT 24;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS auto_cancelacion_activa BOOLEAN DEFAULT true;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS auto_agradecimiento_activo BOOLEAN DEFAULT false;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS auto_agradecimiento_horas_despues INTEGER DEFAULT 2;
  CREATE INDEX IF NOT EXISTS idx_servicios_trabajador ON servicios(trabajador_id);
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS trabajador_id INTEGER REFERENCES trabajadores(id) ON DELETE SET NULL;
   ALTER TABLE reservas ADD COLUMN IF NOT EXISTS confirmacion_enviada BOOLEAN DEFAULT false;
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS confirmacion_enviada_en TIMESTAMP;
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS recordatorio_enviado BOOLEAN DEFAULT false;
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS recordatorio_enviado_en TIMESTAMP;
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cancelacion_enviada BOOLEAN DEFAULT false;
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cancelacion_enviada_en TIMESTAMP;
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cancelada_por_cliente_en TIMESTAMP;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS anticipacion_reserva_min INTEGER DEFAULT 0;
  ALTER TABLE comercios ADD COLUMN IF NOT EXISTS anticipacion_cancelacion_min INTEGER DEFAULT 0;
EXCEPTION WHEN others THEN NULL;
END $$;
`;

async function init() {
  const client = await pool.connect();
  try {
    console.log('Creando tablas...');
    await client.query(SQL);

    // Crear super-admin si no existe
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@agendate.com';
    const adminPass  = process.env.ADMIN_PASSWORD || 'admin123';
    const existing = await client.query('SELECT id FROM admins WHERE email=$1', [adminEmail]);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(adminPass, 10);
      await client.query(
        'INSERT INTO admins (email, password_hash, nombre) VALUES ($1,$2,$3)',
        [adminEmail, hash, 'Super Admin']
      );
      console.log(`Admin creado: ${adminEmail} / ${adminPass}`);
    }

    console.log('Base de datos inicializada correctamente');
  } finally {
    client.release();
    pool.end();
  }
}

init().catch(err => { console.error('Error:', err); process.exit(1); });
