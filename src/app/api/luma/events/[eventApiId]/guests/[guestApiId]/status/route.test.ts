import { NextRequest } from "next/server";

import { POST } from "@/app/api/luma/events/[eventApiId]/guests/[guestApiId]/status/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("POST /api/luma/events/[eventApiId]/guests/[guestApiId]/status", () => {
  beforeEach(() => {
    process.env.LUMA_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct payload for decline with refund", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 200));

    const request = new NextRequest(
      "http://localhost/api/luma/events/evt-api-1/guests/gst-1/status",
      {
        method: "POST",
        body: JSON.stringify({
          status: "declined",
          shouldRefund: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      },
    );

    const response = await POST(request, {
      params: {
        eventApiId: "evt-api-1",
        guestApiId: "gst-1",
      },
    });

    const body = (await response.json()) as {
      ok: boolean;
      data: { status: string };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("declined");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");

    const parsed = JSON.parse(String(init.body)) as {
      status: string;
      should_refund: boolean;
      event_api_id: string;
      guest: { type: string; api_id: string };
    };

    expect(parsed.status).toBe("declined");
    expect(parsed.should_refund).toBe(true);
    expect(parsed.event_api_id).toBe("evt-api-1");
    expect(parsed.guest.api_id).toBe("gst-1");
  });

  it("returns 400 for invalid request body", async () => {
    const request = new NextRequest(
      "http://localhost/api/luma/events/evt-api-1/guests/gst-1/status",
      {
        method: "POST",
        body: JSON.stringify({
          status: "pending_approval",
        }),
        headers: {
          "content-type": "application/json",
        },
      },
    );

    const response = await POST(request, {
      params: {
        eventApiId: "evt-api-1",
        guestApiId: "gst-1",
      },
    });

    expect(response.status).toBe(400);
  });
});
