import { AppError } from "../../lib/errors.js";

/**
 * draft ──► sent ──► accepted   (only through POST /quotes/:id/accept)
 *   │         ├────► rejected
 *   └─────────┴────► cancelled
 *
 * "expired" is never stored: a draft or sent quote whose valid_until is before the
 * tenant's business date is expired, and can no longer be accepted.
 */
export const QUOTE_STATUSES = ["draft", "sent", "accepted", "rejected", "cancelled"];

/** Statuses a client may write directly; "accepted" has its own transaction. */
export const WRITABLE_QUOTE_STATUSES = ["draft", "sent", "rejected", "cancelled"];
export const CREATABLE_QUOTE_STATUSES = ["draft", "sent"];

const transitions = {
  draft: ["draft", "sent", "cancelled"],
  sent: ["sent", "rejected", "cancelled"],
};

export function isOpen(status) {
  return status === "draft" || status === "sent";
}

export function quoteLocked(status) {
  return new AppError("QUOTE_LOCKED", `A ${status} quote can no longer be changed`, 409);
}

/** Throws unless `patch` is a legal change to the stored quote `before`. */
export function assertQuoteUpdate(before, patch) {
  if (!isOpen(before.status)) throw quoteLocked(before.status);
  if (patch.status !== undefined && !transitions[before.status].includes(patch.status)) {
    throw new AppError(
      "INVALID_TRANSITION",
      `A ${before.status} quote cannot become ${patch.status}`,
      409,
    );
  }
}

/** An accepted quote owns a project and a payment obligation: it is never deleted. */
export function assertQuoteDeletable(before) {
  if (before.status === "accepted") throw quoteLocked(before.status);
}

/** Server-side display status: adds the derived "expired" to the stored one. */
export function effectiveQuoteStatus(status, expired) {
  return isOpen(status) && expired ? "expired" : status;
}
