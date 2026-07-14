(function (root) {
  function normalizarTelefonoWhatsApp(valor) {
    const numero = String(valor || '').replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(numero)) return '';
    return numero;
  }

  function crearWhatsappUrl(numero, mensaje) {
    const normalizado = normalizarTelefonoWhatsApp(numero);
    if (!normalizado) return '';

    const texto = String(mensaje || '').trim();
    if (!texto) return `https://wa.me/${normalizado}`;

    return `https://wa.me/${normalizado}?text=${encodeURIComponent(texto)}`;
  }

  const api = {
    normalizarTelefonoWhatsApp,
    crearWhatsappUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.AgendateWhatsApp = api;
})(typeof window !== 'undefined' ? window : globalThis);
