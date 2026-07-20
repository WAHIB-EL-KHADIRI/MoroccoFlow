export class AppError extends Error {
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFound = (resource = "Resource") =>
  new AppError("NOT_FOUND", `${resource} was not found`, 404);

export const forbidden = () =>
  new AppError("FORBIDDEN", "You do not have permission to perform this action", 403);

export const conflict = (message = "The resource was changed by another user") =>
  new AppError("CONFLICT", message, 409);
