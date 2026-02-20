import { handleRouteError, successResponse } from "@/lib/api/responses";
import { lumaFetchJson } from "@/lib/luma/client";
import type {
  LumaEventEntryRaw,
  LumaEventSummary,
  LumaPaginatedResponse,
} from "@/lib/luma/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asEventSummary(entry: LumaEventEntryRaw): LumaEventSummary | null {
  const event = asRecord(entry.event);
  const eventApiId = asString(entry.api_id);
  const eventId = asString(event?.id);

  if (!eventApiId || !eventId) {
    return null;
  }

  const name = asString(event?.name) ?? "Untitled Event";

  return {
    eventApiId,
    eventId,
    name,
    startAt: asString(event?.start_at),
    endAt: asString(event?.end_at),
    timezone: asString(event?.timezone),
    isHackathonLike: /hackathon/i.test(name),
  };
}

function compareEvents(a: LumaEventSummary, b: LumaEventSummary): number {
  if (a.isHackathonLike !== b.isHackathonLike) {
    return a.isHackathonLike ? -1 : 1;
  }

  const startA = a.startAt ? Date.parse(a.startAt) : Number.POSITIVE_INFINITY;
  const startB = b.startAt ? Date.parse(b.startAt) : Number.POSITIVE_INFINITY;

  if (startA !== startB) {
    return startA - startB;
  }

  return a.name.localeCompare(b.name);
}

export async function GET() {
  try {
    let cursor: string | null | undefined;
    const entries: LumaEventEntryRaw[] = [];
    let page = 0;

    do {
      const payload = await lumaFetchJson<LumaPaginatedResponse<LumaEventEntryRaw>>(
        "/v1/calendar/list-events",
        {
          query: {
            pagination_limit: 200,
            pagination_cursor: cursor,
            sort_column: "start_at",
            sort_direction: "asc",
          },
        },
      );

      entries.push(...(payload.entries ?? []));
      cursor = payload.next_cursor;
      page += 1;
    } while (cursor && page < 30);

    const events = entries
      .map((entry) => asEventSummary(entry))
      .filter((entry): entry is LumaEventSummary => Boolean(entry))
      .sort(compareEvents);

    return successResponse({ events });
  } catch (error) {
    return handleRouteError(error, "Failed to load events from Luma");
  }
}
