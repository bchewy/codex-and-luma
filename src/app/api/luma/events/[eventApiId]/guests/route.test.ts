import { NextRequest } from "next/server";

import { GET } from "@/app/api/luma/events/[eventApiId]/guests/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("GET /api/luma/events/[eventApiId]/guests", () => {
  beforeEach(() => {
    process.env.LUMA_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns paginated guests and derived status counts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              api_id: "gst-1",
              guest: {
                id: "gst-1",
                user_name: "Ada",
                user_email: "ada@example.com",
                approval_status: "pending_approval",
                registration_answers: [
                  {
                    label: "Are you registering as:",
                    answer: "Team of 2",
                  },
                  {
                    label: "Team Name (optional — must match exactly for all team members)",
                    answer: "Rocket",
                  },
                ],
              },
            },
          ],
          next_cursor: "cursor-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              api_id: "gst-2",
              guest: {
                id: "gst-2",
                user_name: "Ben",
                user_email: "ben@example.com",
                approval_status: "approved",
                registration_answers: [
                  {
                    label: "Are you registering as:",
                    answer: "Solo",
                  },
                ],
              },
            },
          ],
          next_cursor: null,
        }),
      );

    const request = new NextRequest(
      "http://localhost/api/luma/events/evt-api-1/guests?eventId=evt-1&approvalStatus=pending_approval",
    );

    const response = await GET(request, {
      params: { eventApiId: "evt-api-1" },
    });

    const body = (await response.json()) as {
      ok: boolean;
      data: {
        guests: Array<{ apiId: string; teamKey: string }>;
        countsByStatus: { pending_approval: number; approved: number; total: number };
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.guests).toHaveLength(2);
    expect(body.data.guests[0].teamKey).toBe("rocket");
    expect(body.data.countsByStatus.pending_approval).toBe(1);
    expect(body.data.countsByStatus.approved).toBe(1);
    expect(body.data.countsByStatus.total).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("validates required eventId", async () => {
    const request = new NextRequest("http://localhost/api/luma/events/evt-api-1/guests");

    const response = await GET(request, {
      params: { eventApiId: "evt-api-1" },
    });

    expect(response.status).toBe(400);
  });
});
