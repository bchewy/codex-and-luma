import { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api/responses";
import { lumaFetchJson } from "@/lib/luma/client";
import { mapGuestEntryToReviewRecord } from "@/lib/luma/mappers";
import {
  GUEST_STATUSES,
  createEmptyStatusCounts,
  type GuestStatus,
  type LumaGuestEntryRaw,
  type LumaPaginatedResponse,
} from "@/lib/luma/types";

type Params = {
  eventApiId: string;
};

type RouteContext = {
  params: Params | Promise<Params>;
};

function isGuestStatus(value: string): value is GuestStatus {
  return GUEST_STATUSES.includes(value as GuestStatus);
}

async function readParams(context: RouteContext): Promise<Params> {
  if (context.params instanceof Promise) {
    return context.params;
  }

  return context.params;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { eventApiId } = await readParams(context);
    const eventId = request.nextUrl.searchParams.get("eventId")?.trim();

    if (!eventId) {
      return errorResponse("Missing required query param: eventId", 400, "BAD_REQUEST");
    }

    const approvalStatus = request.nextUrl.searchParams
      .get("approvalStatus")
      ?.trim();

    if (approvalStatus && approvalStatus !== "all" && !isGuestStatus(approvalStatus)) {
      return errorResponse(
        "Invalid approvalStatus. Use one of approved, session, pending_approval, invited, declined, waitlist, all",
        400,
        "BAD_REQUEST",
      );
    }

    let cursor: string | null | undefined;
    let page = 0;
    const entries: LumaGuestEntryRaw[] = [];

    do {
      const payload = await lumaFetchJson<LumaPaginatedResponse<LumaGuestEntryRaw>>(
        "/v1/event/get-guests",
        {
          query: {
            event_id: eventId,
            approval_status:
              approvalStatus && approvalStatus !== "all" ? approvalStatus : undefined,
            pagination_limit: 200,
            pagination_cursor: cursor,
            sort_column: "created_at",
            sort_direction: "desc",
          },
        },
      );

      entries.push(...(payload.entries ?? []));
      cursor = payload.next_cursor;
      page += 1;
    } while (cursor && page < 30);

    const guests = entries.map((entry) =>
      mapGuestEntryToReviewRecord(entry, {
        eventId,
        eventApiId,
      }),
    );

    const countsByStatus = createEmptyStatusCounts();

    for (const guest of guests) {
      countsByStatus[guest.approvalStatus] += 1;
      countsByStatus.total += 1;
    }

    return successResponse({
      eventApiId,
      eventId,
      guests,
      countsByStatus,
    });
  } catch (error) {
    return handleRouteError(error, "Failed to load guests from Luma");
  }
}
