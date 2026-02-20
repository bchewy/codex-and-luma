import { NextResponse } from "next/server";

import { LumaApiError } from "@/lib/luma/client";
import type { ApiError, ApiSuccess } from "@/lib/luma/types";

export function successResponse<T>(data: T, status = 200) {
  const payload: ApiSuccess<T> = {
    ok: true,
    data,
  };

  return NextResponse.json(payload, { status });
}

export function errorResponse(
  message: string,
  status = 500,
  code?: string,
  details?: unknown,
) {
  const payload: ApiError = {
    ok: false,
    error: {
      message,
      status,
      code,
      details,
    },
  };

  return NextResponse.json(payload, { status });
}

export function handleRouteError(
  error: unknown,
  fallbackMessage = "Unexpected server error",
) {
  if (error instanceof LumaApiError) {
    return errorResponse(error.message, error.status, "LUMA_API_ERROR", error.body);
  }

  if (error instanceof Error) {
    return errorResponse(error.message || fallbackMessage, 500, "INTERNAL_ERROR");
  }

  return errorResponse(fallbackMessage, 500, "UNKNOWN_ERROR");
}
