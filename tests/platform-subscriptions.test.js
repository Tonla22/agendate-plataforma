const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const init = fs.readFileSync(path.join(root, 'backend', 'db', 'init.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'backend', 'routes', 'admin.js'), 'utf8');
const subscriptions = fs.readFileSync(path.join(root, 'backend', 'routes', 'suscripciones.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'backend', 'services', 'platformSubscriptions.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');

assert.match(init, /CREATE TABLE IF NOT EXISTS mensualidades_plataforma/);
assert.match(init, /suscripcion_estado VARCHAR\(40\)/);
assert.match(init, /mensualidad_monto NUMERIC\(10,2\)/);
assert.match(init, /dias_tolerancia INTEGER/);
assert.match(init, /mercadopago_platform_access_token TEXT/);
assert.match(init, /mercadopago_platform_refresh_token TEXT/);

assert.match(server, /app\.use\('\/api\/suscripciones'/);
assert.match(service, /MERCADOPAGO_PLATFORM_ACCESS_TOKEN/);
assert.doesNotMatch(service, /comercio\.mercadopago_access_token/);
assert.match(service, /grant_type: 'refresh_token'/);
assert.match(service, /grant_type: 'client_credentials'/);
assert.match(service, /conectarMercadoPagoPlataforma/);
assert.match(service, /external_reference: externalReferenceComercio/);
assert.match(service, /notification_url/);
assert.match(service, /status: 'pending'/);
assert.match(service, /authorized_payments/);

assert.match(subscriptions, /router\.post\('\/:slug\/iniciar'/);
assert.match(subscriptions, /router\.post\('\/webhook\/mercadopago'/);
assert.match(subscriptions, /MERCADOPAGO_PLATFORM_WEBHOOK_SECRET/);
assert.match(subscriptions, /timingSafeEqual/);
assert.match(subscriptions, /subscription_authorized_payment/);
assert.doesNotMatch(subscriptions, /mercadopago\/oauth\/callback/);
assert.match(subscriptions, /INSERT INTO mensualidades_plataforma/);
assert.match(subscriptions, /suscripcion_tolerancia_hasta/);
assert.match(subscriptions, /suscripcion_estado=\$1::varchar\(40\)/);

assert.match(admin, /router\.get\('\/mensualidades'/);
assert.match(admin, /mensualidades\/manual'/);
assert.match(admin, /ingresos_mes/);
assert.match(admin, /router\.post\('\/mercadopago\/conectar'/);
assert.doesNotMatch(admin, /mercadopago\/desconectar/);

assert.match(frontend, /id="an-mensualidades"/);
assert.doesNotMatch(frontend, /id="an-reservas"/);
assert.doesNotMatch(frontend, /id="cn-suscripcion"/);
assert.doesNotMatch(frontend, /id="com-suscripcion"/);
assert.match(frontend, /function renderSuscripcionPerfil\(data\)/);
assert.match(frontend, /\$\{suscripcion \? renderSuscripcionPerfil\(suscripcion\) : ''\}/);
assert.match(frontend, /conectarMercadoPagoPlataforma/);
assert.match(frontend, /activarSuscripcionComercio/);

console.log('platform-subscriptions.test ok');
