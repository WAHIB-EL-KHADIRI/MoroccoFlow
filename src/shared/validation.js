export const patterns = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  moroccanPhone: /^(?:\+212|0)[5-7]\d{8}$/,
  ice: /^\d{15}$/,
};

export function validateClient(values) {
  const errors = {};
  if (!values.name?.trim() || values.name.trim().length < 2) errors.name = "Nom requis";
  if (!values.company?.trim()) errors.company = "Entreprise requise";
  if (!patterns.email.test(values.email || "")) errors.email = "E-mail invalide";
  if (!patterns.moroccanPhone.test((values.phone || "").replaceAll(" ", ""))) {
    errors.phone = "Téléphone marocain invalide";
  }
  return errors;
}

export function validateInvoice(values) {
  const errors = {};
  if (!values.clientId) errors.clientId = "Client requis";
  if (!values.number?.trim()) errors.number = "Numéro requis";
  if (!values.date) errors.date = "Date requise";
  if (!Number.isFinite(Number(values.amount)) || Number(values.amount) <= 0) {
    errors.amount = "Le montant doit être supérieur à zéro";
  }
  return errors;
}
