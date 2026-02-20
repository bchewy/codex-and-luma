import { GET } from "@/app/api/luma/events/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("GET /api/luma/events", () => {
  beforeEach(() => {
    process.env.LUMA_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns hackathon-like events first and paginates", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              api_id: "evt-api-normal",
              event: {
                id: "evt-normal",
                name: "Monthly Meetup",
                start_at: "2026-03-10T10:00:00.000Z",
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
              api_id: "evt-api-hack",
              event: {
                id: "evt-hack",
                name: "OpenAI Codex Hackathon",
                start_at: "2026-03-15T10:00:00.000Z",
              },
            },
          ],
          next_cursor: null,
        }),
      );

    const response = await GET();
    const body = (await response.json()) as {
      ok: boolean;
      data: { events: Array<{ name: string; isHackathonLike: boolean }> };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.events).toHaveLength(2);
    expect(body.data.events[0].name).toBe("OpenAI Codex Hackathon");
    expect(body.data.events[0].isHackathonLike).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps Luma 429 errors to route error payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ message: "rate limited" }, 429),
    );

    const response = await GET();
    const body = (await response.json()) as {
      ok: boolean;
      error: { message: string; status: number };
    };

    expect(response.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain("rate limit");
  });
});
