import { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api/responses";
import { lumaFetchJson } from "@/lib/luma/client";

type Params = {
  eventApiId: string;
  guestApiId: string;
};

type RouteContext = {
  params: Params | Promise<Params>;
};

type StatusBody = {
  status: "approved" | "declined";
  shouldRefund?: boolean;
};

async function readParams(context: RouteContext): Promise<Params> {
  if (context.params instanceof Promise) {
    return context.params;
  }

  return context.params;
}

function isStatusBody(value: unknown): value is StatusBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const status = record.status;

  if (status !== "approved" && status !== "declined") {
    return false;
  }

  if (
    record.shouldRefund !== undefined &&
    typeof record.shouldRefund !== "boolean"
  ) {
    return false;
  }

  return true;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { eventApiId, guestApiId } = await readParams(context);
    const body = (await request.json()) as unknown;

    if (!isStatusBody(body)) {
      return errorResponse(
        "Invalid body. Expected { status: 'approved' | 'declined', shouldRefund?: boolean }",
        400,
        "BAD_REQUEST",
      );
    }

    await lumaFetchJson<Record<string, never>>("/v1/event/update-guest-status", {
      method: "POST",
      body: {
        guest: {
          type: "api_id",
          api_id: guestApiId,
        },
        event_api_id: eventApiId,
        status: body.status,
        ...(body.status === "declined" && body.shouldRefund !== undefined
          ? { should_refund: body.shouldRefund }
          : {}),
      },
    });

    return successResponse({
      guestApiId,
      eventApiId,
      status: body.status,
    });
  } catch (error) {
    return handleRouteError(error, "Failed to update guest status");
  }
}
