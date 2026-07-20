const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const publico = fs.readFileSync(path.join(__dirname, '../backend/routes/publico.js'), 'utf8');

assert.ok(html.includes('cargarResultadoPagoPublico'), 'El retorno de Mercado Pago debe cargar el estado real de la reserva.');
assert.ok(html.includes("estadoPago === 'pagado'"), 'La pantalla debe reconocer pagos aprobados.');
assert.ok(html.includes("estadoPago === 'expirado'"), 'La pantalla debe reconocer pagos vencidos.');
assert.ok(html.includes("estadoPago === 'cancelado'"), 'La pantalla debe reconocer pagos rechazados o cancelados.');
assert.ok(html.includes("return 'pendiente'"), 'La pantalla debe contemplar pagos pendientes.');
assert.ok(html.includes('setInterval(() =>'), 'La disponibilidad debe actualizarse de forma periódica.');
assert.ok(html.includes('}, 10000);'), 'La actualización de disponibilidad debe ejecutarse cada 10 segundos.');
assert.ok(html.includes('pcHorarioSigueDisponible'), 'Debe revalidarse el horario antes de confirmar.');
assert.ok(html.includes('pcVolverAHorariosPorConflicto'), 'Un conflicto debe devolver al usuario a la selección de horario.');
assert.ok(html.includes('este horario ya fue reservado'), 'El conflicto debe explicarse con un mensaje claro.');

assert.ok(publico.includes('await expirarReservasPendientesPago();'), 'La consulta pública debe actualizar retenciones vencidas.');
assert.ok(publico.includes('r.estado_pago'), 'La consulta pública debe devolver el estado del pago.');
assert.ok(publico.includes('r.mercadopago_status'), 'La consulta pública debe devolver el estado informado por Mercado Pago.');
assert.ok(publico.includes('pg_advisory_xact_lock'), 'El servidor debe conservar el bloqueo transaccional contra reservas simultáneas.');

console.log('payment-result-availability.test ok');
