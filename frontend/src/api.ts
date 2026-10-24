export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Same contract as the legacy vanilla client:
 * JSON in/out, session cookie, 401 -> /login?expired=1.
 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (response.status === 401) {
    window.location.replace("/login?expired=1");
    throw new ApiError("Сессия завершилась. Войдите снова.", 401);
  }
  const contentType = response.headers.get("content-type") || "";
  const payload: unknown = contentType.includes("json")
    ? await response.json().catch(() => ({}))
    : await response.text();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "detail" in payload
        ? String((payload as { detail?: unknown }).detail || `Ошибка ${response.status}`)
        : typeof payload === "string" && payload
          ? payload
          : `Ошибка ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}
