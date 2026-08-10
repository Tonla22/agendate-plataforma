const PLANES = Object.freeze({
  inicial: Object.freeze({
    codigo: 'inicial',
    nombre: 'Inicial',
    monto: 1200,
    limiteProfesionales: 2
  }),
  comercial: Object.freeze({
    codigo: 'comercial',
    nombre: 'Comercial',
    monto: 1800,
    limiteProfesionales: null
  })
});

function normalizarCodigoPlan(valor, fallback = 'comercial') {
  const codigo = String(valor || '').trim().toLowerCase();
  if (codigo === 'esencial') return 'inicial';
  return PLANES[codigo] ? codigo : fallback;
}

function obtenerPlan(valor) {
  return PLANES[normalizarCodigoPlan(valor)];
}

function esCodigoPlanValido(valor) {
  const codigo = String(valor || '').trim().toLowerCase();
  return codigo === 'esencial' || Boolean(PLANES[codigo]);
}

module.exports = {
  PLANES,
  esCodigoPlanValido,
  normalizarCodigoPlan,
  obtenerPlan
};
