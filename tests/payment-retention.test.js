const assert = require('assert');
const fs = require('fs');
const path = require('path');

const init = fs.readFileSync(path.join(__dirname, '../backend/db/init.js'), 'utf8');
const publico = fs.readFileSync(path.join(__dirname, '../backend/routes/publico.js'), 'utf8');
const pagos = fs.readFileSync(path.join(__dirname, '../backend/routes/pagos.js'), 'utf8');

assert.ok(init.includes('pago_retencion_vence_en TIMESTAMP'), 'La tabla reservas debe guardar vencimiento de retencion.');
assert.ok(init.includes('pago_retencion_expirada_en TIMESTAMP'), 'La tabla reservas debe guardar cuando expiro la retencion.');
assert.ok(init.includes('idx_reservas_retencion_pago'), 'Debe existir indice para limpiar retenciones pendientes.');

assert.ok(publico.includes('const RETENCION_PAGO_MINUTOS = 10'), 'La retencion publica debe durar 10 minutos.');
assert.ok(publico.includes('function expirarReservasPendientesPago'), 'La ruta publica debe limpiar pagos pendientes vencidos.');
assert.ok(publico.includes("estado='cancelada'"), 'Las retenciones vencidas deben liberar el horario.');
assert.ok(publico.includes("estado_pago='expirado'"), 'Las retenciones vencidas deben quedar marcadas como expiradas.');
assert.ok(publico.includes('pago_retencion_vence_en <= NOW()'), 'La limpieza debe comparar contra el vencimiento.');
assert.ok(publico.includes('await expirarReservasPendientesPago();'), 'La disponibilidad debe limpiar retenciones antes de responder.');
assert.ok(publico.includes('await expirarReservasPendientesPago(client);'), 'La reserva debe limpiar retenciones dentro de la transaccion.');
assert.ok(publico.includes('pago_retencion_vence_en'), 'La reserva pendiente debe guardar vencimiento.');
assert.ok(publico.includes('pg_advisory_xact_lock'), 'La reserva debe bloquear el slot dentro de la transaccion para evitar doble reserva simultanea.');

assert.ok(pagos.includes('function expirarReservasPendientesPago'), 'El webhook debe limpiar retenciones vencidas.');
assert.ok(pagos.includes('estadosPagoCancelanRetencion'), 'El webhook debe liberar retenciones rechazadas o canceladas.');
assert.ok(pagos.includes("estado_pago='pendiente'"), 'El webhook aprobado debe confirmar solo pagos pendientes.');
assert.ok(pagos.includes('pago_retencion_vence_en > NOW()'), 'El webhook aprobado no debe confirmar pagos vencidos.');

console.log('payment-retention.test ok');
