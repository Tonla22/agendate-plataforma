(function (root) {
  function normalizarTelefonoWhatsApp(valor) {
    let numero = String(valor || '').replace(/\D/g, '');
    if (!numero) return '';

    if (numero.startsWith('00')) {
      numero = numero.slice(2);
    }

    if (/^09\d{7}$/.test(numero)) {
      numero = `598${numero.slice(1)}`;
    } else if (/^9\d{7}$/.test(numero)) {
      numero = `598${numero}`;
    }

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
