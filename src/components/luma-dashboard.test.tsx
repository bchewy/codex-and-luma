/** @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import LumaDashboard from "@/components/luma-dashboard";
import {
  createEmptyStatusCounts,
  type ApiSuccess,
  type GuestReviewRecord,
  type LumaEventSummary,
  type LumaGuestsPayload,
} from "@/lib/luma/types";

function makeGuest(overrides: Partial<GuestReviewRecord>): GuestReviewRecord {
  const base: GuestReviewRecord = {
    apiId: "gst-1",
    guestId: "gst-1",
    eventId: "evt-1",
    eventApiId: "evt-api-1",
    name: "Ada",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    phoneNumber: null,
    createdAt: null,
    registeredAt: null,
    checkedInAt: null,
    approvalStatus: "pending_approval",
    customSource: null,
    qrCodeUrl: null,
    amount: null,
    amountTax: null,
    amountDiscount: null,
    currency: null,
    couponCode: null,
    ethAddress: null,
    solanaAddress: null,
    surveyResponseRating: null,
    surveyResponseFeedback: null,
    ticketTypeId: null,
    ticketName: null,
    registrationAnswers: [],
    normalizedAnswers: {
      affiliation: "Student",
      linkedin: null,
      github: null,
      twitterX: null,
      buildIdea: "Tooling",
      registrationAs: "Team of 2",
      teamName: "Team Spark",
      codexUsage: "Yes",
      additionalNotes: null,
      inPersonConfirmed: true,
      rawAnswerMap: {},
    },
    teamKey: "team spark",
    teamNameRaw: "Team Spark",
    isSoloRegistrant: false,
  };

  return {
    ...base,
    ...overrides,
    normalizedAnswers: {
      ...base.normalizedAnswers,
      ...overrides.normalizedAnswers,
    },
  };
}

function guestsPayload(
  eventApiId: string,
  eventId: string,
  guests: GuestReviewRecord[],
): ApiSuccess<LumaGuestsPayload> {
  const counts = createEmptyStatusCounts();

  for (const guest of guests) {
    counts[guest.approvalStatus] += 1;
    counts.total += 1;
  }

  return {
    ok: true,
    data: {
      eventApiId,
      eventId,
      guests,
      countsByStatus: counts,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("LumaDashboard", () => {
  const events: LumaEventSummary[] = [
    {
      eventApiId: "evt-api-1",
      eventId: "evt-1",
      name: "OpenAI Codex Hackathon",
      startAt: "2026-03-10T10:00:00.000Z",
      endAt: null,
      timezone: "Asia/Singapore",
      isHackathonLike: true,
    },
    {
      eventApiId: "evt-api-2",
      eventId: "evt-2",
      name: "Builders Meetup",
      startAt: "2026-04-10T10:00:00.000Z",
      endAt: null,
      timezone: "Asia/Singapore",
      isHackathonLike: false,
    },
  ];

  let store: Record<string, GuestReviewRecord[]>;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = {
      "evt-api-1": [
        makeGuest({
          apiId: "gst-1",
          guestId: "gst-1",
          name: "Ada",
          email: "ada@example.com",
          teamNameRaw: "Team Spark",
          teamKey: "team spark",
          normalizedAnswers: {
            teamName: "Team Spark",
          },
        }),
        makeGuest({
          apiId: "gst-2",
          guestId: "gst-2",
          name: "Grace",
          email: "grace@example.com",
          teamNameRaw: "team  spark",
          teamKey: "team spark",
          normalizedAnswers: {
            teamName: "team  spark",
          },
        }),
        makeGuest({
          apiId: "gst-3",
          guestId: "gst-3",
          name: "Solo Sam",
          email: "solo@example.com",
          teamNameRaw: null,
          teamKey: "solo:gst-3",
          isSoloRegistrant: true,
          normalizedAnswers: {
            registrationAs: "Solo",
            teamName: null,
          },
        }),
      ],
      "evt-api-2": [
        makeGuest({
          apiId: "gst-9",
          guestId: "gst-9",
          eventId: "evt-2",
          eventApiId: "evt-api-2",
          name: "Zoe",
          email: "zoe@example.com",
          teamNameRaw: null,
          teamKey: "solo:gst-9",
          isSoloRegistrant: true,
          normalizedAnswers: {
            registrationAs: "Solo",
            teamName: null,
          },
        }),
      ],
    };

    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input, "http://localhost")
          : new URL(input.url, "http://localhost");

      if (url.pathname === "/api/luma/events" && (!init || init.method === "GET")) {
        return jsonResponse({ ok: true, data: { events } });
      }

      const guestsMatch = url.pathname.match(/^\/api\/luma\/events\/([^/]+)\/guests$/);
      if (guestsMatch && (!init || init.method === "GET")) {
        const eventApiId = decodeURIComponent(guestsMatch[1]);
        const event = events.find((entry) => entry.eventApiId === eventApiId);
        const approvalStatus = url.searchParams.get("approvalStatus") || "all";
        const source = store[eventApiId] ?? [];

        const filtered =
          approvalStatus === "all"
            ? source
            : source.filter((guest) => guest.approvalStatus === approvalStatus);

        return jsonResponse(guestsPayload(eventApiId, event?.eventId ?? "evt-unknown", filtered));
      }

      const statusMatch = url.pathname.match(
        /^\/api\/luma\/events\/([^/]+)\/guests\/([^/]+)\/status$/,
      );

      if (statusMatch && init?.method === "POST") {
        const eventApiId = decodeURIComponent(statusMatch[1]);
        const guestApiId = decodeURIComponent(statusMatch[2]);
        const body = JSON.parse(String(init.body)) as { status: "approved" | "declined" };

        store[eventApiId] = (store[eventApiId] ?? []).map((guest) => {
          if (guest.apiId !== guestApiId) {
            return guest;
          }

          return {
            ...guest,
            approvalStatus: body.status,
          };
        });

        return jsonResponse({ ok: true, data: { guestApiId, status: body.status } });
      }

      return jsonResponse({ ok: false, error: { message: "not found" } }, 404);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows team variant warning and supports team bulk approve", async () => {
    const user = userEvent.setup();
    render(<LumaDashboard />);

    await screen.findByRole("button", { name: /Teams \(/i });
    expect(await screen.findByText(/Name variants:/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Approve team/i }));
    expect(
      await screen.findByRole("heading", { name: /^Approve team$/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Approve$/i }));

    await waitFor(() => {
      const statusCalls = fetchMock.mock.calls.filter((call) => {
        const input = call[0] as RequestInfo | URL;
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        return url.includes("/status");
      });

      expect(statusCalls).toHaveLength(2);
    });
  });

  it("opens decline flow with refund option in people view", async () => {
    const user = userEvent.setup();
    render(<LumaDashboard />);

    await screen.findByRole("button", { name: /People \(/i });

    await user.click(screen.getByRole("button", { name: /People \(/i }));
    await user.click(screen.getAllByRole("button", { name: /Decline/i })[0]);

    expect(await screen.findByText(/Send refund if this guest has paid/i)).toBeInTheDocument();
  });

  it("switches events and clears stale detail selection", async () => {
    const user = userEvent.setup();
    render(<LumaDashboard />);

    await screen.findByRole("button", { name: /People \(/i });
    await user.click(screen.getByLabelText(/Show all events/i));

    await user.click(screen.getByRole("button", { name: /People \(/i }));
    await user.click(await screen.findByText("Ada"));
    expect(await screen.findByText(/^Attendee$/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /Event/i }), "evt-api-2");

    await screen.findByText("Zoe");

    await waitFor(() => {
      expect(screen.queryByText(/^Attendee$/i)).not.toBeInTheDocument();
    });
  });
});
