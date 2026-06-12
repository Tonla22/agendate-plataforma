# Agendaté — Plataforma Multi-Tenant de Reservas

Plataforma SaaS donde cada comercio tiene su propia página pública bajo el mismo dominio.

```
agendate.com/mc-barber-studio
agendate.com/peluqueria-central
agendate.com/barber-john
```

---

## Arquitectura

```
agendate/
├── backend/
│   ├── db/
│   │   ├── init.js        ← Crea tablas y super-admin inicial
│   │   └── pool.js        ← Conexión PostgreSQL
│   ├── middleware/
│   │   └── auth.js        ← JWT para admin y comercios
│   ├── routes/
│   │   ├── auth.js        ← Login admin y comercios
│   │   ├── admin.js       ← API del super-admin (vos)
│   │   ├── comercio.js    ← API del dueño de cada comercio
│   │   └── publico.js     ← API pública sin autenticación
│   ├── server.js          ← Express app principal
│   ├── package.json
│   └── .env.example       ← Copiar a .env y completar
└── frontend/
    └── index.html         ← SPA completa (todas las vistas)
```

---

## Stack recomendado para producción

| Servicio        | Opción recomendada          | Costo aprox.  |
|-----------------|-----------------------------|---------------|
| Servidor Node   | Railway / Render (free tier)| Gratis/~$5    |
| Base de datos   | Neon.tech (PostgreSQL)      | Gratis        |
| Dominio         | Namecheap / Cloudflare      | ~$10/año      |
| CDN + SSL       | Cloudflare (proxy)          | Gratis        |

**Total para empezar: ~$0–$10/mes**

---

## Deploy paso a paso

### 1. Clonar y configurar

```bash
cd backend
cp .env.example .env
# Editá .env con tus datos
npm install
```

### 2. Crear base de datos (Neon.tech — gratis)

1. Ir a https://neon.tech → crear cuenta → crear proyecto
2. Copiar la `DATABASE_URL` que te dan
3. Pegarla en `.env`

### 3. Inicializar la base de datos

```bash
npm run db:init
# Esto crea todas las tablas y el super-admin
```

### 4. Arrancar el servidor

```bash
npm run dev       # desarrollo
npm start         # producción
```

### 5. Deploy en Railway (recomendado)

```bash
# Instalar Railway CLI
npm install -g @railway/cli
railway login
railway init
railway add postgresql    # crea la DB automáticamente
railway up
```

O simplemente:
1. Subir el código a GitHub
2. Crear cuenta en https://railway.app
3. "New project" → conectar repo → agregar PostgreSQL plugin
4. Las variables de entorno se setean en el dashboard

---

## Variables de entorno (.env)

```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=una_cadena_muy_larga_y_aleatoria_aqui
PORT=3000
BASE_URL=https://agendate.com
ADMIN_EMAIL=tu@email.com
ADMIN_PASSWORD=tu_contraseña_segura
```

---

## Flujo de uso

### Vos (super-admin)
1. Entrás a `agendate.com/login` → tab "Super Admin"
2. Creás un nuevo comercio con toda su configuración
3. Le das al dueño su email y contraseña

### El dueño del comercio
1. Entra a `agendate.com/login` → tab "Mi Comercio"
2. Gestiona reservas, servicios, horarios y perfil
3. Su página pública es `agendate.com/su-slug`

### El cliente final
1. Entra a `agendate.com/el-slug-del-comercio`
2. Elige servicio → fecha → hora → datos
3. Recibe confirmación por WhatsApp

---

## API Reference

### Pública (sin auth)
```
GET  /api/p/:slug                         Datos del comercio
GET  /api/p/:slug/disponibilidad?fecha=&servicio_id=   Horas libres
POST /api/p/:slug/reservar                Crear reserva
```

### Admin
```
GET    /api/admin/stats                   Métricas globales
GET    /api/admin/comercios               Lista comercios
POST   /api/admin/comercios               Crear comercio
PUT    /api/admin/comercios/:id           Editar comercio
DELETE /api/admin/comercios/:id           Eliminar comercio
```

### Comercio (dueño)
```
GET  /api/comercio/:slug/perfil           Ver perfil completo
PUT  /api/comercio/:slug/perfil           Editar perfil
PUT  /api/comercio/:slug/horarios         Guardar horarios
GET  /api/comercio/:slug/servicios        Lista servicios
POST /api/comercio/:slug/servicios        Crear servicio
PUT  /api/comercio/:slug/servicios/:id    Editar servicio
DEL  /api/comercio/:slug/servicios/:id    Eliminar servicio
GET  /api/comercio/:slug/reservas         Ver reservas
PUT  /api/comercio/:slug/reservas/:id/estado  Cambiar estado
```

---

## Integración con n8n / Google Calendar

Al crear cada comercio, configurás el `webhook_url`.
Cuando se hace una reserva, la plataforma envía automáticamente:

```json
{
  "evento": "nueva_reserva",
  "uuid": "abc-123...",
  "comercio": { "nombre": "El Navajón", "slug": "el-najajon" },
  "servicio": "Corte clásico",
  "precio": 500,
  "fecha": "2025-08-15",
  "hora": "10:00",
  "cliente": {
    "nombre": "Juan García",
    "whatsapp": "+59891234567",
    "email": "juan@gmail.com"
  }
}
```

En n8n: Webhook → Google Calendar (crear evento) → WhatsApp (notificar dueño)

---

## Cobro a clientes

Modelo recomendado:
- **Setup:** $XX por configurar el comercio y dejarlo listo
- **Mensualidad:** $XX/mes por tener la página activa

Para desactivar un comercio que no paga:
→ En el panel admin, botón "Desactivar" → la página muestra "comercio inactivo"

